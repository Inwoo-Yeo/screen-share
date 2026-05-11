// server.js
// Express + Socket.io + PeerJS 서버
// 세션(Session) > 방(Room) 구조로 호스트 모니터링 기능 지원

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- PeerJS 서버 ----------
const peerServer = ExpressPeerServer(server, {
  debug: true,
  allow_discovery: true,
});
app.use('/peerjs', peerServer);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 기본 설정 ----------
const DEFAULT_NUM_ROOMS = 9;
const DEFAULT_MAX_PER_ROOM = 4; // 호스트도 포함됨 (3명 + 호스트 1)

// ---------- 세션 메모리 저장소 ----------
// sessions[sessionId] = {
//   hostPeerId, numRooms, maxPerRoom,
//   rooms: { 1: [{peerId, userName, socketId, isHost}], 2: [...], ... }
// }
const sessions = {};

function getOrCreateSession(sessionId, numRooms, maxPerRoom) {
  if (!sessions[sessionId]) {
    const n = Math.max(1, Math.min(20, parseInt(numRooms) || DEFAULT_NUM_ROOMS));
    const m = Math.max(2, Math.min(10, parseInt(maxPerRoom) || DEFAULT_MAX_PER_ROOM));
    sessions[sessionId] = { hostPeerId: null, numRooms: n, maxPerRoom: m, rooms: {} };
    for (let i = 1; i <= n; i++) sessions[sessionId].rooms[i] = [];
    console.log(`✨ 세션 [${sessionId}] 생성 (방 ${n}개, 최대 ${m}명/방)`);
  }
  return sessions[sessionId];
}

function snapshotSession(sessionId) {
  const s = sessions[sessionId];
  if (!s) return null;
  const rooms = {};
  for (const [k, members] of Object.entries(s.rooms)) {
    rooms[k] = {
      roomNumber: Number(k),
      members: members.map((m) => ({
        peerId: m.peerId,
        userName: m.userName,
        isHost: m.peerId === s.hostPeerId,
      })),
      isFull: members.length >= s.maxPerRoom,
      capacity: s.maxPerRoom,
    };
  }
  return {
    sessionId,
    hostPeerId: s.hostPeerId,
    numRooms: s.numRooms,
    maxPerRoom: s.maxPerRoom,
    rooms,
  };
}

function broadcastSession(sessionId) {
  const snap = snapshotSession(sessionId);
  if (!snap) return;
  io.to(`session:${sessionId}`).emit('session-state', snap);
}

function leaveCurrentRoom(socket) {
  const d = socket.data;
  if (!d || !d.roomKey) return;

  const s = sessions[d.sessionId];
  if (!s) return;

  const room = s.rooms[d.roomKey];
  if (!room) return;

  const idx = room.findIndex((m) => m.peerId === d.peerId);
  if (idx >= 0) room.splice(idx, 1);

  const roomChannel = `room:${d.sessionId}:${d.roomKey}`;
  socket.leave(roomChannel);

  socket.to(roomChannel).emit('user-disconnected', d.peerId);
  io.to(roomChannel).emit('chat-message', {
    user: '시스템',
    message: `${d.userName}님이 방을 나갔습니다.`,
    time: new Date().toLocaleTimeString('ko-KR'),
    system: true,
  });

  d.roomKey = null;
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  console.log('🔌 Socket 연결:', socket.id);

  // 1단계: 세션 입장 (아직 방 선택 전)
  socket.on('join-session', ({ sessionId, peerId, userName, isHost, numRooms, maxPerRoom }) => {
    if (!sessionId || !peerId || !userName) {
      return socket.emit('error-msg', '세션/닉네임 정보가 부족합니다.');
    }

    const session = getOrCreateSession(sessionId, numRooms, maxPerRoom);

    socket.join(`session:${sessionId}`);
    socket.data = { sessionId, peerId, userName, isHost: !!isHost, roomKey: null };

    if (isHost) {
      session.hostPeerId = peerId;
      console.log(`👑 ${userName}(${peerId}) → [${sessionId}] 호스트`);
    } else {
      console.log(`👤 ${userName}(${peerId}) → [${sessionId}] 참가자`);
    }

    socket.emit('session-joined', snapshotSession(sessionId));
    broadcastSession(sessionId);
  });

  // 2단계: 특정 방 입장
  socket.on('join-room', (roomKey) => {
    const d = socket.data;
    if (!d || !d.sessionId) return;

    const s = sessions[d.sessionId];
    if (!s) return socket.emit('room-error', '세션이 없습니다.');

    const room = s.rooms[roomKey];
    if (!room) return socket.emit('room-error', '존재하지 않는 방입니다.');

    if (room.length >= s.maxPerRoom) {
      return socket.emit('room-error', '방이 꽉 찼습니다.');
    }

    // 이전 방이 있다면 먼저 나가기
    if (d.roomKey) leaveCurrentRoom(socket);

    const roomChannel = `room:${d.sessionId}:${roomKey}`;
    socket.join(roomChannel);

    const existing = room.map((m) => ({
      peerId: m.peerId,
      userName: m.userName,
      isHost: m.peerId === s.hostPeerId,
    }));
    socket.emit('room-joined', { roomKey, existing });

    socket.to(roomChannel).emit('user-connected', {
      peerId: d.peerId,
      userName: d.userName,
      isHost: d.isHost,
    });

    room.push({
      peerId: d.peerId,
      userName: d.userName,
      socketId: socket.id,
      isHost: d.isHost,
    });
    d.roomKey = roomKey;

    io.to(roomChannel).emit('chat-message', {
      user: '시스템',
      message: `${d.userName}${d.isHost ? '(👑호스트)' : ''}님이 입장했습니다.`,
      time: new Date().toLocaleTimeString('ko-KR'),
      system: true,
    });

    broadcastSession(d.sessionId);
  });

  // 방에서만 나가기 (세션 유지)
  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
    const d = socket.data;
    if (d?.sessionId) broadcastSession(d.sessionId);
  });

  // 채팅 (현재 들어있는 방에만 전송)
  socket.on('chat-message', (message) => {
    const d = socket.data;
    if (!d?.roomKey) return;
    const roomChannel = `room:${d.sessionId}:${d.roomKey}`;
    io.to(roomChannel).emit('chat-message', {
      user: d.userName,
      isHost: d.isHost,
      message,
      time: new Date().toLocaleTimeString('ko-KR'),
    });
  });

  socket.on('disconnect', () => {
    const d = socket.data;
    if (!d) return;

    leaveCurrentRoom(socket);

    const s = sessions[d.sessionId];
    if (!s) return;

    if (s.hostPeerId === d.peerId) {
      s.hostPeerId = null;
      console.log(`👑 [${d.sessionId}] 호스트 연결 끊김`);
    }

    const total = Object.values(s.rooms).reduce((sum, r) => sum + r.length, 0);
    if (total === 0 && !s.hostPeerId) {
      delete sessions[d.sessionId];
      console.log(`🗑️  세션 [${d.sessionId}] 삭제됨`);
    } else {
      broadcastSession(d.sessionId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 서버 실행: http://localhost:${PORT}\n`);
});
