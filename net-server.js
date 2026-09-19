// SexBingo_Server — сигналинг для WebRTC (Node.js / Render)
const http = require('http');
const WebSocket = require('ws');

const ROOMS = new Map();
const SOCKETS = new Map();
const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

function genCode() {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function genUniqueCode() {
  let tries = 0;
  while (tries < 50) {
    const code = genCode();
    if (!ROOMS.has(code)) return code;
    tries++;
  }
  return genCode() + genCode().slice(0, 2);
}

function send(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {}
}

function removeFromRoom(sockInfo) {
  if (!sockInfo || !sockInfo.roomCode) return;
  const room = ROOMS.get(sockInfo.roomCode);
  if (!room) return;

  if (sockInfo.role === 'host') {
    room.players.forEach((p) => {
      send(p.socket, { type: 'host-left' });
      SOCKETS.delete(p.socket);
    });
    ROOMS.delete(sockInfo.roomCode);
  } else {
    room.players.delete(sockInfo.id);
    send(room.hostSocket, {
      type: 'player-left',
      playerId: sockInfo.id,
      playerName: sockInfo.name
    });
    if (room.players.size === 0) {
      setTimeout(() => {
        const stillRoom = ROOMS.get(sockInfo.roomCode);
        if (stillRoom && stillRoom.players.size === 0) {
          ROOMS.delete(sockInfo.roomCode);
        }
      }, 3 * 60 * 1000);
    }
  }
  SOCKETS.delete(sockInfo.socket);
}

function handleMessage(ws, data) {
  const info = SOCKETS.get(ws);
  if (!info) return;

  switch (data.type) {
    case 'create': {
      const code = genUniqueCode();
      info.role = 'host';
      info.id = data.hostId || Math.random().toString(36).slice(2);
      info.roomCode = code;
      ROOMS.set(code, {
        hostId: info.id,
        hostSocket: ws,
        hostName: data.hostName || 'Ведущий',
        players: new Map(),
        createdAt: Date.now()
      });
      send(ws, { type: 'room-created', roomCode: code, hostId: info.id });
      break;
    }

    case 'join': {
      const room = ROOMS.get(data.roomCode);
      if (!room) {
        send(ws, { type: 'join-error', reason: 'Комната не найдена' });
        return;
      }
      if (room.players.size >= MAX_PLAYERS) {
        send(ws, { type: 'join-error', reason: 'Комната заполнена (макс ' + MAX_PLAYERS + ')' });
        return;
      }
      const playerId = data.playerId || Math.random().toString(36).slice(2);
      const playerName = (data.playerName || 'Игрок').slice(0, 40);

      info.role = 'player';
      info.id = playerId;
      info.name = playerName;
      info.roomCode = data.roomCode;
      room.players.set(playerId, { socket: ws, name: playerName });

      send(ws, { type: 'joined', roomCode: data.roomCode, playerId, hostName: room.hostName });
      send(room.hostSocket, { type: 'player-joined', playerId, playerName });
      break;
    }

    case 'signal': {
      if (!info.roomCode) return;
      const room = ROOMS.get(info.roomCode);
      if (!room) return;
      const targetId = data.to;
      const targetSocket = (targetId === room.hostId)
        ? room.hostSocket
        : (room.players.get(targetId) || {}).socket;
      if (targetSocket) {
        send(targetSocket, { type: 'signal', from: info.id, payload: data.payload });
      }
      break;
    }

    case 'bingo': {
      if (!info.roomCode) return;
      const room = ROOMS.get(info.roomCode);
      if (!room) return;
      send(room.hostSocket, { type: 'player-bingo', playerId: info.id, playerName: info.name });
      break;
    }

    case 'spin': {
      if (!info.roomCode) return;
      const room = ROOMS.get(info.roomCode);
      if (!room) return;
      room.players.forEach((p) => {
        send(p.socket, { type: 'spin-broadcast', n: data.n });
      });
      break;
    }

    case 'reset': {
      if (!info.roomCode) return;
      const room = ROOMS.get(info.roomCode);
      if (!room) return;
      room.players.forEach((p) => {
        send(p.socket, { type: 'reset-broadcast' });
      });
      break;
    }

    case 'leave': {
      removeFromRoom(info);
      send(ws, { type: 'left' });
      break;
    }

    case 'ping': {
      send(ws, { type: 'pong' });
      break;
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('SexBingo signaling server is running');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  SOCKETS.set(ws, { socket: ws });
  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    if (!data || typeof data !== 'object') return;
    handleMessage(ws, data);
  });
  ws.on('close', () => {
    const info = SOCKETS.get(ws);
    if (info) removeFromRoom(info);
  });
  ws.on('error', () => {
    const info = SOCKETS.get(ws);
    if (info) removeFromRoom(info);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`SexBingo_Server running on port ${PORT}`);
});
