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
  // 재화 시스템
  coins:          { type: Number, default: 1000000 },   // 초기 100만
  coinsEmptyAt:   { type: Date,   default: null },      // 0원 된 시각
  lastAttendance: { type: Date,   default: null },      // 마지막 출석
  holdemWin:      { type: Number, default: 0 },         // 홀덤 승
  holdemLose:     { type: Number, default: 0 },         // 홀덤 패
});
const Record = mongoose.model('Record', recordSchema);

// ── 재화 상수 ────────────────────────────────────────────────────
const INITIAL_COINS    = 1000000;   // 첫 지급 / 쿨타임 후 보충
const COOLDOWN_MS      = 2 * 60 * 60 * 1000; // 2시간

// 홀덤 블라인드 (바이인 → SB/BB)
const HOLDEM_BLINDS = {
  1000:  { sb: 10,  bb: 20  },
  5000:  { sb: 50,  bb: 100 },
  10000: { sb: 100, bb: 200 },
};

// 출석 상자 등급 (균등 분포)
const ATTENDANCE_TIERS = [
  { label: '일반',     min: 10000,    max: 100000,    prob: 0.50 },
  { label: '고급',     min: 100000,   max: 500000,    prob: 0.30 },
  { label: '희귀',     min: 500000,   max: 1500000,   prob: 0.15 },
  { label: '전설',     min: 1500000,  max: 5000000,   prob: 0.03 },
  { label: '레전더리', min: 5000000,  max: 20000000,  prob: 0.02 },
];

function rollAttendanceBox() {
  const r = Math.random();
  let cumulative = 0;
  for (const tier of ATTENDANCE_TIERS) {
    cumulative += tier.prob;
    if (r < cumulative) {
      const amount = Math.floor(Math.random() * (tier.max - tier.min + 1)) + tier.min;
      return { label: tier.label, amount };
    }
  }
  // fallback
  return { label: '일반', amount: 10000 };
}

// 오늘 KST 00:00 기준 Date
function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCHours(0, 0, 0, 0);
  return new Date(kst.getTime() - 9 * 60 * 60 * 1000); // UTC로 변환
}

async function getCoinsInfo(nickname) {
  try {
    let rec = await Record.findOne({ nickname });
    if (!rec) rec = await Record.create({ nickname });

    // 기존 유저 coins 필드 초기화
    if (rec.coins === undefined || rec.coins === null) {
      rec.coins = INITIAL_COINS;
      rec.coinsEmptyAt = null;
      rec.lastAttendance = null;
      await rec.save();
    }

    // 쿨타임 자동 해제 체크
    if (rec.coins === 0 && rec.coinsEmptyAt) {
      const elapsed = Date.now() - rec.coinsEmptyAt.getTime();
      if (elapsed >= COOLDOWN_MS) {
        rec.coins = INITIAL_COINS;
        rec.coinsEmptyAt = null;
        await rec.save();
      }
    }

    const todayMidnight = todayKST();
    const attendanceAvailable = !rec.lastAttendance || rec.lastAttendance < todayMidnight;
    const cooldownRemaining = (rec.coins === 0 && rec.coinsEmptyAt)
      ? Math.max(0, COOLDOWN_MS - (Date.now() - rec.coinsEmptyAt.getTime()))
      : 0;

    return {
      coins: rec.coins,
      cooldownRemaining,
      attendanceAvailable,
    };
  } catch (err) {
    console.error('getCoinsInfo error:', err.message);
    return { coins: 0, cooldownRemaining: 0, attendanceAvailable: false };
  }
}

async function deductCoins(nickname, amount) {
  try {
    const rec = await Record.findOne({ nickname });
    if (!rec || rec.coins < amount) return false;
    rec.coins -= amount;
    if (rec.coins === 0) rec.coinsEmptyAt = new Date();
    await rec.save();
    return true;
  } catch (err) { console.error('deductCoins error:', err.message); return false; }
}

async function addCoins(nickname, amount) {
  try {
    await Record.findOneAndUpdate(
      { nickname },
      [{ $set: {
        coins: { $add: [{ $ifNull: ['$coins', 0] }, amount] },
        coinsEmptyAt: null,
      }}],
      { upsert: true }
    );
  } catch (err) { console.error('addCoins error:', err.message); }
}

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
async function addHoldemWin(nickname) {
  try { await Record.findOneAndUpdate({ nickname }, { $inc: { holdemWin: 1 } }, { upsert: true }); }
  catch (err) { console.error('addHoldemWin error:', err.message); }
}
async function addHoldemLose(nickname) {
  try { await Record.findOneAndUpdate({ nickname }, { $inc: { holdemLose: 1 } }, { upsert: true }); }
  catch (err) { console.error('addHoldemLose error:', err.message); }
}
async function getHoldemRecord(nickname) {
  try {
    const rec = await Record.findOne({ nickname });
    return { holdemWin: rec?.holdemWin || 0, holdemLose: rec?.holdemLose || 0 };
  } catch { return { holdemWin: 0, holdemLose: 0 }; }
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

// ── 홀덤 덱/핸드 평가 ────────────────────────────────────────

function createDeck() {
  const deck = [];
  for (const suit of ['S', 'H', 'D', 'C'])
    for (let rank = 2; rank <= 14; rank++)
      deck.push({ suit, rank });
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...getCombinations(rest, k - 1).map(c => [first, ...c]),
    ...getCombinations(rest, k),
  ];
}

function scoreHand5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = new Set(suits).size === 1;
  let isStraight = false, straightHigh = ranks[0];
  if (new Set(ranks).size === 5 && ranks[0] - ranks[4] === 4) {
    isStraight = true;
  } else if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    isStraight = true; straightHigh = 5;
  }
  const freq = {};
  for (const r of ranks) freq[r] = (freq[r] || 0) + 1;
  const counts = Object.entries(freq)
    .map(([r, c]) => [+r, c])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (isFlush && isStraight) return { rank: 9, tb: [straightHigh], name: '스트레이트 플러시' };
  if (counts[0][1] === 4) return { rank: 8, tb: [counts[0][0], counts[1][0]], name: '포카드' };
  if (counts[0][1] === 3 && counts[1][1] === 2) return { rank: 7, tb: [counts[0][0], counts[1][0]], name: '풀하우스' };
  if (isFlush) return { rank: 6, tb: ranks, name: '플러시' };
  if (isStraight) return { rank: 5, tb: [straightHigh], name: '스트레이트' };
  if (counts[0][1] === 3) return { rank: 4, tb: counts.map(c => c[0]), name: '트리플' };
  if (counts[0][1] === 2 && counts[1][1] === 2) return { rank: 3, tb: counts.map(c => c[0]), name: '투페어' };
  if (counts[0][1] === 2) return { rank: 2, tb: counts.map(c => c[0]), name: '원페어' };
  return { rank: 1, tb: ranks, name: '하이카드' };
}

function evaluateHand(cards) {
  if (!cards || cards.length < 1) return { rank: 0, tb: [], name: '없음' };
  const k = Math.min(5, cards.length);
  const combos = getCombinations(cards, k);
  let best = null;
  for (const combo of combos) {
    const sc = scoreHand5(combo);
    if (!best || compareHands(sc, best) > 0) best = sc;
  }
  return best;
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.tb.length, b.tb.length); i++) {
    const av = a.tb[i] || 0, bv = b.tb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function computeSidePots(players) {
  const withBets = players.filter(p => p.totalBetThisHand > 0)
    .sort((a, b) => a.totalBetThisHand - b.totalBetThisHand);
  const pots = [];
  let prevLevel = 0;
  for (const sp of withBets) {
    if (sp.totalBetThisHand <= prevLevel) continue;
    const level = sp.totalBetThisHand;
    const amount = players.reduce((sum, q) =>
      sum + Math.min(Math.max(0, q.totalBetThisHand - prevLevel), level - prevLevel), 0);
    if (amount > 0) {
      const eligible = players
        .filter(q => !q.folded && q.totalBetThisHand >= level)
        .map(q => q.nickname);
      pots.push({ amount, eligible });
    }
    prevLevel = level;
  }
  return pots;
}

// ── 홀덤 게임 플로우 ─────────────────────────────────────────

function emitHoldemState(room) {
  const h = room.holdem;
  if (!h) return;
  const showAll = h.phase === 'showdown';
  const stateBase = {
    roomId: room.id,
    phase: h.phase,
    communityCards: h.communityCards,
    pot: h.pot,
    sidePots: h.sidePots || [],
    dealerIndex: h.dealerIndex,
    smallBlindIndex: h.smallBlindIndex,
    bigBlindIndex: h.bigBlindIndex,
    actionIndex: h.actionIndex,
    currentBet: h.currentBet,
    minRaise: h.minRaise,
    smallBlindAmount: h.smallBlindAmount,
    bigBlindAmount: h.bigBlindAmount,
    buyIn: room.buyIn || 1000,
    playersToActCount: h.playersToAct ? h.playersToAct.length : 0,
  };
  const basePlayers = room.players.map((p, idx) => ({
    idx,
    nickname: p.nickname,
    chips: p.chips,
    bet: p.bet,
    totalBetThisHand: p.totalBetThisHand,
    folded: p.folded,
    allIn: p.allIn,
    isDisconnected: p.isDisconnected || false,
    holeCards: showAll && !p.folded ? (p.holeCards || []) : null,
  }));
  room.players.forEach((p, myIdx) => {
    const personalPlayers = basePlayers.map((bp, i) => ({
      ...bp,
      holeCards: showAll ? bp.holeCards : (i === myIdx ? (p.holeCards || []) : null),
    }));
    // 내 현재 족보
    let myHandName = null;
    if (p.holeCards && p.holeCards.length === 2 && h.communityCards.length > 0) {
      myHandName = evaluateHand([...p.holeCards, ...h.communityCards]).name;
    } else if (p.holeCards && p.holeCards.length === 2) {
      myHandName = evaluateHand([...p.holeCards]).name;
    }
    io.to(p.socketId).emit('holdem_state', { ...stateBase, yourIndex: myIdx, myHandName, players: personalPlayers });
  });
  room.spectators.forEach(spec => {
    const fullPlayers = basePlayers.map((bp, i) => ({
      ...bp,
      holeCards: room.players[i].holeCards || [],
    }));
    io.to(spec.socketId).emit('holdem_state', { ...stateBase, yourIndex: -1, isSpectator: true, players: fullPlayers });
  });
}

function clearHoldemTimer(room) {
  if (room.holdem && room.holdem.actionTimer) {
    clearTimeout(room.holdem.actionTimer);
    room.holdem.actionTimer = null;
  }
}

function startHoldemTimer(room) {
  clearHoldemTimer(room);
  const h = room.holdem;
  if (!h || h.actionIndex < 0) return;
  const cp = room.players[h.actionIndex];
  if (!cp || cp.folded || cp.allIn) return;
  io.to(room.id).emit('holdem_timer', {
    playerIndex: h.actionIndex, nickname: cp.nickname, seconds: 30, timestamp: Date.now(),
  });
  h.actionTimer = setTimeout(() => {
    if (room.status !== 'playing') return;
    processHoldemAction(room, h.actionIndex, 'fold', 0);
  }, 30000);
}

function postBlind(room, playerIdx, amount) {
  const p = room.players[playerIdx];
  if (!p || p.chips <= 0) return;
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet += actual;
  p.totalBetThisHand += actual;
  room.holdem.pot += actual;
  if (p.chips === 0) p.allIn = true;
}

function startHoldemHand(room) {
  const h = room.holdem;
  if (!h || room.status !== 'playing') return;
  const activeIdxs = room.players.map((p, i) => ({ p, i })).filter(({ p }) => p.chips > 0).map(({ i }) => i);
  if (activeIdxs.length < 2) { endHoldemGame(room); return; }

  for (const p of room.players) {
    p.holeCards = [];
    p.bet = 0;
    p.totalBetThisHand = 0;
    p.folded = p.chips === 0;
    p.allIn = false;
  }
  h.deck = shuffleDeck(createDeck());
  h.communityCards = [];
  h.phase = 'preflop';
  h.pot = 0;
  h.sidePots = [];
  h.currentBet = h.bigBlindAmount;
  h.minRaise = h.bigBlindAmount;
  h.playersToAct = [];
  h.actionIndex = -1;

  const n = activeIdxs.length;
  // Rotate dealer
  if (h.dealerIndex < 0) {
    h.dealerIndex = activeIdxs[Math.floor(Math.random() * n)];
  } else {
    const prevPos = activeIdxs.indexOf(h.dealerIndex);
    const startPos = prevPos === -1 ? 0 : prevPos;
    h.dealerIndex = activeIdxs[(startPos + 1) % n];
  }
  const dealerPos = activeIdxs.indexOf(h.dealerIndex);
  let sbIdx, bbIdx;
  if (n === 2) {
    sbIdx = h.dealerIndex;
    bbIdx = activeIdxs[(dealerPos + 1) % n];
  } else {
    sbIdx = activeIdxs[(dealerPos + 1) % n];
    bbIdx = activeIdxs[(dealerPos + 2) % n];
  }
  h.smallBlindIndex = sbIdx;
  h.bigBlindIndex = bbIdx;

  postBlind(room, sbIdx, h.smallBlindAmount);
  postBlind(room, bbIdx, h.bigBlindAmount);

  for (const pi of activeIdxs) {
    room.players[pi].holeCards = [h.deck.pop(), h.deck.pop()];
  }

  // playersToAct for preflop: UTG → ... → BB
  const bbPos = activeIdxs.indexOf(bbIdx);
  const toAct = [];
  for (let i = 1; i <= n; i++) {
    const idx = activeIdxs[(bbPos + i) % n];
    if (!room.players[idx].allIn) toAct.push(idx);
  }
  h.playersToAct = toAct;
  h.actionIndex = toAct.length > 0 ? toAct[0] : -1;

  if (toAct.length === 0) { runItOut(room); return; }
  emitHoldemState(room);
  startHoldemTimer(room);
}

function processHoldemAction(room, playerIdx, action, raiseAmount) {
  const h = room.holdem;
  if (!h || room.status !== 'playing') return;
  const p = room.players[playerIdx];
  if (!p || p.folded || p.allIn) return;
  if (!h.playersToAct.length || h.playersToAct[0] !== playerIdx) return;

  clearHoldemTimer(room);
  h.playersToAct.shift();

  if (action === 'fold') {
    p.folded = true;
    h.playersToAct = h.playersToAct.filter(i => !room.players[i].folded);
    const remaining = room.players.filter(q => !q.folded);
    if (remaining.length === 1) { endHandEarly(room, remaining[0]); return; }

  } else if (action === 'check') {
    // valid only if p.bet >= h.currentBet (client enforces)

  } else if (action === 'call') {
    const toCall = Math.min(h.currentBet - p.bet, p.chips);
    p.chips -= toCall; p.bet += toCall; p.totalBetThisHand += toCall; h.pot += toCall;
    if (p.chips === 0) { p.allIn = true; h.playersToAct = h.playersToAct.filter(i => i !== playerIdx); }

  } else if (action === 'raise' || action === 'allin') {
    let raiseTo;
    if (action === 'allin') {
      raiseTo = p.bet + p.chips;
    } else {
      raiseTo = Math.min(Math.max(raiseAmount, h.currentBet + h.minRaise), p.bet + p.chips);
    }
    const toAdd = Math.min(raiseTo - p.bet, p.chips);
    p.chips -= toAdd; p.bet += toAdd; p.totalBetThisHand += toAdd; h.pot += toAdd;

    if (p.bet > h.currentBet) {
      h.minRaise = Math.max(h.bigBlindAmount, p.bet - h.currentBet);
      h.currentBet = p.bet;
      // Reopen action
      const nPlayers = room.players.length;
      const newToAct = [];
      for (let i = 1; i < nPlayers; i++) {
        const idx = (playerIdx + i) % nPlayers;
        if (!room.players[idx].folded && !room.players[idx].allIn) newToAct.push(idx);
      }
      h.playersToAct = newToAct;
    }
    if (p.chips === 0) { p.allIn = true; h.playersToAct = h.playersToAct.filter(i => i !== playerIdx); }
  }

  io.to(room.id).emit('holdem_action_done', {
    playerIdx, nickname: p.nickname, action,
    betAmount: p.bet, pot: h.pot, chips: p.chips,
  });

  if (h.playersToAct.length === 0) {
    advanceHoldemPhase(room);
  } else {
    h.actionIndex = h.playersToAct[0];
    emitHoldemState(room);
    startHoldemTimer(room);
  }
}

function advanceHoldemPhase(room) {
  const h = room.holdem;
  clearHoldemTimer(room);
  for (const p of room.players) p.bet = 0;
  h.currentBet = 0;
  h.minRaise = h.bigBlindAmount;

  if (h.phase === 'preflop') {
    h.communityCards.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
    h.phase = 'flop';
  } else if (h.phase === 'flop') {
    h.communityCards.push(h.deck.pop());
    h.phase = 'turn';
  } else if (h.phase === 'turn') {
    h.communityCards.push(h.deck.pop());
    h.phase = 'river';
  } else if (h.phase === 'river') {
    startHoldemShowdown(room);
    return;
  }

  const canBet = room.players.filter(q => !q.folded && !q.allIn);
  if (canBet.length <= 1) {
    emitHoldemState(room);
    setTimeout(() => runItOut(room), 800);
    return;
  }

  // First actor: left of dealer, non-folded, non-allIn
  const nPlayers = room.players.length;
  let firstIdx = -1;
  for (let i = 1; i <= nPlayers; i++) {
    const idx = (h.dealerIndex + i) % nPlayers;
    if (!room.players[idx].folded && !room.players[idx].allIn) { firstIdx = idx; break; }
  }
  if (firstIdx === -1) { runItOut(room); return; }

  const toAct = [];
  for (let i = 0; i < nPlayers; i++) {
    const idx = (firstIdx + i) % nPlayers;
    if (!room.players[idx].folded && !room.players[idx].allIn) toAct.push(idx);
  }
  h.playersToAct = toAct;
  h.actionIndex = toAct[0];
  emitHoldemState(room);
  startHoldemTimer(room);
}

function runItOut(room) {
  const h = room.holdem;
  clearHoldemTimer(room);
  while (h.communityCards.length < 5) {
    if (h.communityCards.length === 0) {
      h.communityCards.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
      h.phase = 'flop';
    } else if (h.communityCards.length === 3) {
      h.communityCards.push(h.deck.pop());
      h.phase = 'turn';
    } else if (h.communityCards.length === 4) {
      h.communityCards.push(h.deck.pop());
      h.phase = 'river';
    } else break;
  }
  emitHoldemState(room);
  setTimeout(() => startHoldemShowdown(room), 1500);
}

function startHoldemShowdown(room) {
  const h = room.holdem;
  h.phase = 'showdown';
  clearHoldemTimer(room);
  h.sidePots = computeSidePots(room.players);

  const evals = {};
  for (const p of room.players) {
    if (!p.folded && p.holeCards && p.holeCards.length > 0) {
      evals[p.nickname] = evaluateHand([...p.holeCards, ...h.communityCards]);
    }
  }

  const winnings = {};
  for (const p of room.players) winnings[p.nickname] = 0;

  for (const pot of h.sidePots) {
    const eligible = pot.eligible.filter(nick => evals[nick]);
    if (!eligible.length) continue;
    if (eligible.length === 1) { winnings[eligible[0]] += pot.amount; continue; }
    let bestSc = null, winners = [];
    for (const nick of eligible) {
      const sc = evals[nick];
      const cmp = bestSc ? compareHands(sc, bestSc) : 1;
      if (cmp > 0) { bestSc = sc; winners = [nick]; }
      else if (cmp === 0) winners.push(nick);
    }
    const share = Math.floor(pot.amount / winners.length);
    const rem = pot.amount - share * winners.length;
    winners.forEach((nick, i) => { winnings[nick] += share + (i === 0 ? rem : 0); });
  }

  for (const p of room.players) p.chips += winnings[p.nickname] || 0;

  const showdownResult = room.players.map(p => ({
    nickname: p.nickname,
    holeCards: p.folded ? null : (p.holeCards || []),
    handScore: evals[p.nickname] || null,
    winAmount: winnings[p.nickname] || 0,
    chips: p.chips,
    folded: p.folded,
  }));

  emitHoldemState(room);
  io.to(room.id).emit('holdem_showdown', { roomId: room.id, showdownResult, sidePots: h.sidePots });

  const stillActive = room.players.filter(p => p.chips > 0);
  if (stillActive.length <= 1) {
    setTimeout(() => endHoldemGame(room), 3000);
  } else {
    setTimeout(() => startHoldemHand(room), 4000);
  }
}

function endHandEarly(room, winnerPlayer) {
  clearHoldemTimer(room);
  const h = room.holdem;
  winnerPlayer.chips += h.pot;
  const wonAmount = h.pot;
  h.pot = 0;
  h.sidePots = [];
  io.to(room.id).emit('holdem_hand_end', {
    roomId: room.id, winner: winnerPlayer.nickname, wonAmount, reason: 'fold',
    players: room.players.map(p => ({ nickname: p.nickname, chips: p.chips, folded: p.folded })),
  });
  emitHoldemState(room);
  const stillActive = room.players.filter(p => p.chips > 0);
  if (stillActive.length <= 1) {
    setTimeout(() => endHoldemGame(room), 2000);
  } else {
    setTimeout(() => startHoldemHand(room), 3000);
  }
}

async function endHoldemGame(room) {
  clearHoldemTimer(room);
  room.status = 'finished';
  const winner = room.players.find(p => p.chips > 0);
  const losers = room.players.filter(p => p.chips === 0);
  if (winner) {
    await addCoins(winner.nickname, winner.chips);
    await addHoldemWin(winner.nickname);
  }
  for (const loser of losers) await addHoldemLose(loser.nickname);
  const results = await Promise.all(room.players.map(async p => {
    const info = await getCoinsInfo(p.nickname);
    const hr = await getHoldemRecord(p.nickname);
    return { nickname: p.nickname, chips: p.chips, isWinner: !!(winner && p.nickname === winner.nickname), coins: info.coins, holdemRecord: hr };
  }));
  io.to(room.id).emit('holdem_game_over', { roomId: room.id, winner: winner ? winner.nickname : null, results });
  broadcastRoomList();
  setTimeout(() => { if (rooms.has(room.id)) rooms.delete(room.id); }, 30000);
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
        maxPlayers: room.gameType === 'holdem' ? 6 : 2,
        players: room.players.map(p => p.nickname),
        spectatorCount: room.spectators.length,
        useTimer: room.useTimer !== false,
        gameType: room.gameType || 'gomoku',
        buyIn: room.buyIn,
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
    buyIn: room.buyIn,
    maxPlayers: room.gameType === 'holdem' ? 6 : 2,
  });
}

function createRoom(roomId, options = {}) {
  const gameType = options.gameType || 'gomoku';
  const buyIn = options.buyIn || 1000;
  const blinds = HOLDEM_BLINDS[buyIn] || HOLDEM_BLINDS[1000];
  const room = {
    id: roomId,
    name: options.name || `방 ${roomId}`,
    password: options.password || null,
    hostSocketId: options.hostSocketId || null,
    gameType,
    buyIn: gameType === 'holdem' ? buyIn : undefined,
    players: [],
    readySet: new Set(),
    board: gameType === 'othello' ? createOthelloBoard() : (gameType === 'holdem' ? null : createBoard()),
    turn: 1,
    status: 'waiting',
    moveCount: 0,
    useTimer: options.useTimer !== false,
    isPaused: false,
    chat: [],
    spectators: [],
    moveHistory: [],
    pendingUndo: null,
    pendingSurrender: null,
    turnTimer: null,
    rematchRequests: null,
    holdem: gameType === 'holdem' ? {
      phase: 'waiting',
      deck: [],
      communityCards: [],
      dealerIndex: -1,
      smallBlindIndex: -1,
      bigBlindIndex: -1,
      actionIndex: -1,
      playersToAct: [],
      currentBet: 0,
      minRaise: blinds.bb,
      pot: 0,
      sidePots: [],
      smallBlindAmount: blinds.sb,
      bigBlindAmount: blinds.bb,
      actionTimer: null,
    } : null,
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

  // ── 재화 정보 요청 ────────────────────────────────────────────
  socket.on('get_coins', async ({ nickname }) => {
    if (!nickname) return;
    const info = await getCoinsInfo(nickname);
    socket.emit('coins_info', info);
  });

  // ── 출석 체크 ─────────────────────────────────────────────────
  socket.on('attendance_claim', async ({ nickname }) => {
    if (!nickname) return;
    try {
      const rec = await Record.findOne({ nickname });
      if (!rec) return;

      const todayMidnight = todayKST();
      if (rec.lastAttendance && rec.lastAttendance >= todayMidnight) {
        socket.emit('attendance_result', { ok: false, reason: '오늘 이미 출석했습니다.' });
        return;
      }

      const reward = rollAttendanceBox();
      rec.coins = (rec.coins || 0) + reward.amount;
      if (rec.coins > 0) rec.coinsEmptyAt = null;
      rec.lastAttendance = new Date();
      await rec.save();

      socket.emit('attendance_result', { ok: true, ...reward, coins: rec.coins });
    } catch (err) {
      console.error('attendance_claim error:', err.message);
      socket.emit('attendance_result', { ok: false, reason: '오류가 발생했습니다.' });
    }
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
  socket.on('create_room', async ({ nickname, stoneStyle, useTimer, roomName, password, gameType, buyIn }) => {
    const roomId = generateRoomId();
    const room = createRoom(roomId, {
      name: (roomName || `${nickname}의 방`).substring(0, 20),
      password: password || null,
      useTimer: useTimer !== false,
      hostSocketId: socket.id,
      gameType: gameType || 'gomoku',
      buyIn: buyIn || 1000,
    });
    await getRecord(nickname);
    room.players.push({
      socketId: socket.id, nickname, color: 1,
      stoneStyle: stoneStyle || 'classic',
      chips: 0, holeCards: [], bet: 0, totalBetThisHand: 0,
      folded: false, allIn: false, isDisconnected: false,
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
      if (room.gameType === 'holdem') {
        emitHoldemState(room);
      } else {
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
      }
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

      const maxPlayers = room.gameType === 'holdem' ? 6 : 2;
      if (room.players.length < maxPlayers) {
        // 플레이어 슬롯 입장
        room.players.push({
          socketId: socket.id, nickname,
          color: room.players.length + 1,
          stoneStyle: stoneStyle || 'classic',
          chips: 0, holeCards: [], bet: 0, totalBetThisHand: 0,
          folded: false, allIn: false, isDisconnected: false,
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
    const maxP = room.gameType === 'holdem' ? 6 : 2;
    if (room.players.length >= maxP) { socket.emit('join_error', { msg: '플레이어 슬롯이 꽉 찼습니다.' }); return; }

    const specIdx = room.spectators.findIndex(s => s.socketId === socket.id);
    if (specIdx === -1) return;

    const spec = room.spectators[specIdx];
    room.spectators.splice(specIdx, 1);
    const color = room.players.length + 1;
    room.players.push({
      socketId: socket.id, nickname: spec.nickname, color, stoneStyle: 'classic',
      chips: 0, holeCards: [], bet: 0, totalBetThisHand: 0,
      folded: false, allIn: false, isDisconnected: false,
    });

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
    if (room.players.length < 2) { socket.emit('join_error', { msg: '플레이어가 2명 이상이어야 합니다.' }); return; }

    const nonHostPlayers = room.players.filter(p => p.socketId !== room.hostSocketId);
    const allReady = nonHostPlayers.every(p => room.readySet.has(p.socketId));
    if (!allReady) { socket.emit('join_error', { msg: '모든 플레이어가 준비되어야 합니다.' }); return; }

    // ── 홀덤 시작 처리 ──────────────────────────────────────────
    if (room.gameType === 'holdem') {
      const buyIn = room.buyIn || 1000;
      // 잔액 확인
      for (const p of room.players) {
        const info = await getCoinsInfo(p.nickname);
        if (info.coins < buyIn) {
          socket.emit('join_error', { msg: `${p.nickname} 님의 재화가 부족합니다. (필요: ${buyIn.toLocaleString()})` });
          return;
        }
      }
      // 바이인 차감
      for (const p of room.players) {
        const ok = await deductCoins(p.nickname, buyIn);
        if (!ok) {
          socket.emit('join_error', { msg: `${p.nickname} 님의 재화 차감에 실패했습니다.` });
          return;
        }
        p.chips = buyIn;
      }
      room.status = 'playing';
      room.readySet.clear();
      room.holdem.phase = 'preflop';
      broadcastRoomList();
      startHoldemHand(room);
      return;
    }

    // ── 기존 오목/오델로 시작 ─────────────────────────────────
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

  // ── 홀덤 액션 ────────────────────────────────────────────────
  socket.on('holdem_action', ({ roomId, action, amount }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || room.gameType !== 'holdem') return;
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx === -1) return;
    processHoldemAction(room, playerIdx, action, amount || 0);
  });

  // ── 홀덤 전적 요청 ───────────────────────────────────────────
  socket.on('request_holdem_record', async ({ nickname }) => {
    if (!nickname) return;
    const hr = await getHoldemRecord(nickname);
    socket.emit('holdem_record', hr);
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
    // ── 홀덤: 연결 끊김 → 자동 폴드 ──────────────────────────
    if (room.gameType === 'holdem') {
      const p = room.players[playerIdx];
      p.isDisconnected = true;
      io.to(roomId).emit('holdem_player_disconnect', { nickname: p.nickname, playerIdx });
      // 현재 액션 순서면 자동 폴드
      const h = room.holdem;
      if (h && h.playersToAct.length > 0 && h.playersToAct[0] === playerIdx) {
        processHoldemAction(room, playerIdx, 'fold', 0);
      }
      return;
    }

    // ── 오목/오델로: 기존 처리 ───────────────────────────────
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
