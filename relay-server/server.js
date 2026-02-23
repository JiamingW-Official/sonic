/**
 * Sonic Relay Server — WebSocket relay for multi-device remote control.
 * Manages rooms, slot assignments, queues, and message forwarding.
 * All audio processing stays on the desktop host; this server only relays JSON.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// CORS: allow desktop hosts from any origin
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 12000,
  pingTimeout: 8000
});

// Serve mobile client pages (no-cache to ensure latest version)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Room state ──
const rooms = new Map();

function genRoomId() {
  return crypto.randomBytes(3).toString('hex'); // 6-char hex
}

function broadcastSlots(room) {
  const slotData = {};
  for (const s of ['instrument', 'mixer', 'fx', 'drums', 'keys']) {
    const occ = room.slots[s];
    slotData[s] = occ ? { socketId: occ.socketId, username: occ.username } : null;
  }
  const queueData = room.queue.map(q => ({
    socketId: q.socketId,
    username: q.username,
    requestedSlot: q.requestedSlot
  }));

  // Tell host
  io.to(room.hostSocketId).emit('room:slot-changed', { slots: slotData, queue: queueData });

  // Tell each client their personal view
  for (const [sid, client] of room.clients) {
    io.to(sid).emit('client:room-state', {
      slots: slotData,
      queue: queueData,
      yourSlot: client.currentSlot
    });
  }
}

function removeClientFromRoom(room, socketId) {
  const client = room.clients.get(socketId);
  if (!client) return;

  // Release slot if occupied
  for (const s of ['instrument', 'mixer', 'fx', 'drums', 'keys']) {
    if (room.slots[s] && room.slots[s].socketId === socketId) {
      room.slots[s] = null;
    }
  }
  // Remove from queue
  room.queue = room.queue.filter(q => q.socketId !== socketId);
  room.clients.delete(socketId);

  // Notify host
  io.to(room.hostSocketId).emit('room:client-left', {
    socketId,
    username: client.username
  });

  broadcastSlots(room);
}

function findRoomByClient(socketId) {
  for (const [, room] of rooms) {
    if (room.clients.has(socketId)) return room;
  }
  return null;
}

function findRoomByHost(socketId) {
  for (const [, room] of rooms) {
    if (room.hostSocketId === socketId) return room;
  }
  return null;
}

// ── Socket.io handlers ──
io.on('connection', (socket) => {
  // === HOST EVENTS ===

  socket.on('host:create-room', (_, cb) => {
    // Clean up any old room this host had
    const old = findRoomByHost(socket.id);
    if (old) {
      for (const [sid] of old.clients) {
        io.to(sid).emit('client:kicked', { reason: 'Room closed' });
      }
      rooms.delete(old.roomId);
    }

    const roomId = genRoomId();
    const room = {
      roomId,
      hostSocketId: socket.id,
      slots: { instrument: null, mixer: null, fx: null, drums: null, keys: null },
      queue: [],
      clients: new Map()
    };
    rooms.set(roomId, room);
    socket.join('room:' + roomId);

    if (typeof cb === 'function') cb({ roomId });
  });

  socket.on('host:kick', (data) => {
    const room = findRoomByHost(socket.id);
    if (!room || !data || !data.socketId) return;
    const target = room.clients.get(data.socketId);
    if (!target) return;

    io.to(data.socketId).emit('client:kicked', { reason: 'Kicked by admin' });
    removeClientFromRoom(room, data.socketId);
  });

  socket.on('host:state-sync', (data) => {
    const room = findRoomByHost(socket.id);
    if (!room) return;
    // Forward to all clients
    for (const [sid] of room.clients) {
      io.to(sid).emit('client:state-sync', data);
    }
  });

  socket.on('host:state-update', (data) => {
    const room = findRoomByHost(socket.id);
    if (!room) return;
    for (const [sid] of room.clients) {
      io.to(sid).emit('client:state-update', data);
    }
  });

  socket.on('host:meter-update', (data) => {
    const room = findRoomByHost(socket.id);
    if (!room) return;
    // Only send to mixer client
    if (room.slots.mixer) {
      io.to(room.slots.mixer.socketId).emit('client:meter-update', data);
    }
  });

  // === CLIENT EVENTS ===

  socket.on('client:join-room', (data, cb) => {
    if (!data || !data.roomId || !data.username) {
      if (typeof cb === 'function') cb({ error: 'Missing roomId or username' });
      return;
    }
    const room = rooms.get(data.roomId);
    if (!room) {
      if (typeof cb === 'function') cb({ error: 'Room not found' });
      return;
    }

    // Already in this room?
    if (room.clients.has(socket.id)) {
      if (typeof cb === 'function') cb({ ok: true });
      return;
    }

    room.clients.set(socket.id, {
      username: data.username.slice(0, 20),
      currentSlot: null
    });
    socket.join('room:' + room.roomId);

    io.to(room.hostSocketId).emit('room:client-joined', {
      socketId: socket.id,
      username: data.username.slice(0, 20)
    });

    broadcastSlots(room);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('client:request-slot', (data, cb) => {
    const room = findRoomByClient(socket.id);
    if (!room || !data || !data.slot) return;
    const slot = data.slot;
    if (!['instrument', 'mixer', 'fx', 'drums', 'keys'].includes(slot)) return;

    const client = room.clients.get(socket.id);
    if (!client) return;

    // Release current slot first
    if (client.currentSlot) {
      for (const s of ['instrument', 'mixer', 'fx', 'drums', 'keys']) {
        if (room.slots[s] && room.slots[s].socketId === socket.id) {
          room.slots[s] = null;
        }
      }
      client.currentSlot = null;
    }
    // Remove from queue
    room.queue = room.queue.filter(q => q.socketId !== socket.id);

    if (!room.slots[slot]) {
      // Slot available
      room.slots[slot] = { socketId: socket.id, username: client.username };
      client.currentSlot = slot;
      socket.emit('client:slot-granted', { slot });
      broadcastSlots(room);
      // Ask host to send state sync for this slot
      io.to(room.hostSocketId).emit('room:slot-changed', {
        slots: buildSlotData(room),
        queue: buildQueueData(room),
        requestSync: slot
      });
      if (typeof cb === 'function') cb({ granted: true, slot });
    } else {
      // Slot occupied, add to queue
      room.queue.push({
        socketId: socket.id,
        username: client.username,
        requestedSlot: slot,
        requestedAt: Date.now()
      });
      socket.emit('client:slot-denied', {
        reason: 'Slot occupied',
        queuePos: room.queue.length
      });
      broadcastSlots(room);
      if (typeof cb === 'function') cb({ granted: false, queuePos: room.queue.length });
    }
  });

  socket.on('client:release-slot', () => {
    const room = findRoomByClient(socket.id);
    if (!room) return;
    const client = room.clients.get(socket.id);
    if (!client || !client.currentSlot) return;

    const releasedSlot = client.currentSlot;
    for (const s of ['instrument', 'mixer', 'fx', 'drums', 'keys']) {
      if (room.slots[s] && room.slots[s].socketId === socket.id) {
        room.slots[s] = null;
      }
    }
    client.currentSlot = null;

    // Auto-promote first queued for this slot
    const qIdx = room.queue.findIndex(q => q.requestedSlot === releasedSlot);
    if (qIdx !== -1) {
      const next = room.queue.splice(qIdx, 1)[0];
      const nextClient = room.clients.get(next.socketId);
      if (nextClient) {
        room.slots[releasedSlot] = { socketId: next.socketId, username: next.username };
        nextClient.currentSlot = releasedSlot;
        io.to(next.socketId).emit('client:slot-granted', { slot: releasedSlot });
      }
    }

    broadcastSlots(room);
  });

  socket.on('client:control', (data) => {
    const room = findRoomByClient(socket.id);
    if (!room) return;
    const client = room.clients.get(socket.id);
    if (!client || !client.currentSlot) return;

    // Forward to host with slot info
    io.to(room.hostSocketId).emit('room:control', {
      slot: client.currentSlot,
      action: data.action,
      params: data.params
    });
  });

  // === DANMAKU (barrage comments) ===
  socket.on('client:danmaku', (data, cb) => {
    const room = findRoomByClient(socket.id);
    if (!room) return;
    const client = room.clients.get(socket.id);
    if (!client) return;

    // Users occupying a slot cannot send danmaku
    if (client.currentSlot) {
      if (typeof cb === 'function') cb({ error: 'Cannot send while in a slot' });
      return;
    }

    var text = (data && data.text || '').trim().slice(0, 100);
    if (!text) return;

    // Forward to host for rendering
    io.to(room.hostSocketId).emit('room:danmaku', {
      username: client.username,
      text: text
    });
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('client:leave', () => {
    const room = findRoomByClient(socket.id);
    if (room) removeClientFromRoom(room, socket.id);
  });

  // === DISCONNECT ===

  socket.on('disconnect', () => {
    // Client disconnect
    const clientRoom = findRoomByClient(socket.id);
    if (clientRoom) removeClientFromRoom(clientRoom, socket.id);

    // Host disconnect — close room
    const hostRoom = findRoomByHost(socket.id);
    if (hostRoom) {
      for (const [sid] of hostRoom.clients) {
        io.to(sid).emit('client:kicked', { reason: 'Host disconnected' });
      }
      rooms.delete(hostRoom.roomId);
    }
  });
});

// Helper: build serializable slot/queue data
function buildSlotData(room) {
  const d = {};
  for (const s of ['instrument', 'mixer', 'fx', 'drums', 'keys']) {
    const occ = room.slots[s];
    d[s] = occ ? { socketId: occ.socketId, username: occ.username } : null;
  }
  return d;
}
function buildQueueData(room) {
  return room.queue.map(q => ({
    socketId: q.socketId,
    username: q.username,
    requestedSlot: q.requestedSlot
  }));
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log('Sonic Relay Server listening on port ' + PORT);
});
