// public/script.js
// 흐름: 입장 → 세션 참가 → 방 목록(대시보드) → 방 입장 → 미팅
// 호스트는 어느 방이든 들어가/나가서 다른 방으로 이동 가능

const $ = (id) => document.getElementById(id);

// ===== DOM 요소 =====
const joinScreen = $('join-screen');
const gridScreen = $('grid-screen');
const meetingScreen = $('meeting-screen');

const sessionIdInput = $('sessionId');
const userNameInput = $('userName');
const numRoomsInput = $('numRooms');
const maxPerRoomInput = $('maxPerRoom');
const joinAsParticipantBtn = $('joinAsParticipantBtn');
const joinAsHostBtn = $('joinAsHostBtn');

const gridTitle = $('gridTitle');
const hostBadge = $('hostBadge');
const hostHint = $('hostHint');
const gridSessionId = $('gridSessionId');
const gridUserName = $('gridUserName');
const roomGrid = $('roomGrid');
const exitSessionBtn = $('exitSessionBtn');

const backToGridBtn = $('backToGridBtn');
const currentRoomLabel = $('currentRoomLabel');
const userCount = $('userCount');
const meetingHostBadge = $('meetingHostBadge');
const leaveBtn = $('leaveBtn');

const shareBtn = $('shareBtn');
const shareLabel = $('shareLabel');
const micBtn = $('micBtn');
const micIcon = $('micIcon');
const micLabel = $('micLabel');

const sendBtn = $('sendBtn');
const chatInput = $('chatInput');
const messages = $('messages');
const videosEl = $('videos');
const placeholder = $('placeholder');

// ===== 상태 =====
let socket = null;
let peer = null;
let myPeerId = null;
let myUserName = null;
let mySessionId = null;
let isHost = false;

let currentRoom = null;     // 지금 들어가 있는 방 번호
let sessionState = null;    // 마지막 세션 스냅샷

let screenStream = null;
let micStream = null;

let activeCalls = {};       // peerId -> 내가 발신 중인 통화
let incomingCalls = {};     // peerId -> 내가 수신한 통화
let knownPeers = {};        // 현재 방의 다른 멤버: { peerId: { userName, isHost } }
let remoteVideos = {};      // 화면에 표시 중인 원격 비디오: { peerId: wrapperDiv }

// ===== 화면 전환 =====
function showScreen(name) {
  joinScreen.classList.toggle('hidden', name !== 'join');
  gridScreen.classList.toggle('hidden', name !== 'grid');
  meetingScreen.classList.toggle('hidden', name !== 'meeting');
  meetingScreen.classList.toggle('flex', name === 'meeting');
}

// ===== 입장 =====
joinAsParticipantBtn.addEventListener('click', () => joinSession(false));
joinAsHostBtn.addEventListener('click', () => joinSession(true));
[sessionIdInput, userNameInput].forEach((el) =>
  el.addEventListener('keypress', (e) => { if (e.key === 'Enter') joinSession(false); })
);

function joinSession(asHost) {
  const sessionId = sessionIdInput.value.trim();
  const userName = userNameInput.value.trim();

  if (!sessionId || !userName) {
    alert('세션 이름과 닉네임을 모두 입력해 주세요.');
    return;
  }

  mySessionId = sessionId;
  myUserName = userName;
  isHost = asHost;

  // PeerJS 연결
  // public/script.js 수정

// 기존 코드를 지우고 아래 내용으로 교체하세요
  peer = new Peer(undefined, {
    host: location.hostname,
    port: location.protocol === 'https:' ? 443 : (location.port || 80),
    path: '/peerjs',
    secure: location.protocol === 'https:'
  });

  peer.on('open', (id) => {
    myPeerId = id;
    console.log('✅ PeerJS ID:', id);

    // public/script.js 수정
    socket = io({
      transports: ['websocket', 'polling'] // 연결 안정성을 위해 추가
  });

    socket.emit('join-session', {
      sessionId,
      peerId: myPeerId,
      userName,
      isHost: asHost,
      numRooms: asHost ? parseInt(numRoomsInput.value, 10) || 9 : undefined,
      maxPerRoom: asHost ? parseInt(maxPerRoomInput.value, 10) || 4 : undefined,
    });
  });

  peer.on('error', (err) => {
    console.error('PeerJS 오류:', err);
    alert('연결 오류: ' + (err.type || err.message));
  });

  // 모든 들어오는 통화 처리 (방 안에서만 유효)
  peer.on('call', (call) => {
    // 현재 같은 방에 있는 멤버에서 온 통화만 응답
    if (!knownPeers[call.peer]) {
      console.log('알 수 없는 피어 통화 무시:', call.peer);
      return;
    }
    console.log('📞 통화 수신:', call.peer);
    call.answer();
    incomingCalls[call.peer] = call;
    call.on('stream', (stream) => showRemoteVideo(call.peer, stream));
    call.on('close', () => {
      removeRemoteVideo(call.peer);
      delete incomingCalls[call.peer];
    });
  });
}

// ===== Socket 이벤트 =====
function setupSocketHandlers() {
  socket.on('session-joined', (state) => {
    sessionState = state;
    enterGridScreen();
  });

  socket.on('session-state', (state) => {
    sessionState = state;
    if (!meetingScreen.classList.contains('hidden')) return; // 미팅 중이면 다시 그리지 않음
    renderRoomGrid();
  });

  socket.on('room-joined', ({ roomKey, existing }) => {
    currentRoom = roomKey;
    knownPeers = {};
    existing.forEach((u) => { knownPeers[u.peerId] = { userName: u.userName, isHost: u.isHost }; });
    enterMeetingScreen(roomKey);
  });

  socket.on('room-error', (msg) => alert('⚠️ ' + msg));

  socket.on('user-connected', ({ peerId, userName, isHost: theirIsHost }) => {
    console.log('👤 입장:', userName);
    knownPeers[peerId] = { userName, isHost: theirIsHost };
    updateUserCount();

    // 내가 공유 중이라면 새 멤버에게도 호출
    if (hasOutgoingMedia()) setTimeout(() => callPeer(peerId), 600);
  });

  socket.on('user-disconnected', (peerId) => {
    console.log('👋 퇴장:', peerId);
    delete knownPeers[peerId];
    removeRemoteVideo(peerId);
    if (activeCalls[peerId]) { activeCalls[peerId].close(); delete activeCalls[peerId]; }
    updateUserCount();
  });

  socket.on('chat-message', addChatMessage);

  socket.on('error-msg', (msg) => alert(msg));
}

// ===== 방 목록(대시보드) =====
function enterGridScreen() {
  showScreen('grid');
  gridSessionId.textContent = mySessionId;
  gridUserName.textContent = myUserName;

  if (isHost) {
    gridTitle.textContent = '방 대시보드';
    hostBadge.classList.remove('hidden');
    hostHint.classList.remove('hidden');
  } else {
    gridTitle.textContent = '방 선택';
  }
  renderRoomGrid();
}

function renderRoomGrid() {
  if (!sessionState) return;
  roomGrid.innerHTML = '';

  const sortedRooms = Object.values(sessionState.rooms).sort((a, b) => a.roomNumber - b.roomNumber);

  sortedRooms.forEach((room) => {
    const isFull = room.isFull;
    const card = document.createElement('div');
    card.className =
      `bg-gray-800 rounded-lg p-4 border-2 ${isFull ? 'border-red-700/60' : 'border-gray-700 hover:border-blue-500'} transition`;

    const memberHtml = room.members.length > 0
      ? room.members
          .map((m) => `<li class="truncate">${m.isHost ? '👑 ' : '• '}${escapeHtml(m.userName)}</li>`)
          .join('')
      : '<li class="text-gray-500 italic">비어있음</li>';

    card.innerHTML = `
      <div class="flex justify-between items-center mb-2">
        <h3 class="font-bold text-lg">방 ${room.roomNumber}</h3>
        <span class="text-sm font-medium ${isFull ? 'text-red-400' : 'text-green-400'}">
          ${room.members.length}/${room.capacity}
        </span>
      </div>
      <ul class="text-sm text-gray-300 mb-3 space-y-1 min-h-[3rem]">${memberHtml}</ul>
      <button data-room="${room.roomNumber}"
        class="w-full py-2 rounded font-semibold text-sm transition
        ${isFull ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 text-white'}"
        ${isFull ? 'disabled' : ''}>
        ${isFull ? '꽉 참' : '입장'}
      </button>
    `;

    if (!isFull) {
      card.querySelector('button').addEventListener('click', () => {
        socket.emit('join-room', room.roomNumber);
      });
    }
    roomGrid.appendChild(card);
  });
}

// ===== 미팅 화면 =====
function enterMeetingScreen(roomKey) {
  showScreen('meeting');
  currentRoomLabel.textContent = `방 ${roomKey}`;
  meetingHostBadge.classList.toggle('hidden', !isHost);

  // 메시지/원격 비디오 초기화 (방마다 깨끗하게)
  messages.innerHTML = '';
  Object.values(remoteVideos).forEach((el) => el.remove());
  remoteVideos = {};

  // 이전 방의 통화 정리
  Object.values(activeCalls).forEach((c) => c.close());
  Object.values(incomingCalls).forEach((c) => c.close());
  activeCalls = {};
  incomingCalls = {};

  // 본인이 공유 중이던 화면은 유지 (호스트가 방 이동해도 공유 지속 가능)
  if (screenStream) showLocalVideo(screenStream);
  else removeLocalVideo();

  updateUserCount();
  togglePlaceholder();

  // 공유 중이면 새 방 멤버들에게 다시 호출
  if (hasOutgoingMedia()) setTimeout(() => updateAllCalls(), 500);
}

// "← 방 목록" 버튼
backToGridBtn.addEventListener('click', () => {
  // 통화 정리
  Object.values(activeCalls).forEach((c) => c.close());
  Object.values(incomingCalls).forEach((c) => c.close());
  activeCalls = {};
  incomingCalls = {};
  knownPeers = {};

  // 원격 비디오 정리 (로컬 스트림 자체는 유지)
  Object.values(remoteVideos).forEach((el) => el.remove());
  remoteVideos = {};
  removeLocalVideo();

  socket.emit('leave-room');
  currentRoom = null;
  showScreen('grid');
  renderRoomGrid();
});

// 세션 자체 종료
exitSessionBtn.addEventListener('click', confirmExit);
leaveBtn.addEventListener('click', confirmExit);

function confirmExit() {
  if (confirm('세션에서 완전히 나가시겠습니까?')) window.location.reload();
}

function updateUserCount() {
  userCount.textContent = Object.keys(knownPeers).length + 1; // +1 = 나
}

// ===== 화면 공유 =====
shareBtn.addEventListener('click', toggleScreenShare);
async function toggleScreenShare() {
  if (screenStream) stopScreenShare();
  else await startScreenShare();
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: true,
    });
    screenStream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);

    showLocalVideo(screenStream);
    shareBtn.classList.replace('bg-blue-600', 'bg-red-600');
    shareBtn.classList.replace('hover:bg-blue-500', 'hover:bg-red-500');
    shareLabel.textContent = '공유 중지';

    await updateAllCalls();
  } catch (err) {
    console.error('화면 공유 실패:', err);
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      alert('화면 공유 실패: ' + err.message);
    }
  }
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  removeLocalVideo();
  shareBtn.classList.replace('bg-red-600', 'bg-blue-600');
  shareBtn.classList.replace('hover:bg-red-500', 'hover:bg-blue-500');
  shareLabel.textContent = '화면 공유';
  updateAllCalls();
}

// ===== 마이크 =====
micBtn.addEventListener('click', toggleMic);
async function toggleMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    micIcon.textContent = '🎤';
    micLabel.textContent = '마이크 켜기';
    micBtn.classList.remove('bg-green-600', 'hover:bg-green-500');
    micBtn.classList.add('bg-gray-700', 'hover:bg-gray-600');
  } else {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      micIcon.textContent = '🔴';
      micLabel.textContent = '마이크 끄기';
      micBtn.classList.remove('bg-gray-700', 'hover:bg-gray-600');
      micBtn.classList.add('bg-green-600', 'hover:bg-green-500');
    } catch (err) {
      alert('마이크 접근 실패: ' + err.message);
      return;
    }
  }
  await updateAllCalls();
}

// ===== 송출 스트림 =====
function buildOutgoingStream() {
  const tracks = [];
  if (screenStream) {
    screenStream.getVideoTracks().forEach((t) => tracks.push(t));
    screenStream.getAudioTracks().forEach((t) => tracks.push(t));
  }
  if (micStream) micStream.getAudioTracks().forEach((t) => tracks.push(t));
  return tracks.length > 0 ? new MediaStream(tracks) : null;
}
function hasOutgoingMedia() { return !!(screenStream || micStream); }

async function updateAllCalls() {
  Object.values(activeCalls).forEach((c) => c.close());
  activeCalls = {};
  if (!hasOutgoingMedia()) return;
  Object.keys(knownPeers).forEach((peerId) => callPeer(peerId));
}

function callPeer(peerId) {
  const out = buildOutgoingStream();
  if (!out || !peer) return;
  const call = peer.call(peerId, out);
  if (!call) return;
  activeCalls[peerId] = call;
  call.on('stream', (stream) => showRemoteVideo(peerId, stream));
  call.on('close', () => { delete activeCalls[peerId]; });
}

// ===== 비디오 표시 =====
function showLocalVideo(stream) {
  removeLocalVideo();
  const wrapper = document.createElement('div');
  wrapper.id = 'local-video-wrapper';
  wrapper.className = 'relative bg-black rounded-lg overflow-hidden aspect-video';

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.className = 'w-full h-full object-contain';

  const label = document.createElement('div');
  label.className = 'absolute top-2 left-2 bg-black/70 px-2 py-1 rounded text-xs';
  label.textContent = `🟢 ${myUserName} (나)${isHost ? ' 👑' : ''}`;

  wrapper.appendChild(video);
  wrapper.appendChild(label);
  videosEl.appendChild(wrapper);
  togglePlaceholder();
}

function removeLocalVideo() {
  const el = document.getElementById('local-video-wrapper');
  if (el) el.remove();
  togglePlaceholder();
}

function showRemoteVideo(peerId, stream) {
  if (remoteVideos[peerId]) {
    remoteVideos[peerId].querySelector('video').srcObject = stream;
    return;
  }
  const peerInfo = knownPeers[peerId];
  const wrapper = document.createElement('div');
  wrapper.className = 'relative bg-black rounded-lg overflow-hidden aspect-video';

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.className = 'w-full h-full object-contain';

  const label = document.createElement('div');
  label.className = 'absolute top-2 left-2 bg-black/70 px-2 py-1 rounded text-xs';
  label.textContent = `🔵 ${peerInfo?.userName || '?'}${peerInfo?.isHost ? ' 👑' : ''}`;

  wrapper.appendChild(video);
  wrapper.appendChild(label);
  videosEl.appendChild(wrapper);
  remoteVideos[peerId] = wrapper;
  togglePlaceholder();
}

function removeRemoteVideo(peerId) {
  if (remoteVideos[peerId]) {
    remoteVideos[peerId].remove();
    delete remoteVideos[peerId];
  }
  togglePlaceholder();
}

function togglePlaceholder() {
  const hasVideo = videosEl.querySelectorAll('video').length > 0;
  placeholder.style.display = hasVideo ? 'none' : 'flex';
}

// ===== 채팅 =====
sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg || !socket) return;
  socket.emit('chat-message', msg);
  chatInput.value = '';
}

function addChatMessage({ user, isHost: msgIsHost, message, time, system }) {
  const div = document.createElement('div');

  if (system) {
    div.className = 'text-center text-xs text-gray-500 italic';
    div.textContent = message;
  } else {
    const isMe = user === myUserName;
    const displayName = `${user}${msgIsHost ? ' 👑' : ''}`;
    div.className = `flex flex-col ${isMe ? 'items-end' : 'items-start'}`;
    div.innerHTML = `
      <div class="text-xs text-gray-400 mb-1">
        ${escapeHtml(displayName)} <span class="text-gray-500">${time}</span>
      </div>
      <div class="px-3 py-2 rounded-lg max-w-[85%] break-words ${isMe ? 'bg-blue-600' : 'bg-gray-700'}">
        ${escapeHtml(message)}
      </div>
    `;
  }

  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

togglePlaceholder();
