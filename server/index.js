"use strict";

// KrPoker 联机服务：静态托管 dist/ + WebSocket 房间服务。
// 零依赖，Node 18+ 直接运行：node server/index.js [端口]

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// poker-core.js 是浏览器风格的全局脚本，这里注入 globalThis 复用牌型/边池逻辑。
const coreSource = fs.readFileSync(path.join(__dirname, "..", "dist", "poker-core.js"), "utf8");
new Function("self", coreSource)(globalThis);

const { attachWebSocket } = require("./ws");
const { createTable } = require("./engine");

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const STATIC_ROOT = path.join(__dirname, "..", "dist");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon"
};

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉易混淆字符
const rooms = new Map();

function makeRoomCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return rooms.has(code) ? makeRoomCode() : code;
}

const makeToken = () => crypto.randomBytes(12).toString("hex");
const escapeName = (name) => String(name || "").trim().slice(0, 12)
  .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

// --- 房间 ---

function createRoom(options) {
  const room = {
    code: makeRoomCode(),
    hostId: null,
    sockets: new Map(), // playerId -> ws api
    players: new Map(), // playerId -> { id, name, token }
    nextPlayerSeq: 1
  };
  room.table = createTable(options, {
    log: (html, type) => broadcast(room, { t: "log", html, type }),
    broadcast: () => broadcastState(room),
    isOnline: (playerId) => room.sockets.has(playerId)
  });
  rooms.set(room.code, room);
  return room;
}

function send(room, playerId, message) {
  const socket = room.sockets.get(playerId);
  if (socket) socket.send(JSON.stringify(message));
}

function broadcast(room, message) {
  const data = JSON.stringify(message);
  room.sockets.forEach((socket) => socket.send(data));
}

function broadcastState(room) {
  room.sockets.forEach((socket, playerId) => {
    const state = room.table.stateFor(playerId);
    if (state) socket.send(JSON.stringify({ t: "state", state }));
  });
}

function broadcastLobby(room) {
  broadcast(room, {
    t: "lobby",
    room: room.code,
    started: room.table.game.started,
    players: room.table.game.players.map((p) => ({
      id: p.id, name: p.name, chips: p.chips,
      host: p.id === room.hostId, online: room.sockets.has(p.id)
    }))
  });
}

function destroyRoom(room) {
  room.table.destroy();
  rooms.delete(room.code);
}

function roomEmpty(room) {
  return room.sockets.size === 0;
}

// --- 消息处理 ---

function handleMessage(room, playerId, message) {
  if (!message || typeof message !== "object") return;
  if (message.t === "start") {
    if (playerId === room.hostId && room.table.start()) broadcastLobby(room);
  } else if (message.t === "action") {
    room.table.handleAction(playerId, message.action, Number(message.target));
  } else if (message.t === "leave") {
    leaveRoom(room, playerId, true);
  }
}

function leaveRoom(room, playerId, graceful) {
  room.sockets.delete(playerId);
  room.table.removePlayer(playerId);
  if (graceful) room.players.delete(playerId);
  if (roomEmpty(room)) { destroyRoom(room); return; }
  broadcastLobby(room);
  broadcastState(room);
}

function attachPlayer(room, player, socketApi) {
  room.sockets.set(player.id, socketApi);
  send(room, player.id, {
    t: "joined", room: room.code, token: player.token,
    playerId: player.id, host: player.id === room.hostId
  });
  broadcastLobby(room);
  const state = room.table.stateFor(player.id);
  if (state) send(room, player.id, { t: "state", state });
  room.table.maybeStart();
}

function handleConnection(req, socket) {
  let room = null;
  let playerId = null;

  const api = attachWebSocket(req, socket, {
    onMessage(raw) {
      let message;
      try { message = JSON.parse(raw); } catch (_) { return; }

      if (!room) {
        if (message.t === "create") {
          const name = escapeName(message.name) || "玩家";
          room = createRoom({
            smallBlind: clampInt(message.smallBlind, 5, 500, 25),
            buyIn: clampInt(message.buyIn, 500, 100000, 5000)
          });
          playerId = `p${room.nextPlayerSeq++}`;
          room.hostId = playerId;
          const player = { id: playerId, name, token: makeToken() };
          room.players.set(playerId, player);
          room.table.addPlayer({ id: playerId, name });
          attachPlayer(room, player, api);
        } else if (message.t === "join") {
          const target = rooms.get(String(message.room || "").toUpperCase().trim());
          if (!target) { api.send(JSON.stringify({ t: "error", message: "房间不存在或已关闭" })); return; }
          room = target;
          // 凭 token 重连恢复原座位，否则作为新玩家入座。
          if (message.token) {
            for (const p of room.players.values()) {
              if (p.token === message.token) { playerId = p.id; attachPlayer(room, p, api); return; }
            }
          }
          const name = escapeName(message.name) || "玩家";
          playerId = `p${room.nextPlayerSeq++}`;
          const player = { id: playerId, name, token: makeToken() };
          if (!room.table.addPlayer({ id: playerId, name })) {
            room = null;
            api.send(JSON.stringify({ t: "error", message: "房间已满（9 人）" }));
            return;
          }
          room.players.set(playerId, player);
          attachPlayer(room, player, api);
        } else {
          api.send(JSON.stringify({ t: "error", message: "请先创建或加入房间" }));
        }
        return;
      }
      handleMessage(room, playerId, message);
    },
    onClose() {
      if (!room || !rooms.has(room.code)) return;
      // 掉线保留座位等待重连；房间无人时才销毁。
      room.sockets.delete(playerId);
      if (roomEmpty(room)) { destroyRoom(room); return; }
      broadcastLobby(room);
    }
  });
}

// --- HTTP：静态文件 + WebSocket 升级 ---

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = path.normalize(urlPath).replace(/^([/\\])+/, "");
  const filePath = path.join(STATIC_ROOT, relative === "" ? "index.html" : relative);
  if (!filePath.startsWith(STATIC_ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (!req.url.startsWith("/ws")) { socket.destroy(); return; }
  handleConnection(req, socket);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`KrPoker server listening on :${PORT}`));
}

module.exports = { server };
