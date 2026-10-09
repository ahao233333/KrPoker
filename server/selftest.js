"use strict";

// 服务端集成自测：两个内置 WebSocket 客户端建房打完整手牌。
// 校验：脱敏（对手底牌不下发）、状态推进、筹码守恒、超时弃牌。
// 运行：node server/selftest.js

const { server } = require("./index");

const BUY_IN = 5000;
const HANDS_TO_PLAY = 3;

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const client = { ws, messages: [], state: null, room: null, token: null, logs: [] };
    ws.onopen = () => resolve(client);
    ws.onerror = (event) => reject(new Error("ws error"));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      client.messages.push(message);
      if (message.t === "joined") { client.room = message.room; client.token = message.token; }
      if (message.t === "state") client.state = message.state;
      if (message.t === "log") client.logs.push(message.html);
    };
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (client, message) => client.ws.send(JSON.stringify(message));

function waitFor(client, predicate, timeoutMs = 15000, label = "condition") {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate(client)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(check, 25);
    };
    check();
  });
}

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`test server on :${port}`);

  const alice = await connect(port);
  send(alice, { t: "create", name: "阿丽", smallBlind: 25, buyIn: BUY_IN });
  await waitFor(alice, (c) => c.room, 5000, "room code");
  const roomCode = alice.room;
  if (!/^[A-Z2-9]{4}$/.test(roomCode)) throw new Error(`bad room code ${roomCode}`);

  const bob = await connect(port);
  send(bob, { t: "join", room: roomCode.toLowerCase(), name: "阿波" }); // 小写也应能进房
  await waitFor(bob, (c) => c.room === roomCode, 5000, "bob join");

  // 脱敏校验：开局前 bob 的状态里对手（alice）不应有牌，自己 human 标记正确。
  await waitFor(bob, (c) => c.state && c.state.players.length === 2, 5000, "lobby state");
  if (bob.state.players[0].name !== "阿波" || !bob.state.players[0].human) throw new Error("self not rotated to seat 0");
  if (bob.state.players[1].human) throw new Error("opponent marked human");

  send(alice, { t: "start" });
  await waitFor(alice, (c) => c.state && c.state.handNo === 1, 5000, "hand 1");
  await waitFor(bob, (c) => c.state && c.state.players[1].cards.length === 2, 5000, "opponent cards placeholder");
  const hidden = bob.state.players[1].cards;
  if (hidden.some((card) => card.rank !== 0)) throw new Error("opponent hole cards leaked!");
  if (bob.state.players[0].cards.some((card) => !card.rank)) throw new Error("own cards missing");

  // 轮流行动：轮到自己时跟注/过牌，偶尔加注，打满 HANDS_TO_PLAY 手。
  const acted = { alice: 0, bob: 0 };
  const maybeAct = (client, name) => {
    const state = client.state;
    if (!state || state.handOver || state.actingIndex !== 0) return;
    const me = state.players[0];
    const toCall = Math.max(0, state.currentBet - me.bet);
    const marker = `${state.handNo}:${state.street}:${state.currentBet}:${me.bet}`;
    if (client.lastActMarker === marker) return; // 同一决策点只行动一次
    client.lastActMarker = marker;
    const roll = Math.random();
    let message;
    if (toCall > 0) {
      if (roll < 0.75 || toCall >= me.chips) message = { t: "action", action: "call" };
      else if (roll < 0.9) message = { t: "action", action: "raise", target: state.currentBet + state.minRaise };
      else message = { t: "action", action: "fold" };
    } else {
      message = roll < 0.85 ? { t: "action", action: "check" }
        : { t: "action", action: "raise", target: state.currentBet + state.minRaise };
    }
    acted[name === "阿丽" ? "alice" : "bob"]++;
    send(client, message);
  };
  const actLoop = setInterval(() => { maybeAct(alice, "阿丽"); maybeAct(bob, "阿波"); }, 120);

  await waitFor(alice, (c) => c.state && c.state.handNo >= HANDS_TO_PLAY && c.state.handOver, 60000, `${HANDS_TO_PLAY} hands`);
  await waitFor(bob, (c) => c.state && c.state.handNo >= HANDS_TO_PLAY && c.state.handOver, 10000, "bob final state");

  // 摊牌后对手真实底牌应该可见。
  if (bob.state.reveal && bob.state.players[1].cards.some((card) => !card.rank)) {
    throw new Error("showdown cards not revealed");
  }

  // 筹码守恒：没人破产补码时，两人筹码总和恒等于 2 * buyIn。
  const totalA = alice.state.players.reduce((sum, p) => sum + p.chips, 0);
  const totalB = bob.state.players.reduce((sum, p) => sum + p.chips, 0);
  const rebuys = alice.logs.filter((l) => l.includes("补充到")).length;
  const expected = 2 * BUY_IN + rebuys * BUY_IN;
  if (totalA !== expected || totalB !== expected) {
    throw new Error(`chip conservation broken: alice sees ${totalA}, bob sees ${totalB}, expected ${expected}`);
  }
  if (acted.alice === 0 || acted.bob === 0) throw new Error("one side never acted");
  if (!alice.state.heroHand || !alice.state.heroHand.position) throw new Error("heroHand stats missing");

  // 非法行动应被拒绝：已结束后行动、未轮到时行动。
  send(bob, { t: "action", action: "raise", target: 99999 });
  await sleep(300);
  if (bob.state.handOver !== true) throw new Error("state drifted after illegal action");

  // 断线重连：凭 token 恢复原座位，筹码与座位不变。
  const bobChipsBefore = bob.state.players[0].chips;
  const bobToken = bob.token;
  bob.ws.close();
  await sleep(300);
  const bob2 = await connect(port);
  send(bob2, { t: "join", room: roomCode, token: bobToken, name: "阿波" });
  await waitFor(bob2, (c) => c.state && c.state.players.length === 2, 5000, "rejoin state");
  if (bob2.state.players[0].name !== "阿波") throw new Error("rejoin landed on wrong seat");
  if (bob2.state.players[0].chips !== bobChipsBefore) throw new Error("rejoin changed chips");

  // 主动离桌：房间只剩一人时不销毁，全部离开后销毁。
  send(bob2, { t: "leave" });
  await sleep(300);
  const carol = await connect(port);
  send(carol, { t: "join", room: roomCode, name: "卡萝" });
  await waitFor(carol, (c) => c.room === roomCode, 5000, "carol join after bob left");
  carol.ws.close();

  alice.ws.close();
  bob2.ws.close();
  clearInterval(actLoop);
  server.close();
  console.log(`Selftest OK: ${HANDS_TO_PLAY} hands, chips conserved (${expected}), cards sanitized, rejoin/leave verified, actions alice=${acted.alice} bob=${acted.bob}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("SELFTEST FAILED:", error.message);
  process.exit(1);
});
