
import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false }
});

const PORT = Number(process.env.PORT || 3000);
const HB_API_KEY = process.env.HB_API_KEY?.trim();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// v1 state is kept in memory. Restarting the server resets active rooms.
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      browser: null,
      creatingBrowser: null,
      members: new Map(),
      createdAt: Date.now()
    });
  }
  return rooms.get(roomId);
}

function sanitizeRoomId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
}

function publicMembers(room) {
  return [...room.members.entries()].map(([id, member]) => ({
    id,
    name: member.name,
    joinedAt: member.joinedAt
  }));
}

async function createHyperbeamSession(roomId) {
  if (!HB_API_KEY) {
    const err = new Error('Hyperbeam is not configured yet. Add HB_API_KEY to your .env file.');
    err.status = 503;
    throw err;
  }

  const response = await fetch('https://engine.hyperbeam.com/v0/vm', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HB_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      start_url: 'https://www.netflix.com/',
      kiosk: false,
      dark: true,
      width: 1600,
      height: 900,
      tag: `movie-night-${roomId}`
    })
  });

  const bodyText = await response.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = null;
  }

  if (!response.ok || !data?.embed_url) {
    const message = data?.message || data?.error || bodyText || `Hyperbeam request failed (${response.status})`;
    const err = new Error(message);
    err.status = 502;
    throw err;
  }

  return {
    sessionId: data.session_id,
    embedUrl: data.embed_url,
    adminToken: data.admin_token,
    createdAt: Date.now()
  };
}

app.post('/api/rooms/:roomId/browser', async (req, res) => {
  const roomId = sanitizeRoomId(req.params.roomId);
  if (!roomId) return res.status(400).json({ error: 'Invalid room code.' });

  const room = getRoom(roomId);

  if (room.browser?.embedUrl) {
    return res.json({ embedUrl: room.browser.embedUrl, reused: true });
  }

  try {
    if (!room.creatingBrowser) {
      room.creatingBrowser = createHyperbeamSession(roomId)
        .then((browser) => {
          room.browser = browser;
          io.to(roomId).emit('browser-ready', { embedUrl: browser.embedUrl });
          return browser;
        })
        .finally(() => {
          room.creatingBrowser = null;
        });
    }

    const browser = await room.creatingBrowser;
    return res.json({ embedUrl: browser.embedUrl, reused: false });
  } catch (error) {
    console.error('Hyperbeam create error:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Could not start shared browser.' });
  }
});

app.get('/api/rooms/:roomId/status', (req, res) => {
  const roomId = sanitizeRoomId(req.params.roomId);
  const room = rooms.get(roomId);
  res.json({
    exists: Boolean(room),
    browserReady: Boolean(room?.browser?.embedUrl),
    embedUrl: room?.browser?.embedUrl || null,
    memberCount: room?.members.size || 0
  });
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId: rawRoomId, name: rawName }) => {
    const roomId = sanitizeRoomId(rawRoomId);
    const name = String(rawName || 'Guest').trim().slice(0, 24) || 'Guest';
    if (!roomId) return;

    const room = getRoom(roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    room.members.set(socket.id, {
      name,
      joinedAt: Date.now()
    });

    socket.emit('room-state', {
      roomId,
      members: publicMembers(room),
      embedUrl: room.browser?.embedUrl || null
    });

    socket.to(roomId).emit('member-joined', {
      id: socket.id,
      name
    });

    io.to(roomId).emit('members', publicMembers(room));
  });

  socket.on('chat-message', ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean) return;

    io.to(roomId).emit('chat-message', {
      id: crypto.randomUUID(),
      senderId: socket.id,
      name: socket.data.name || 'Guest',
      text: clean,
      time: Date.now()
    });
  });

  socket.on('reaction', ({ emoji }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const allowed = new Set(['❤️', '😂', '😮', '🥺', '🔥', '😘']);
    if (!allowed.has(emoji)) return;
    io.to(roomId).emit('reaction', {
      emoji,
      name: socket.data.name || 'Guest'
    });
  });

  // Lightweight WebRTC signaling. Media itself remains peer-to-peer.
  socket.on('call-ready', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('peer-call-ready', { peerId: socket.id });
  });

  socket.on('webrtc-offer', ({ target, sdp }) => {
    if (!target || !sdp) return;
    io.to(target).emit('webrtc-offer', { from: socket.id, sdp });
  });

  socket.on('webrtc-answer', ({ target, sdp }) => {
    if (!target || !sdp) return;
    io.to(target).emit('webrtc-answer', { from: socket.id, sdp });
  });

  socket.on('webrtc-ice', ({ target, candidate }) => {
    if (!target || !candidate) return;
    io.to(target).emit('webrtc-ice', { from: socket.id, candidate });
  });

  socket.on('hang-up', () => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit('peer-hung-up', { peerId: socket.id });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.members.delete(socket.id);
    socket.to(roomId).emit('member-left', { id: socket.id, name: socket.data.name || 'Guest' });
    io.to(roomId).emit('members', publicMembers(room));

    // Keep the room/browser alive for reconnects. Empty room metadata is
    // removed after six hours if no browser was ever created.
    if (room.members.size === 0 && !room.browser) {
      setTimeout(() => {
        const latest = rooms.get(roomId);
        if (latest && latest.members.size === 0 && !latest.browser) rooms.delete(roomId);
      }, 6 * 60 * 60 * 1000).unref();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Movie Night running on http://localhost:${PORT}`);
  if (!HB_API_KEY) console.log('Tip: add HB_API_KEY to .env before starting a shared browser.');
});
