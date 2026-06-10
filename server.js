const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── 상태 관리 ──────────────────────────────────────────────────
const rooms = new Map();       // roomId → RoomState
const matchQueue = [];          // 랜덤 매칭 대기열 [{socketId, nickname}]
const playerRecords = new Map(); // nickname → {win, lose, draw}

function createBoard() {
  return Array.from({ length: 15 }, () => new Array(15).fill(0));
}

function getRecord(nickname) {
  if (!playerRecords.has(nickname)) {
    playerRecords.set(nickname, { win: 0, lose: 0, draw: 0 });
  }
  return playerRecords.get(nickname);
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

// 각 플레이어에게 game_start를 개별 발송 (yourColor 포함)
function emitGameStart(room) {
  const playerData = room.players.map(p => ({
    nickname: p.nickname,
    color: p.color,
    record: getRecord(p.nickname)
  }));
  room.players.forEach(p => {
    io.to(p.socketId).emit('game_start', {
      roomId: room.id,
      board: room.board,
      players: playerData,
      turn: room.turn,
      yourColor: p.color,
    });
  });
}

function createRoom(roomId, isPublic = false) {
  const room = {
    id: roomId,
    players: [],       // [{socketId, nickname, color}]
    board: createBoard(),
    turn: 1,           // 1=흑, 2=백
    status: 'waiting', // waiting | playing | finished
    moveCount: 0,
    isPublic,
    chat: [],
    spectators: [],
  };
  rooms.set(roomId, room);
  return room;
}

function roomInfo(room) {
  return {
    id: room.id,
    players: room.players.map(p => ({
      nickname: p.nickname,
      color: p.color,
      record: getRecord(p.nickname)
    })),
    status: room.status,
    turn: room.turn,
    moveCount: room.moveCount,
    isPublic: room.isPublic,
  };
}

// ── 매칭 큐 처리 ──────────────────────────────────────────────
function tryMatch() {
  while (matchQueue.length >= 2) {
    const p1 = matchQueue.shift();
    const p2 = matchQueue.shift();
    // 둘 다 아직 연결중인지 확인
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (!s1 || !s2) {
      // 끊어진 소켓 제거 후 재시도
      if (s1) matchQueue.unshift(p1);
      if (s2) matchQueue.unshift(p2);
      continue;
    }
    const roomId = generateRoomId();
    const room = createRoom(roomId);
    room.players.push({ socketId: p1.socketId, nickname: p1.nickname, color: 1 });
    room.players.push({ socketId: p2.socketId, nickname: p2.nickname, color: 2 });
    room.status = 'playing';

    s1.join(roomId);
    s2.join(roomId);

    emitGameStart(room);
    console.log(`매칭 완료: ${p1.nickname} vs ${p2.nickname} [${roomId}]`);
  }
}

// ── 소켓 이벤트 ───────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('접속:', socket.id);

  // 랜덤 매칭 신청
  socket.on('join_random', ({ nickname }) => {
    // 이미 대기 중이면 중복 방지
    const idx = matchQueue.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) return;
    matchQueue.push({ socketId: socket.id, nickname });
    socket.emit('queue_joined', { position: matchQueue.length });
    console.log(`매칭 대기: ${nickname} (대기열: ${matchQueue.length}명)`);
    tryMatch();
  });

  // 매칭 취소
  socket.on('cancel_random', () => {
    const idx = matchQueue.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) matchQueue.splice(idx, 1);
    socket.emit('queue_cancelled');
  });

  // 방 만들기
  socket.on('create_room', ({ nickname }) => {
    const roomId = generateRoomId();
    const room = createRoom(roomId, false);
    room.players.push({ socketId: socket.id, nickname, color: 1 });
    socket.join(roomId);
    socket.emit('room_created', { roomId, color: 1 });
  });

  // 방 참가
  socket.on('join_room', ({ roomId, nickname }) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) {
      socket.emit('error', { msg: '존재하지 않는 방입니다.' });
      return;
    }
    if (room.status === 'playing' && !room.players.find(p => p.socketId === socket.id)) {
      // 관전
      room.spectators.push(socket.id);
      socket.join(roomId);
      socket.emit('spectate_start', {
        roomId,
        board: room.board,
        players: room.players.map(p => ({
          nickname: p.nickname,
          color: p.color,
          record: getRecord(p.nickname)
        })),
        turn: room.turn,
      });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { msg: '방이 꽉 찼습니다.' });
      return;
    }
    room.players.push({ socketId: socket.id, nickname, color: 2 });
    socket.join(roomId);

    if (room.players.length === 2) {
      room.status = 'playing';
      emitGameStart(room);
    } else {
      socket.emit('room_joined', { roomId, color: 2 });
    }
  });

  // 돌 놓기
  socket.on('place_stone', ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    if (player.color !== room.turn) {
      socket.emit('error', { msg: '당신의 차례가 아닙니다.' });
      return;
    }
    if (room.board[row][col] !== 0) {
      socket.emit('error', { msg: '이미 돌이 놓인 자리입니다.' });
      return;
    }

    room.board[row][col] = player.color;
    room.moveCount++;

    const isWin = checkWin(room.board, row, col, player.color);
    const isDraw = room.moveCount >= 225;

    io.to(roomId).emit('stone_placed', {
      row, col, color: player.color, turn: room.turn,
      moveCount: room.moveCount,
    });

    if (isWin) {
      room.status = 'finished';
      const winner = player;
      const loser = room.players.find(p => p.socketId !== socket.id);
      getRecord(winner.nickname).win++;
      if (loser) getRecord(loser.nickname).lose++;
      io.to(roomId).emit('game_over', {
        result: 'win',
        winner: winner.nickname,
        records: room.players.map(p => ({
          nickname: p.nickname,
          record: getRecord(p.nickname)
        }))
      });
    } else if (isDraw) {
      room.status = 'finished';
      room.players.forEach(p => getRecord(p.nickname).draw++);
      io.to(roomId).emit('game_over', {
        result: 'draw',
        records: room.players.map(p => ({
          nickname: p.nickname,
          record: getRecord(p.nickname)
        }))
      });
    } else {
      room.turn = room.turn === 1 ? 2 : 1;
      io.to(roomId).emit('turn_changed', { turn: room.turn });
    }
  });

  // 재대결 요청
  socket.on('rematch_request', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    if (!room.rematchRequests) room.rematchRequests = new Set();
    room.rematchRequests.add(socket.id);
    // 상대에게 알림
    room.players.forEach(p => {
      if (p.socketId !== socket.id) {
        io.to(p.socketId).emit('rematch_requested', { from: player.nickname });
      }
    });
    if (room.rematchRequests.size === 2) {
      // 양쪽 다 동의
      room.board = createBoard();
      room.turn = 1;
      room.status = 'playing';
      room.moveCount = 0;
      room.rematchRequests = new Set();
      // 색상 교체
      room.players.forEach(p => { p.color = p.color === 1 ? 2 : 1; });
      emitGameStart(room);
    }
  });

  // 기권
  socket.on('resign', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    const loser = room.players.find(p => p.socketId === socket.id);
    const winner = room.players.find(p => p.socketId !== socket.id);
    if (!loser) return;
    room.status = 'finished';
    if (loser) getRecord(loser.nickname).lose++;
    if (winner) getRecord(winner.nickname).win++;
    io.to(roomId).emit('game_over', {
      result: 'resign',
      winner: winner ? winner.nickname : null,
      loser: loser.nickname,
      records: room.players.map(p => ({
        nickname: p.nickname,
        record: getRecord(p.nickname)
      }))
    });
  });

  // 채팅
  socket.on('chat', ({ roomId, nickname, message }) => {
    if (!message || message.trim().length === 0) return;
    const msg = { nickname, message: message.trim().substring(0, 200), time: Date.now() };
    io.to(roomId).emit('chat', msg);
  });

  // 연결 해제
  socket.on('disconnect', () => {
    console.log('해제:', socket.id);
    // 매칭 큐에서 제거
    const qi = matchQueue.findIndex(p => p.socketId === socket.id);
    if (qi !== -1) matchQueue.splice(qi, 1);

    // 방에서 처리
    for (const [roomId, room] of rooms.entries()) {
      const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
      if (playerIdx !== -1 && room.status === 'playing') {
        const loser = room.players[playerIdx];
        const winner = room.players.find(p => p.socketId !== socket.id);
        room.status = 'finished';
        getRecord(loser.nickname).lose++;
        if (winner) getRecord(winner.nickname).win++;
        io.to(roomId).emit('game_over', {
          result: 'disconnect',
          winner: winner ? winner.nickname : null,
          loser: loser.nickname,
          records: room.players.map(p => ({
            nickname: p.nickname,
            record: getRecord(p.nickname)
          }))
        });
        // 빈 방 정리
        setTimeout(() => {
          if (rooms.has(roomId)) rooms.delete(roomId);
        }, 30000);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`오목 서버 실행 중: http://localhost:${PORT}`);
});
