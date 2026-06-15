const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const TURN_TIMEOUT = 30000; // 30초

// ── MongoDB 연결 ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/omok')
  .then(() => console.log('MongoDB 연결 성공'))
  .catch(err => console.error('MongoDB 연결 실패:', err));

const recordSchema = new mongoose.Schema({
  nickname: { type: String, required: true, unique: true },
  win:   { type: Number, default: 0 },
  lose:  { type: Number, default: 0 },
  draw:  { type: Number, default: 0 },
  points: { type: Number, default: 0 },
});
const Record = mongoose.model('Record', recordSchema);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 상태 관리 ──────────────────────────────────────────────────
const rooms = new Map();
const matchQueues = { timer: [], noTimer: [] };

function createBoard() {
  return Array.from({ length: 15 }, () => new Array(15).fill(0));
}

async function getRecord(nickname) {
  try {
    let rec = await Record.findOne({ nickname });
    if (!rec) rec = await Record.create({ nickname, win: 0, lose: 0, draw: 0, points: 0 });
    return { win: rec.win, lose: rec.lose, draw: rec.draw, points: rec.points || 0 };
  } catch (err) {
    console.error('getRecord error (DB unavailable?):', err.message);
    return { win: 0, lose: 0, draw: 0, points: 0 };
  }
}

async function addWin(nickname) {
  try { await Record.findOneAndUpdate({ nickname }, { $inc: { win: 1, points: 20 } }, { upsert: true }); }
  catch (err) { console.error('addWin error:', err.message); }
}
async function addLose(nickname) {
  try {
    await Record.findOneAndUpdate(
      { nickname },
      [{ $set: {
        lose:   { $add: [{ $ifNull: ['$lose', 0] }, 1] },
        points: { $max: [0, { $subtract: [{ $ifNull: ['$points', 0] }, 10] }] }
      }}],
      { upsert: true }
    );
  } catch (err) { console.error('addLose error:', err.message); }
}
async function addDraw(nickname) {
  try { await Record.findOneAndUpdate({ nickname }, { $inc: { draw: 1, points: 5 } }, { upsert: true }); }
  catch (err) { console.error('addDraw error:', err.message); }
}

function checkWin(board, row, col, player) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let d = 1; d < 5; d++) {
      const r = row + dr*d, c = col + dc*d;
      if (r<0||r>=15||c<0||c>=15||board[r][c]!==player) break;
      count++;
    }
    for (let d = 1; d < 5; d++) {
      const r = row - dr*d, c = col - dc*d;
      if (r<0||r>=15||c<0||c>=15||board[r][c]!==player) break;
      count++;
    }
    if (count >= 5) return true;
  }
  return false;
}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function checkExactFive(board, row, col, player) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let d = 1; d < 5; d++) {
      const r = row + dr*d, c = col + dc*d;
      if (r<0||r>=15||c<0||c>=15||board[r][c]!==player) break;
      count++;
    }
    for (let d = 1; d < 5; d++) {
      const r = row - dr*d, c = col - dc*d;
      if (r<0||r>=15||c<0||c>=15||board[r][c]!==player) break;
      count++;
    }
    if (count === 5) return true;
  }
  return false;
}

function isOverline(board, row, col) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let d = 1; d <= 5; d++) {
      const r = row + dr*d, c = col + dc*d;
      if (r<0||r>=15||c<0||c>=15||board[r][c]!==1) break;
      count++;
    }
    for (let d = 1; d <= 5; d++) {
      const r = row - dr*d, c = col - dc*d;
      if (r<0||r>=15||c<0||c>=15||board[r][c]!==1) break;
      count++;
    }
    if (count >= 6) return true;
  }
  return false;
}

function countOpenThrees(board, row, col) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  let count = 0;
  for (const [dr, dc] of dirs) {
    const get = (i) => {
      const r = row + dr*i, c = col + dc*i;
      if (r<0||r>=15||c<0||c>=15) return -1;
      return board[r][c];
    };
    let fwd = 0, bwd = 0;
    for (let d = 1; d <= 4; d++) { if (get(d) === 1) fwd++; else break; }
    for (let d = 1; d <= 4; d++) { if (get(-d) === 1) bwd++; else break; }
    const total = fwd + bwd + 1;
    if (total === 3 && get(fwd + 1) === 0 && get(-bwd - 1) === 0) count++;
  }
  return count;
}

function isDoublethree(board, row, col) {
  return countOpenThrees(board, row, col) >= 2;
}

function countFours(board, row, col) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  let count = 0;
  for (const [dr, dc] of dirs) {
    const get = (i) => {
      const r = row + dr*i, c = col + dc*i;
      if (r<0||r>=15||c<0||c>=15) return -1;
      return board[r][c];
    };
    let fwd = 0, bwd = 0;
    for (let d = 1; d <= 4; d++) { if (get(d) === 1) fwd++; else break; }
    for (let d = 1; d <= 4; d++) { if (get(-d) === 1) bwd++; else break; }
    const total = fwd + bwd + 1;
    if (total === 4) {
      // 양끝 중 하나라도 비어있으면 사(四)
      if (get(fwd + 1) === 0 || get(-bwd - 1) === 0) count++;
    }
  }
  return count;
}

function isDoublefour(board, row, col) {
  return countFours(board, row, col) >= 2;
}

// ── 타이머 ────────────────────────────────────────────────────
function startTurnTimer(room) {
  if (!room.useTimer) return;
  clearTurnTimer(room);
  room.turnTimer = setTimeout(async () => {
    if (room.status !== 'playing') return;
    const loser = room.players.find(p => p.color === room.turn);
    const winner = room.players.find(p => p.color !== room.turn);
    if (!loser) return;
    clearTurnTimer(room);
    room.status = 'finished';
    await addLose(loser.nickname);
    if (winner) await addWin(winner.nickname);
    const records = await Promise.all(room.players.map(async p => ({
      nickname: p.nickname, record: await getRecord(p.nickname)
    })));
    io.to(room.id).emit('game_over', {
      result: 'timeout', winner: winner ? winner.nickname : null,
      loser: loser.nickname, records,
    });
  }, TURN_TIMEOUT);
  io.to(room.id).emit('timer_start', { seconds: TURN_TIMEOUT / 1000, turn: room.turn });
}

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

// ── 게임 시작 ─────────────────────────────────────────────────
async function emitGameStart(room) {
  const playerData = await Promise.all(room.players.map(async p => ({
    nickname: p.nickname,
    color: p.color,
    record: await getRecord(p.nickname),
    stoneStyle: p.stoneStyle || 'classic'
  })));
  room.players.forEach(p => {
    io.to(p.socketId).emit('game_start', {
      roomId: room.id, board: room.board,
      players: playerData, turn: room.turn, yourColor: p.color,
      useTimer: room.useTimer !== false,
    });
  });
  startTurnTimer(room);
  broadcastRoomList();
}

function broadcastRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.status === 'playing') {
      list.push({
        roomId: room.id,
        players: room.players.map(p => p.nickname),
        spectatorCount: room.spectators.length,
        useTimer: room.useTimer !== false,
      });
    }
  }
  io.emit('room_list', list);
}

function createRoom(roomId, isPublic = false, useTimer = true) {
  const room = {
    id: roomId,
    players: [],
    board: createBoard(),
    turn: 1,
    status: 'waiting',
    moveCount: 0,
    isPublic,
    useTimer,
    isPaused: false,
    chat: [],
    spectators: [],
    moveHistory: [],
    pendingUndo: null,
    pendingSurrender: null,
    turnTimer: null,
    rematchRequests: null,
  };
  rooms.set(roomId, room);
  return room;
}

// ── 매칭 큐 처리 ──────────────────────────────────────────────
function tryMatch(queueKey) {
  const q = matchQueues[queueKey];
  while (q.length >= 2) {
    const p1 = q.shift();
    const p2 = q.shift();
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (!s1 || !s2) {
      if (s1) q.unshift(p1);
      if (s2) q.unshift(p2);
      continue;
    }
    const roomId = generateRoomId();
    const room = createRoom(roomId, false, queueKey === 'timer');
    room.players.push({ socketId: p1.socketId, nickname: p1.nickname, color: 1, stoneStyle: p1.stoneStyle || 'classic' });
    room.players.push({ socketId: p2.socketId, nickname: p2.nickname, color: 2, stoneStyle: p2.stoneStyle || 'classic' });
    room.status = 'playing';
    s1.join(roomId); s2.join(roomId);
    emitGameStart(room);
    console.log(`매칭 완료: ${p1.nickname} vs ${p2.nickname} [${roomId}] [타이머:${queueKey}]`);
  }
}

// ── 소켓 이벤트 ───────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('접속:', socket.id);

  socket.on('request_record', async ({ nickname }) => {
    if (!nickname) return;
    const rec = await getRecord(nickname);
    socket.emit('your_record', rec);
  });

  socket.on('get_room_list', () => {
    const list = [];
    for (const room of rooms.values()) {
      if (room.status === 'playing') {
        list.push({
          roomId: room.id,
          players: room.players.map(p => p.nickname),
          spectatorCount: room.spectators.length,
          useTimer: room.useTimer !== false,
        });
      }
    }
    socket.emit('room_list', list);
  });

  socket.on('join_random', ({ nickname, stoneStyle, useTimer }) => {
    for (const q of Object.values(matchQueues)) {
      if (q.findIndex(p => p.socketId === socket.id) !== -1) return;
    }
    const qKey = useTimer === false ? 'noTimer' : 'timer';
    matchQueues[qKey].push({ socketId: socket.id, nickname, stoneStyle: stoneStyle || 'classic' });
    socket.emit('queue_joined', { position: matchQueues[qKey].length });
    console.log(`매칭 대기: ${nickname} (대기열: ${matchQueues[qKey].length}명) [타이머:${qKey}]`);
    tryMatch(qKey);
  });

  socket.on('cancel_random', () => {
    for (const q of Object.values(matchQueues)) {
      const idx = q.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) { q.splice(idx, 1); break; }
    }
    socket.emit('queue_cancelled');
  });

  socket.on('create_room', ({ nickname, stoneStyle, useTimer }) => {
    const roomId = generateRoomId();
    const room = createRoom(roomId, false, useTimer !== false);
    room.players.push({ socketId: socket.id, nickname, color: 1, stoneStyle: stoneStyle || 'classic' });
    socket.join(roomId);
    socket.emit('room_created', { roomId, color: 1 });
  });

  socket.on('join_room', async ({ roomId, nickname, stoneStyle }) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) { socket.emit('error', { msg: '존재하지 않는 방입니다.' }); return; }
    if (room.status === 'playing' && !room.players.find(p => p.socketId === socket.id)) {
      room.spectators.push(socket.id);
      socket.join(roomId);
      const players = await Promise.all(room.players.map(async p => ({
        nickname: p.nickname, color: p.color,
        record: await getRecord(p.nickname), stoneStyle: p.stoneStyle || 'classic'
      })));
      socket.emit('spectate_start', {
        roomId, board: room.board, players, turn: room.turn,
        useTimer: room.useTimer !== false,
        isPaused: room.isPaused,
        spectatorCount: room.spectators.length,
      });
      io.to(roomId).emit('spectator_update', { count: room.spectators.length });
      broadcastRoomList();
      return;
    }
    if (room.players.length >= 2) { socket.emit('error', { msg: '방이 꽉 찼습니다.' }); return; }
    room.players.push({ socketId: socket.id, nickname, color: 2, stoneStyle: stoneStyle || 'classic' });
    socket.join(roomId);
    if (room.players.length === 2) {
      room.status = 'playing';
      emitGameStart(room);
    } else {
      socket.emit('room_joined', { roomId, color: 2 });
    }
  });

  // 돌 놓기
  socket.on('place_stone', async ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    if (room.isPaused) { socket.emit('error', { msg: '게임이 일시정지 중입니다.' }); return; }
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    if (player.color !== room.turn) { socket.emit('error', { msg: '당신의 차례가 아닙니다.' }); return; }
    if (room.board[row][col] !== 0) { socket.emit('error', { msg: '이미 돌이 놓인 자리입니다.' }); return; }

    if (player.color === 1) {
      room.board[row][col] = 1;
      const exactFive = checkExactFive(room.board, row, col, 1);
      if (!exactFive) {
        if (isOverline(room.board, row, col)) {
          room.board[row][col] = 0;
          socket.emit('forbidden', { type: 'overline', msg: '육목 금수!' });
          return;
        }
        if (isDoublethree(room.board, row, col)) {
          room.board[row][col] = 0;
          socket.emit('forbidden', { type: 'doublethree', msg: '쌍삼 금수!' });
          return;
        }
        if (isDoublefour(room.board, row, col)) {
          room.board[row][col] = 0;
          socket.emit('forbidden', { type: 'doublefour', msg: '쌍사 금수!' });
          return;
        }
      }
      room.board[row][col] = 0;
    }

    clearTurnTimer(room);
    room.board[row][col] = player.color;
    room.moveHistory.push({ row, col, color: player.color });
    room.moveCount++;
    room.pendingUndo = null;

    const isWin = checkWin(room.board, row, col, player.color);
    const isDraw = room.moveCount >= 225;

    io.to(roomId).emit('stone_placed', {
      row, col, color: player.color, turn: room.turn, moveCount: room.moveCount,
    });

    if (isWin) {
      room.status = 'finished';
      const winner = player;
      const loser = room.players.find(p => p.socketId !== socket.id);
      await addWin(winner.nickname);
      if (loser) await addLose(loser.nickname);
      const records = await Promise.all(room.players.map(async p => ({
        nickname: p.nickname, record: await getRecord(p.nickname)
      })));
      io.to(roomId).emit('game_over', { result: 'win', winner: winner.nickname, records });
      broadcastRoomList();
    } else if (isDraw) {
      room.status = 'finished';
      await Promise.all(room.players.map(p => addDraw(p.nickname)));
      const records = await Promise.all(room.players.map(async p => ({
        nickname: p.nickname, record: await getRecord(p.nickname)
      })));
      io.to(roomId).emit('game_over', { result: 'draw', records });
      broadcastRoomList();
    } else {
      room.turn = room.turn === 1 ? 2 : 1;
      io.to(roomId).emit('turn_changed', { turn: room.turn });
      startTurnTimer(room);
    }
  });

  // ── 무르기 ────────────────────────────────────────────────────
  socket.on('undo_request', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    const requester = room.players.find(p => p.socketId === socket.id);
    if (!requester) return;
    if (room.moveHistory.length < 1) {
      socket.emit('undo_result', { ok: false, reason: '무를 수 있는 돌이 없습니다.' }); return;
    }
    if (room.pendingUndo) {
      socket.emit('undo_result', { ok: false, reason: '이미 요청 중입니다.' }); return;
    }
    room.pendingUndo = { requesterSocketId: socket.id };
    const opponent = room.players.find(p => p.socketId !== socket.id);
    if (opponent) io.to(opponent.socketId).emit('undo_requested', { from: requester.nickname });
    // 15초 후 자동 거절
    setTimeout(() => {
      if (room.pendingUndo && room.pendingUndo.requesterSocketId === socket.id) {
        room.pendingUndo = null;
        socket.emit('undo_result', { ok: false, reason: '상대방이 응답하지 않았습니다.' });
      }
    }, 15000);
  });

  socket.on('undo_response', ({ roomId, accept }) => {
    const room = rooms.get(roomId);
    if (!room || !room.pendingUndo) return;
    const { requesterSocketId } = room.pendingUndo;
    const requester = room.players.find(p => p.socketId === requesterSocketId);
    room.pendingUndo = null;

    if (accept && requester) {
      clearTurnTimer(room);
      const undoCount = Math.min(2, room.moveHistory.length);
      for (let i = 0; i < undoCount; i++) {
        const mv = room.moveHistory.pop();
        if (mv) { room.board[mv.row][mv.col] = 0; room.moveCount--; }
      }
      room.turn = requester.color;
      io.to(roomId).emit('undo_accepted', { board: room.board, turn: room.turn, moveCount: room.moveCount });
      startTurnTimer(room);
    } else {
      if (requester) io.to(requester.socketId).emit('undo_result', { ok: false, reason: '상대방이 거절했습니다.' });
      io.to(roomId).emit('consent_notify', { type: 'undo', accepted: false });
    }
  });

  // ── 항복 ─────────────────────────────────────────────────────
  socket.on('surrender_request', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    const requester = room.players.find(p => p.socketId === socket.id);
    if (!requester) return;
    if (room.pendingSurrender) {
      socket.emit('surrender_result', { ok: false, reason: '이미 요청 중입니다.' }); return;
    }
    room.pendingSurrender = { requesterSocketId: socket.id };
    const opponent = room.players.find(p => p.socketId !== socket.id);
    if (opponent) io.to(opponent.socketId).emit('surrender_requested', { from: requester.nickname });
    setTimeout(() => {
      if (room.pendingSurrender && room.pendingSurrender.requesterSocketId === socket.id) {
        room.pendingSurrender = null;
        socket.emit('surrender_result', { ok: false, reason: '상대방이 응답하지 않았습니다.' });
      }
    }, 15000);
  });

  socket.on('surrender_response', async ({ roomId, accept }) => {
    const room = rooms.get(roomId);
    if (!room || !room.pendingSurrender) return;
    const { requesterSocketId } = room.pendingSurrender;
    const loser = room.players.find(p => p.socketId === requesterSocketId);
    const winner = room.players.find(p => p.socketId !== requesterSocketId);
    room.pendingSurrender = null;

    if (accept && loser) {
      clearTurnTimer(room);
      room.status = 'finished';
      await addLose(loser.nickname);
      if (winner) await addWin(winner.nickname);
      const records = await Promise.all(room.players.map(async p => ({
        nickname: p.nickname, record: await getRecord(p.nickname)
      })));
      io.to(roomId).emit('game_over', {
        result: 'resign', winner: winner ? winner.nickname : null,
        loser: loser.nickname, records,
      });
      broadcastRoomList();
    } else {
      if (loser) io.to(loser.socketId).emit('surrender_result', { ok: false, reason: '상대방이 거절했습니다.' });
      io.to(roomId).emit('consent_notify', { type: 'surrender', accepted: false });
    }
  });

  // ── 재대결 ────────────────────────────────────────────────────
  socket.on('rematch_request', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    if (!room.rematchRequests) room.rematchRequests = new Set();
    room.rematchRequests.add(socket.id);
    room.players.forEach(p => {
      if (p.socketId !== socket.id)
        io.to(p.socketId).emit('rematch_requested', { from: player.nickname });
    });
    if (room.rematchRequests.size === 2) {
      clearTurnTimer(room);
      room.board = createBoard(); room.turn = 1; room.status = 'playing';
      room.moveCount = 0; room.moveHistory = [];
      room.pendingUndo = null; room.pendingSurrender = null;
      room.isPaused = false;
      room.rematchRequests = new Set();
      room.players.forEach(p => { p.color = p.color === 1 ? 2 : 1; });
      emitGameStart(room);
    }
  });

  // ── 일시정지 ──────────────────────────────────────────────────
  socket.on('pause_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || room.isPaused) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    room.isPaused = true;
    clearTurnTimer(room);
    io.to(roomId).emit('game_paused', { by: player.nickname });
    console.log(`일시정지: ${player.nickname} [${roomId}]`);
  });

  socket.on('resume_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || !room.isPaused) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    room.isPaused = false;
    io.to(roomId).emit('game_resumed', { by: player.nickname });
    startTurnTimer(room);
    console.log(`재개: ${player.nickname} [${roomId}]`);
  });

  // ── 기권 ─────────────────────────────────────────────────────
  socket.on('resign', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    const loser = room.players.find(p => p.socketId === socket.id);
    const winner = room.players.find(p => p.socketId !== socket.id);
    if (!loser) return;
    clearTurnTimer(room);
    room.status = 'finished';
    await addLose(loser.nickname);
    if (winner) await addWin(winner.nickname);
    const records = await Promise.all(room.players.map(async p => ({
      nickname: p.nickname, record: await getRecord(p.nickname)
    })));
    io.to(roomId).emit('game_over', {
      result: 'resign', winner: winner ? winner.nickname : null,
      loser: loser.nickname, records,
    });
    broadcastRoomList();
  });

  // ── 채팅 ─────────────────────────────────────────────────────
  socket.on('chat', ({ roomId, nickname, message }) => {
    if (!message || message.trim().length === 0) return;
    io.to(roomId).emit('chat', { nickname, message: message.trim().substring(0, 200), time: Date.now() });
  });

  // ── 연결 해제 ─────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('해제:', socket.id);
    for (const q of Object.values(matchQueues)) {
      const qi = q.findIndex(p => p.socketId === socket.id);
      if (qi !== -1) { q.splice(qi, 1); break; }
    }

    for (const [roomId, room] of rooms.entries()) {
      const specIdx = room.spectators.indexOf(socket.id);
      if (specIdx !== -1) {
        room.spectators.splice(specIdx, 1);
        io.to(roomId).emit('spectator_update', { count: room.spectators.length });
        broadcastRoomList();
        break;
      }
    }

    for (const [roomId, room] of rooms.entries()) {
      const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
      if (playerIdx !== -1 && room.status === 'playing') {
        const loser = room.players[playerIdx];
        const winner = room.players.find(p => p.socketId !== socket.id);
        clearTurnTimer(room);
        room.status = 'finished';
        (async () => {
          await addLose(loser.nickname);
          if (winner) await addWin(winner.nickname);
          const records = await Promise.all(room.players.map(async p => ({
            nickname: p.nickname, record: await getRecord(p.nickname)
          })));
          io.to(roomId).emit('game_over', {
            result: 'disconnect', winner: winner ? winner.nickname : null,
            loser: loser.nickname, records,
          });
          broadcastRoomList();
        })();
        setTimeout(() => { if (rooms.has(roomId)) rooms.delete(roomId); }, 30000);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`오목 서버 실행 중: http://localhost:${PORT}`);
});
