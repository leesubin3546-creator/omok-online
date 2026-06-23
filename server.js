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

function getGrade(points) {
  if (points >= 1000) return '9단';
  if (points >= 800)  return '8단';
  if (points >= 600)  return '7단';
  if (points >= 450)  return '6단';
  if (points >= 320)  return '5단';
  if (points >= 210)  return '4단';
  if (points >= 120)  return '3단';
  if (points >= 50)   return '2단';
  if (points >= 10)   return '1단';
  return '입문';
}

async function getRecord(nickname) {
  try {
    let rec = await Record.findOne({ nickname });
    if (!rec) rec = await Record.create({ nickname, win: 0, lose: 0, draw: 0, points: 0 });
    return { win: rec.win, lose: rec.lose, draw: rec.draw, points: rec.points || 0, grade: getGrade(rec.points || 0) };
  } catch (err) {
    console.error('getRecord error:', err.message);
    return { win: 0, lose: 0, draw: 0, points: 0, grade: '입문' };
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

// ── 오델로 로직 ───────────────────────────────────────────────
function createOthelloBoard() {
  const board = Array.from({ length: 8 }, () => new Array(8).fill(0));
  board[3][3] = 2; board[3][4] = 1;
  board[4][3] = 1; board[4][4] = 2;
  return board;
}

const OTHELLO_DIRS = [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];

function getOthelloFlips(board, row, col, player) {
  const opp = player === 1 ? 2 : 1;
  const flips = [];
  for (const [dr, dc] of OTHELLO_DIRS) {
    const line = [];
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === opp) {
      line.push([r, c]);
      r += dr; c += dc;
    }
    if (line.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === player) {
      flips.push(...line);
    }
  }
  return flips;
}

function getOthelloValidMoves(board, player) {
  const moves = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] === 0 && getOthelloFlips(board, r, c, player).length > 0)
        moves.push([r, c]);
  return moves;
}

function countOthelloPieces(board) {
  let black = 0, white = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === 1) black++;
      else if (board[r][c] === 2) white++;
    }
  return { black, white };
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

// 단순 열린삼 카운트 (조건부 쌍삼 체크 내부에서 재귀 방지용으로 사용)
function countOpenThreesSimple(board, row, col) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  let count = 0;
  for (const [dr, dc] of dirs) {
    const get = (i) => {
      const r = row + dr*i, c = col + dc*i;
      if (r<0||r>=15||c<0||c>=15) return -1;
      return board[r][c];
    };
    let found = false;
    for (let s = -4; s <= 0 && !found; s++) {
      let blacks = 0, empties = 0, valid = true;
      for (let i = s; i <= s + 4; i++) {
        const v = get(i);
        if (v === -1 || v === 2) { valid = false; break; }
        if (v === 1) blacks++;
        else empties++;
      }
      if (!valid || blacks !== 3 || empties !== 2) continue;
      if (get(s - 1) === 0 && get(s + 5) === 0) found = true;
    }
    if (found) count++;
  }
  return count;
}

function countOpenThrees(board, row, col) {
  // 공식 렌주룰 조건부 삼: 5칸 윈도우(흑3+빈2+양끝열림)에서
  // 빈 자리 중 하나를 채웠을 때 ① 흑 4개가 연속이고(→직선 4 형성)
  // ② 그 연장 자리가 금수가 아닐 때만 진삼으로 카운트.
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  let count = 0;
  for (const [dr, dc] of dirs) {
    const get = (i) => {
      const r = row + dr*i, c = col + dc*i;
      if (r<0||r>=15||c<0||c>=15) return -1;
      return board[r][c];
    };
    let found = false;
    for (let s = -4; s <= 0 && !found; s++) {
      let blacks = 0, valid = true;
      const emptyPos = [];
      for (let i = s; i <= s + 4; i++) {
        const v = get(i);
        if (v === -1 || v === 2) { valid = false; break; }
        if (v === 1) blacks++;
        else emptyPos.push(i);
      }
      if (!valid || blacks !== 3 || emptyPos.length !== 2) continue;
      if (get(s - 1) !== 0 || get(s + 5) !== 0) continue;

      for (const ep of emptyPos) {
        // 채운 후 4흑이 연속인지 확인
        const bpos = [];
        for (let i = s; i <= s + 4; i++) {
          if ((i === ep) || get(i) === 1) bpos.push(i);
        }
        if (bpos.length !== 4) continue;
        if (Math.max(...bpos) - Math.min(...bpos) !== 3) continue; // 비연속

        // 연장 자리가 금수인지 확인 (단순 룰 사용, 재귀 방지)
        const er = row + dr * ep, ec = col + dc * ep;
        if (er < 0 || er >= 15 || ec < 0 || ec >= 15) continue;
        board[er][ec] = 1;
        const ext5 = checkExactFive(board, er, ec, 1);
        let extForbidden = false;
        if (!ext5) {
          extForbidden = isOverline(board, er, ec) ||
                         countFours(board, er, ec) >= 2 ||
                         countOpenThreesSimple(board, er, ec) >= 2;
        }
        board[er][ec] = 0;
        if (!extForbidden) { found = true; break; }
      }
    }
    if (found) count++;
  }
  return count;
}

function isDoublethree(board, row, col) {
  return countOpenThrees(board, row, col) >= 2;
}

function countFours(board, row, col) {
  // 공식 렌주룰: 5칸 슬라이딩 윈도우 흑4+빈1 → 방향당 사 1개.
  // 열린 4(_XXXX_)도 사 1개 (표준 렌주룰).
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  let count = 0;
  for (const [dr, dc] of dirs) {
    const get = (i) => {
      const r = row + dr*i, c = col + dc*i;
      if (r<0||r>=15||c<0||c>=15) return -1;
      return board[r][c];
    };
    let found = false;
    for (let s = -4; s <= 0 && !found; s++) {
      let blacks = 0, empties = 0, valid = true;
      for (let i = s; i <= s + 4; i++) {
        const v = get(i);
        if (v === -1 || v === 2) { valid = false; break; }
        if (v === 1) blacks++;
        else empties++;
      }
      if (!valid || blacks !== 4 || empties !== 1) continue;
      found = true;
    }
    if (found) count++;
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
      gameType: room.gameType || 'gomoku',
    });
  });
  // 대기실 관전자에게도 game_start 전달 (관전 상태로)
  room.spectators.forEach(spec => {
    io.to(spec.socketId).emit('spectate_start', {
      roomId: room.id, board: room.board, players: playerData,
      turn: room.turn, useTimer: room.useTimer !== false, isPaused: false,
      spectatorCount: room.spectators.length,
      gameType: room.gameType || 'gomoku',
    });
  });
  startTurnTimer(room);
  broadcastRoomList();
}

// ── 방 목록 브로드캐스트 ──────────────────────────────────────
function broadcastRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.status === 'waiting' || room.status === 'playing') {
      list.push({
        roomId: room.id,
        name: room.name,
        hasPassword: !!room.password,
        status: room.status,
        playerCount: room.players.length,
        players: room.players.map(p => p.nickname),
        spectatorCount: room.spectators.length,
        useTimer: room.useTimer !== false,
        gameType: room.gameType || 'gomoku',
      });
    }
  }
  io.emit('room_list', list);
}

// ── 대기실 상태 브로드캐스트 ──────────────────────────────────
async function broadcastLobbyState(room) {
  const playerData = await Promise.all(room.players.map(async p => ({
    nickname: p.nickname,
    color: p.color,
    isHost: p.socketId === room.hostSocketId,
    isReady: room.readySet.has(p.socketId),
    record: await getRecord(p.nickname),
    stoneStyle: p.stoneStyle || 'classic',
  })));
  const spectatorData = room.spectators.map(s => ({ nickname: s.nickname }));
  io.to(room.id).emit('lobby_state', {
    roomId: room.id,
    name: room.name,
    useTimer: room.useTimer,
    players: playerData,
    spectators: spectatorData,
    hostSocketId: room.hostSocketId,
    gameType: room.gameType || 'gomoku',
  });
}

function createRoom(roomId, options = {}) {
  const gameType = options.gameType || 'gomoku';
  const room = {
    id: roomId,
    name: options.name || `방 ${roomId}`,
    password: options.password || null,
    hostSocketId: options.hostSocketId || null,
    gameType,
    players: [],
    readySet: new Set(),
    board: gameType === 'othello' ? createOthelloBoard() : createBoard(),
    turn: 1,
    status: 'waiting',
    moveCount: 0,
    useTimer: options.useTimer !== false,
    isPaused: false,
    chat: [],
    spectators: [],   // { socketId, nickname } — 대기실+게임 관전 통합
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
    const room = createRoom(roomId, { useTimer: queueKey === 'timer', name: '빠른 매칭', hostSocketId: p1.socketId });
    room.players.push({ socketId: p1.socketId, nickname: p1.nickname, color: 1, stoneStyle: p1.stoneStyle || 'classic' });
    room.players.push({ socketId: p2.socketId, nickname: p2.nickname, color: 2, stoneStyle: p2.stoneStyle || 'classic' });
    room.status = 'playing';
    s1.join(roomId); s2.join(roomId);
    emitGameStart(room);
    console.log(`매칭 완료: ${p1.nickname} vs ${p2.nickname} [${roomId}]`);
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

  // ── 방 목록 요청 ─────────────────────────────────────────────
  socket.on('get_room_list', () => {
    broadcastRoomList();
  });

  // ── 빠른 매칭 ────────────────────────────────────────────────
  socket.on('join_random', ({ nickname, stoneStyle, useTimer }) => {
    for (const q of Object.values(matchQueues)) {
      if (q.findIndex(p => p.socketId === socket.id) !== -1) return;
    }
    const qKey = useTimer === false ? 'noTimer' : 'timer';
    matchQueues[qKey].push({ socketId: socket.id, nickname, stoneStyle: stoneStyle || 'classic' });
    socket.emit('queue_joined', { position: matchQueues[qKey].length });
    tryMatch(qKey);
  });

  socket.on('cancel_random', () => {
    for (const q of Object.values(matchQueues)) {
      const idx = q.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) { q.splice(idx, 1); break; }
    }
    socket.emit('queue_cancelled');
  });

  // ── 방 생성 ──────────────────────────────────────────────────
  socket.on('create_room', async ({ nickname, stoneStyle, useTimer, roomName, password, gameType }) => {
    const roomId = generateRoomId();
    const room = createRoom(roomId, {
      name: (roomName || `${nickname}의 방`).substring(0, 20),
      password: password || null,
      useTimer: useTimer !== false,
      hostSocketId: socket.id,
      gameType: gameType || 'gomoku',
    });
    const rec = await getRecord(nickname);
    room.players.push({
      socketId: socket.id, nickname, color: 1,
      stoneStyle: stoneStyle || 'classic',
    });
    socket.join(roomId);
    socket.emit('room_created', { roomId });
    await broadcastLobbyState(room);
    broadcastRoomList();
    console.log(`방 생성: ${nickname} [${roomId}] "${room.name}"`);
  });

  // ── 방 입장 ──────────────────────────────────────────────────
  socket.on('join_room', async ({ roomId, nickname, stoneStyle, password }) => {
    const room = rooms.get(roomId.toUpperCase ? roomId.toUpperCase() : roomId);
    if (!room) { socket.emit('join_error', { msg: '존재하지 않는 방입니다.' }); return; }

    // 비밀번호 확인
    if (room.password && room.password !== password) {
      socket.emit('join_error', { msg: '비밀번호가 틀렸습니다.' }); return;
    }

    // 게임 중 → 관전 입장
    if (room.status === 'playing') {
      if (room.spectators.find(s => s.socketId === socket.id)) return;
      room.spectators.push({ socketId: socket.id, nickname });
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

    // 대기 중 → 플레이어로 입장 (슬롯이 있을 때)
    if (room.status === 'waiting') {
      // 이미 입장한 경우 (재연결 등)
      if (room.players.find(p => p.socketId === socket.id)) {
        socket.join(roomId);
        await broadcastLobbyState(room);
        return;
      }
      // 관전자로 이미 있는 경우
      if (room.spectators.find(s => s.socketId === socket.id)) {
        socket.join(roomId);
        await broadcastLobbyState(room);
        return;
      }

      if (room.players.length < 2) {
        // 플레이어 슬롯 입장
        room.players.push({
          socketId: socket.id, nickname, color: 2,
          stoneStyle: stoneStyle || 'classic',
        });
        socket.join(roomId);
        socket.emit('room_joined', { roomId });
        await broadcastLobbyState(room);
        broadcastRoomList();
      } else {
        // 플레이어 슬롯 꽉 참 → 관전자로 입장
        room.spectators.push({ socketId: socket.id, nickname });
        socket.join(roomId);
        socket.emit('room_joined', { roomId, asSpectator: true });
        await broadcastLobbyState(room);
        broadcastRoomList();
      }
      return;
    }

    socket.emit('join_error', { msg: '입장할 수 없는 방입니다.' });
  });

  // ── 대기실: 관전자 슬롯으로 이동 ─────────────────────────────
  socket.on('move_to_spectator', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx === -1) return;

    const player = room.players[playerIdx];
    room.players.splice(playerIdx, 1);
    room.readySet.delete(socket.id);

    // 방장이 나가면 다음 플레이어에게 방장 이전
    if (room.hostSocketId === socket.id && room.players.length > 0) {
      room.hostSocketId = room.players[0].socketId;
      // 플레이어 색상 재배정
      room.players.forEach((p, i) => { p.color = i + 1; });
    }

    room.spectators.push({ socketId: socket.id, nickname: player.nickname });
    await broadcastLobbyState(room);
    broadcastRoomList();
  });

  // ── 대기실: 관전자 → 플레이어 슬롯으로 이동 ──────────────────
  socket.on('move_to_player', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    if (room.players.length >= 2) { socket.emit('join_error', { msg: '플레이어 슬롯이 꽉 찼습니다.' }); return; }

    const specIdx = room.spectators.findIndex(s => s.socketId === socket.id);
    if (specIdx === -1) return;

    const spec = room.spectators[specIdx];
    room.spectators.splice(specIdx, 1);
    const color = room.players.length === 0 ? 1 : 2;
    room.players.push({ socketId: socket.id, nickname: spec.nickname, color, stoneStyle: 'classic' });

    if (room.players.length === 1) room.hostSocketId = socket.id;
    await broadcastLobbyState(room);
    broadcastRoomList();
  });

  // ── 대기실: 준비 토글 ────────────────────────────────────────
  socket.on('player_ready', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.socketId === room.hostSocketId) return; // 방장은 준비 불필요

    if (room.readySet.has(socket.id)) room.readySet.delete(socket.id);
    else room.readySet.add(socket.id);

    await broadcastLobbyState(room);
  });

  // ── 대기실: 시작 (방장) ──────────────────────────────────────
  socket.on('start_game', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    if (room.hostSocketId !== socket.id) { socket.emit('join_error', { msg: '방장만 시작할 수 있습니다.' }); return; }
    if (room.players.length < 2) { socket.emit('join_error', { msg: '플레이어가 2명이어야 합니다.' }); return; }

    // 방장 제외 나머지 플레이어 모두 준비 확인
    const nonHostPlayers = room.players.filter(p => p.socketId !== room.hostSocketId);
    const allReady = nonHostPlayers.every(p => room.readySet.has(p.socketId));
    if (!allReady) { socket.emit('join_error', { msg: '모든 플레이어가 준비되어야 합니다.' }); return; }

    room.status = 'playing';
    room.readySet.clear();
    await emitGameStart(room);
  });

  // ── 대기실: 강퇴 (방장) ──────────────────────────────────────
  socket.on('kick_player', async ({ roomId, targetNickname }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    const playerIdx = room.players.findIndex(p => p.nickname === targetNickname && p.socketId !== socket.id);
    if (playerIdx !== -1) {
      const kicked = room.players[playerIdx];
      room.players.splice(playerIdx, 1);
      room.readySet.delete(kicked.socketId);
      // 색상 재배정
      room.players.forEach((p, i) => { p.color = i + 1; });
      io.to(kicked.socketId).emit('kicked', { msg: '방장에 의해 강퇴되었습니다.' });
      const kickedSocket = io.sockets.sockets.get(kicked.socketId);
      if (kickedSocket) kickedSocket.leave(roomId);
      await broadcastLobbyState(room);
      broadcastRoomList();
      return;
    }

    const specIdx = room.spectators.findIndex(s => s.nickname === targetNickname);
    if (specIdx !== -1) {
      const kicked = room.spectators[specIdx];
      room.spectators.splice(specIdx, 1);
      io.to(kicked.socketId).emit('kicked', { msg: '방장에 의해 강퇴되었습니다.' });
      const kickedSocket = io.sockets.sockets.get(kicked.socketId);
      if (kickedSocket) kickedSocket.leave(roomId);
      await broadcastLobbyState(room);
      broadcastRoomList();
    }
  });

  // ── 방 나가기 ────────────────────────────────────────────────
  socket.on('leave_room', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    handleLeaveRoom(socket.id, room, roomId);
  });

  // ── 돌 놓기 ──────────────────────────────────────────────────
  socket.on('place_stone', async ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    if (room.gameType === 'othello') return;
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

  // ── 오델로 돌 놓기 ────────────────────────────────────────────
  socket.on('place_othello', async ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || room.gameType !== 'othello') return;
    if (room.isPaused) { socket.emit('error', { msg: '게임이 일시정지 중입니다.' }); return; }
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    if (player.color !== room.turn) { socket.emit('error', { msg: '당신의 차례가 아닙니다.' }); return; }
    if (row < 0 || row >= 8 || col < 0 || col >= 8) return;
    if (room.board[row][col] !== 0) { socket.emit('error', { msg: '이미 돌이 놓인 자리입니다.' }); return; }

    const flips = getOthelloFlips(room.board, row, col, player.color);
    if (flips.length === 0) { socket.emit('error', { msg: '놓을 수 없는 자리입니다.' }); return; }

    clearTurnTimer(room);
    room.board[row][col] = player.color;
    for (const [fr, fc] of flips) room.board[fr][fc] = player.color;
    room.moveHistory.push({ row, col, color: player.color, flips: flips.map(f => [...f]) });
    room.moveCount++;
    room.pendingUndo = null;

    const { black, white } = countOthelloPieces(room.board);
    io.to(roomId).emit('othello_placed', { row, col, color: player.color, flips, black, white });

    const nextColor = player.color === 1 ? 2 : 1;
    const nextMoves = getOthelloValidMoves(room.board, nextColor);
    const curMoves  = getOthelloValidMoves(room.board, player.color);
    const boardFull = black + white === 64;

    if (boardFull || (nextMoves.length === 0 && curMoves.length === 0)) {
      // 게임 종료
      room.status = 'finished';
      let result, winnerNick = null, loserNick = null;
      if (black > white) {
        result = 'win';
        winnerNick = room.players.find(p => p.color === 1).nickname;
        loserNick  = room.players.find(p => p.color === 2).nickname;
      } else if (white > black) {
        result = 'win';
        winnerNick = room.players.find(p => p.color === 2).nickname;
        loserNick  = room.players.find(p => p.color === 1).nickname;
      } else {
        result = 'draw';
      }
      if (winnerNick) await addWin(winnerNick);
      if (loserNick)  await addLose(loserNick);
      if (result === 'draw') await Promise.all(room.players.map(p => addDraw(p.nickname)));
      const records = await Promise.all(room.players.map(async p => ({
        nickname: p.nickname, record: await getRecord(p.nickname)
      })));
      io.to(roomId).emit('game_over', { result, winner: winnerNick, loser: loserNick, records });
      broadcastRoomList();
    } else if (nextMoves.length === 0) {
      // 다음 플레이어 착수 불가 → 패스 (현재 플레이어 계속)
      io.to(roomId).emit('othello_pass', { color: nextColor });
      startTurnTimer(room);
    } else {
      room.turn = nextColor;
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
    if (room.moveHistory.length < 1) { socket.emit('undo_result', { ok: false, reason: '무를 수 있는 돌이 없습니다.' }); return; }
    if (room.pendingUndo) { socket.emit('undo_result', { ok: false, reason: '이미 요청 중입니다.' }); return; }
    room.pendingUndo = { requesterSocketId: socket.id };
    const opponent = room.players.find(p => p.socketId !== socket.id);
    if (opponent) io.to(opponent.socketId).emit('undo_requested', { from: requester.nickname });
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
      const isOthello = room.gameType === 'othello';
      const undoCount = isOthello ? Math.min(1, room.moveHistory.length) : Math.min(2, room.moveHistory.length);
      for (let i = 0; i < undoCount; i++) {
        const mv = room.moveHistory.pop();
        if (mv) {
          room.board[mv.row][mv.col] = 0;
          room.moveCount--;
          if (isOthello && mv.flips) {
            const opp = mv.color === 1 ? 2 : 1;
            for (const [fr, fc] of mv.flips) room.board[fr][fc] = opp;
          }
        }
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
    if (room.pendingSurrender) { socket.emit('surrender_result', { ok: false, reason: '이미 요청 중입니다.' }); return; }
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
      io.to(roomId).emit('game_over', { result: 'resign', winner: winner ? winner.nickname : null, loser: loser.nickname, records });
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
      room.board = room.gameType === 'othello' ? createOthelloBoard() : createBoard();
      room.turn = 1; room.status = 'playing';
      room.moveCount = 0; room.moveHistory = [];
      room.pendingUndo = null; room.pendingSurrender = null;
      room.isPaused = false;
      room.rematchRequests = new Set();
      room.readySet = new Set();
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
  });

  socket.on('resume_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || !room.isPaused) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    room.isPaused = false;
    io.to(roomId).emit('game_resumed', { by: player.nickname });
    startTurnTimer(room);
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
    io.to(roomId).emit('game_over', { result: 'resign', winner: winner ? winner.nickname : null, loser: loser.nickname, records });
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
      handleLeaveRoom(socket.id, room, roomId, true);
    }
  });
});

async function handleLeaveRoom(socketId, room, roomId, isDisconnect = false) {
  // 관전자 처리
  const specIdx = room.spectators.findIndex(s => s.socketId === socketId);
  if (specIdx !== -1) {
    room.spectators.splice(specIdx, 1);
    if (room.status === 'waiting') {
      await broadcastLobbyState(room);
    } else {
      io.to(roomId).emit('spectator_update', { count: room.spectators.length });
    }
    broadcastRoomList();
    return;
  }

  // 플레이어 처리
  const playerIdx = room.players.findIndex(p => p.socketId === socketId);
  if (playerIdx === -1) return;

  if (room.status === 'waiting') {
    const player = room.players[playerIdx];
    room.players.splice(playerIdx, 1);
    room.readySet.delete(socketId);

    if (room.players.length === 0 && room.spectators.length === 0) {
      rooms.delete(roomId);
      broadcastRoomList();
      return;
    }

    // 방장 이전
    if (room.hostSocketId === socketId && room.players.length > 0) {
      room.hostSocketId = room.players[0].socketId;
      room.players.forEach((p, i) => { p.color = i + 1; });
    }

    await broadcastLobbyState(room);
    broadcastRoomList();
    return;
  }

  if (room.status === 'playing') {
    const loser = room.players[playerIdx];
    const winner = room.players.find(p => p.socketId !== socketId);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`오목 서버 실행 중: http://localhost:${PORT}`);
});
