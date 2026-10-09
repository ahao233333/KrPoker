"use strict";

// 零依赖的最小 WebSocket（RFC6455）服务端实现。
// 只支持文本消息（本协议为 JSON），处理浏览器掩码、分片、ping/pong 与关闭帧。
const crypto = require("crypto");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 64 * 1024;

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

function attachWebSocket(req, socket, { onMessage, onClose }) {
  const key = req.headers["sec-websocket-key"];
  if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0);
  let fragments = [];
  let closed = false;

  function sendFrame(opcode, payload) {
    if (closed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try { socket.write(Buffer.concat([header, payload])); } catch (_) { /* socket dying */ }
  }

  function finish() {
    if (closed) return;
    closed = true;
    onClose();
  }

  const api = {
    send(data) { sendFrame(1, Buffer.from(data, "utf8")); },
    close() {
      if (closed) return;
      sendFrame(8, Buffer.alloc(0));
      try { socket.end(); } catch (_) { /* ignore */ }
      finish();
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE) { api.close(); return; }
    while (true) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 8) { api.close(); return; }
      if (opcode === 9) { sendFrame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 0 || opcode === 1) {
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments);
          fragments = [];
          try { onMessage(full.toString("utf8")); } catch (_) { /* bad message */ }
        }
      }
    }
  });
  socket.on("error", finish);
  socket.on("close", finish);
  return api;
}

module.exports = { attachWebSocket };
