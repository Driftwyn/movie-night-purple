
import Hyperbeam from 'https://unpkg.com/@hyperbeam/web@latest/dist/index.js';

const socket = io();

const $ = (id) => document.getElementById(id);
const state = {
  roomId: new URLSearchParams(location.search).get('room')?.toLowerCase() || '',
  name: sessionStorage.getItem('movieNightName') || '',
  hb: null,
  localStream: null,
  peer: null,
  peerId: null,
  muted: false,
  cameraOn: false
};

const landing = $('landing');
const roomApp = $('roomApp');
const nameModal = $('nameModal');
const browserContainer = $('browserContainer');
const browserEmpty = $('browserEmpty');
const browserStatus = $('browserStatus');
const startBrowserBtn = $('startBrowserBtn');
const chatMessages = $('chatMessages');

function randomRoomCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

function normalizeRoomCode(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

function goToRoom(roomId) {
  const code = normalizeRoomCode(roomId);
  if (!code) return showToast('Enter a valid room code.');
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  location.href = url.toString();
}

function showToast(text, duration = 2200) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function setRoomView() {
  landing.classList.add('hidden');
  roomApp.classList.remove('hidden');
  $('roomLabel').textContent = `Room ${state.roomId}`;

  if (!state.name) nameModal.classList.remove('hidden');
  else joinSocketRoom();
}

function joinSocketRoom() {
  nameModal.classList.add('hidden');
  socket.emit('join-room', { roomId: state.roomId, name: state.name });
}

function renderMembers(members) {
  $('presenceText').textContent = `${members.length} connected`;
  $('memberCountBadge').textContent = members.length;
  const wrap = $('membersList');
  wrap.innerHTML = '';

  for (const member of members) {
    const item = document.createElement('div');
    item.className = 'member';
    const initial = (member.name || '?').trim().charAt(0).toUpperCase();
    item.innerHTML = `
      <div class="avatar">${escapeHtml(initial)}</div>
      <div>
        <div class="member-name">${escapeHtml(member.name)}${member.id === socket.id ? ' · You' : ''}</div>
        <div class="member-status">online</div>
      </div>`;
    wrap.appendChild(item);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function appendChat(message) {
  const row = document.createElement('div');
  const mine = message.senderId === socket.id;
  row.className = `message${mine ? ' mine' : ''}`;
  const time = new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `
    <div class="message-meta">${mine ? 'You' : escapeHtml(message.name)} · ${time}</div>
    <div class="message-bubble">${escapeHtml(message.text)}</div>`;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const row = document.createElement('div');
  row.className = 'system-msg';
  row.textContent = text;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showReaction({ emoji, name }) {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.title = name;
  el.style.left = `${10 + Math.random() * 80}%`;
  $('reactionLayer').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

async function mountHyperbeam(embedUrl) {
  if (!embedUrl || state.hb) return;
  try {
    browserStatus.textContent = 'Connecting to the shared browser…';
    if (browserEmpty) browserEmpty.classList.add('hidden');

    state.hb = await Hyperbeam(browserContainer, embedUrl, {
      onConnectionStateChange: (event) => {
        if (event.state === 'playing') showToast('Shared browser connected ♥');
        if (event.state === 'reconnecting') showToast('Reconnecting shared browser…');
      }
    });
  } catch (error) {
    console.error(error);
    state.hb = null;
    browserEmpty?.classList.remove('hidden');
    browserStatus.textContent = `Could not connect: ${error.message || error}`;
  }
}

async function startSharedBrowser() {
  startBrowserBtn.disabled = true;
  browserStatus.textContent = 'Starting your private cloud browser…';
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/browser`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start browser.');
    await mountHyperbeam(data.embedUrl);
  } catch (error) {
    browserStatus.textContent = error.message;
    showToast(error.message, 4200);
  } finally {
    startBrowserBtn.disabled = false;
  }
}

function rtcConfig() {
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
}

async function ensureLocalMedia() {
  if (state.localStream) return state.localStream;
  state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  $('localVideo').srcObject = state.localStream;
  state.cameraOn = false;
  return state.localStream;
}

async function ensurePeer(targetId) {
  if (state.peer && state.peerId === targetId) return state.peer;
  closePeer();
  state.peerId = targetId;
  const pc = new RTCPeerConnection(rtcConfig());
  state.peer = pc;

  const stream = await ensureLocalMedia();
  for (const track of stream.getTracks()) pc.addTrack(track, stream);

  pc.ontrack = (event) => {
    $('remoteVideo').srcObject = event.streams[0];
    $('callPanel').classList.remove('hidden');
  };
  pc.onicecandidate = (event) => {
    if (event.candidate && state.peerId) {
      socket.emit('webrtc-ice', { target: state.peerId, candidate: event.candidate });
    }
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      if (pc.connectionState === 'failed') showToast('Call connection failed. Try calling again.');
    }
  };
  return pc;
}

async function startCall() {
  try {
    await ensureLocalMedia();
    $('callPanel').classList.remove('hidden');
    $('callBtn').classList.add('hidden');
    $('muteBtn').classList.remove('hidden');
    $('cameraBtn').classList.remove('hidden');
    $('hangupBtn').classList.remove('hidden');
    socket.emit('call-ready');
    showToast('Call ready — waiting for your partner.');
  } catch (error) {
    showToast('Microphone permission is needed for the call.', 3500);
  }
}

async function makeOffer(peerId) {
  const pc = await ensurePeer(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-offer', { target: peerId, sdp: pc.localDescription });
}

function closePeer() {
  if (state.peer) {
    state.peer.onicecandidate = null;
    state.peer.ontrack = null;
    state.peer.close();
  }
  state.peer = null;
  state.peerId = null;
  $('remoteVideo').srcObject = null;
}

function hangUp(notify = true) {
  if (notify) socket.emit('hang-up');
  closePeer();

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  $('localVideo').srcObject = null;
  $('callPanel').classList.add('hidden');
  $('callBtn').classList.remove('hidden');
  $('muteBtn').classList.add('hidden');
  $('cameraBtn').classList.add('hidden');
  $('hangupBtn').classList.add('hidden');
  state.muted = false;
  state.cameraOn = false;
  $('muteBtn').textContent = 'Mic on';
  $('cameraBtn').textContent = 'Camera off';
}

async function toggleCamera() {
  if (!state.localStream) return;
  try {
    let videoTrack = state.localStream.getVideoTracks()[0];
    if (!videoTrack) {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoTrack = cameraStream.getVideoTracks()[0];
      state.localStream.addTrack(videoTrack);
      $('localVideo').srcObject = state.localStream;
      if (state.peer) {
        state.peer.addTrack(videoTrack, state.localStream);
        // Renegotiate after adding video.
        const offer = await state.peer.createOffer();
        await state.peer.setLocalDescription(offer);
        socket.emit('webrtc-offer', { target: state.peerId, sdp: state.peer.localDescription });
      }
      state.cameraOn = true;
    } else {
      videoTrack.enabled = !videoTrack.enabled;
      state.cameraOn = videoTrack.enabled;
    }
    $('cameraBtn').textContent = state.cameraOn ? 'Camera on' : 'Camera off';
  } catch {
    showToast('Camera permission was not granted.');
  }
}

$('createRoomBtn').addEventListener('click', () => goToRoom(randomRoomCode()));
$('joinRoomBtn').addEventListener('click', () => goToRoom($('joinCode').value));
$('joinCode').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') goToRoom($('joinCode').value);
});

$('nameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  state.name = $('displayName').value.trim().slice(0, 24);
  if (!state.name) return;
  sessionStorage.setItem('movieNightName', state.name);
  joinSocketRoom();
});

$('copyInviteBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('Invite link copied ♥');
  } catch {
    showToast(`Room code: ${state.roomId}`);
  }
});

$('leaveBtn').addEventListener('click', () => {
  hangUp(false);
  const url = new URL(location.href);
  url.searchParams.delete('room');
  location.href = url.toString();
});

startBrowserBtn.addEventListener('click', startSharedBrowser);

$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  input.value = '';
});

document.querySelectorAll('[data-emoji]').forEach((button) => {
  button.addEventListener('click', () => socket.emit('reaction', { emoji: button.dataset.emoji }));
});

$('callBtn').addEventListener('click', startCall);
$('hangupBtn').addEventListener('click', () => hangUp(true));
$('muteBtn').addEventListener('click', () => {
  const audio = state.localStream?.getAudioTracks()[0];
  if (!audio) return;
  audio.enabled = !audio.enabled;
  state.muted = !audio.enabled;
  $('muteBtn').textContent = state.muted ? 'Mic off' : 'Mic on';
});
$('cameraBtn').addEventListener('click', toggleCamera);

socket.on('room-state', async ({ members, embedUrl }) => {
  renderMembers(members);
  if (embedUrl) await mountHyperbeam(embedUrl);
});

socket.on('members', renderMembers);
socket.on('member-joined', ({ name }) => addSystemMessage(`${name} joined the room ♥`));
socket.on('member-left', ({ name }) => addSystemMessage(`${name} left the room.`));
socket.on('chat-message', appendChat);
socket.on('reaction', showReaction);
socket.on('browser-ready', ({ embedUrl }) => mountHyperbeam(embedUrl));

socket.on('peer-call-ready', async ({ peerId }) => {
  if (!state.localStream) return;
  // Existing caller initiates when the other person becomes ready.
  try { await makeOffer(peerId); } catch (error) { console.error(error); }
});

socket.on('webrtc-offer', async ({ from, sdp }) => {
  try {
    // If the receiver hasn't pressed Start call yet, ask for mic now so
    // accepting a call remains a one-click experience after room entry.
    if (!state.localStream) {
      await ensureLocalMedia();
      $('callPanel').classList.remove('hidden');
      $('callBtn').classList.add('hidden');
      $('muteBtn').classList.remove('hidden');
      $('cameraBtn').classList.remove('hidden');
      $('hangupBtn').classList.remove('hidden');
    }
    const pc = await ensurePeer(from);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { target: from, sdp: pc.localDescription });
  } catch (error) {
    console.error(error);
    showToast('Could not answer the call. Check microphone permission.');
  }
});

socket.on('webrtc-answer', async ({ from, sdp }) => {
  if (!state.peer || state.peerId !== from) return;
  try { await state.peer.setRemoteDescription(sdp); } catch (error) { console.error(error); }
});

socket.on('webrtc-ice', async ({ from, candidate }) => {
  if (!state.peer || state.peerId !== from) {
    try { await ensurePeer(from); } catch { return; }
  }
  try { await state.peer.addIceCandidate(candidate); } catch (error) { console.error(error); }
});

socket.on('peer-hung-up', () => {
  closePeer();
  showToast('Your partner ended the call.');
});

if (state.roomId) setRoomView();
else {
  landing.classList.remove('hidden');
  roomApp.classList.add('hidden');
}
