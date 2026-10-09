(() => {
  "use strict";

  // 联机模块：真人局客户端。连接房间服务器，把服务端推送的脱敏状态
  // 套用进 K.state.game 复用现有渲染；行动按钮改为发消息给服务器。
  const K = window.KrPoker;
  const S = K.state;
  const { els, formatChips } = K;

  const net = K.net = {
    active: false, host: false,
    ws: null, room: null, token: null, playerId: null,
    reconnects: 0, manualClose: false
  };

  const netEls = {
    name: document.getElementById("netName"),
    server: document.getElementById("netServer"),
    room: document.getElementById("netRoom"),
    create: document.getElementById("netCreate"),
    join: document.getElementById("netJoin"),
    lobbyModal: document.getElementById("lobbyModal"),
    lobbyRoom: document.getElementById("lobbyRoom"),
    lobbyPlayers: document.getElementById("lobbyPlayers"),
    lobbyStart: document.getElementById("lobbyStart"),
    lobbyHint: document.getElementById("lobbyHint")
  };

  const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function serverUrl() {
    const manual = netEls.server.value.trim();
    if (manual) return `${manual.replace(/^http/, "ws").replace(/\/+$/, "")}/ws`;
    if (location.protocol.startsWith("http")) return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    return "ws://localhost:8080/ws"; // file://（安卓壳）场景的默认兜底
  }

  function send(message) {
    if (net.ws && net.ws.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify(message));
  }

  net.sendAction = (action, target) => send({ t: "action", action, target });

  function connect(payloadFactory) {
    net.manualClose = false;
    const ws = new WebSocket(serverUrl());
    net.ws = ws;
    ws.onopen = () => send(payloadFactory());
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      handleMessage(message);
    };
    ws.onclose = () => {
      if (!net.active || net.manualClose) return;
      // 掉线自动重连：凭 token 恢复原座位。
      if (net.reconnects < 5) {
        net.reconnects++;
        K.showToast("连接断开，正在重连…");
        setTimeout(() => connect(() => ({ t: "join", room: net.room, token: net.token, name: netEls.name.value })), 1500);
      } else {
        teardown();
        K.showToast("与服务器断开连接");
      }
    };
    ws.onerror = () => {
      if (!net.active) K.showToast("连不上服务器，请检查地址");
    };
  }

  function handleMessage(message) {
    if (message.t === "joined") {
      net.active = true;
      net.reconnects = 0;
      net.room = message.room;
      net.token = message.token;
      net.playerId = message.playerId;
      net.host = message.host;
      try { sessionStorage.setItem("krpoker-net", JSON.stringify({ room: net.room, token: net.token })); } catch (_) { /* optional */ }
      els.setup.classList.add("hidden");
      els.leave.hidden = false;
      els.log.innerHTML = "";
      netEls.lobbyRoom.textContent = message.room;
      netEls.lobbyStart.hidden = !net.host;
      netEls.lobbyModal.classList.remove("hidden");
      K.renderOpponents();
    } else if (message.t === "lobby") {
      renderLobby(message);
    } else if (message.t === "state") {
      applyState(message.state);
    } else if (message.t === "log") {
      K.addLog(message.html, message.type);
    } else if (message.t === "error") {
      K.showToast(message.message || "出错了");
    }
  }

  function renderLobby(lobby) {
    if (!net.active) return;
    netEls.lobbyPlayers.innerHTML = lobby.players.map((p) =>
      `<div class="lobby-player"><span class="mini-avatar">${escapeHtml(p.name[0] || "?")}</span><strong>${escapeHtml(p.name)}</strong>${p.host ? '<em>房主</em>' : ""}${p.id === net.playerId ? '<em>我</em>' : ""}${p.online ? "" : '<em class="offline">离线</em>'}</div>`
    ).join("");
    netEls.lobbyHint.textContent = lobby.started
      ? "牌局进行中"
      : lobby.players.length < 2 ? "至少 2 人才能开局" : net.host ? "人齐了就开局吧" : "等待房主开局";
    if (lobby.started) netEls.lobbyModal.classList.add("hidden");
    else netEls.lobbyModal.classList.remove("hidden");
  }

  // 把服务端状态塞进 K.state.game，复用本地渲染与行动按钮逻辑。
  function applyState(state) {
    const prev = S.game;
    const wasMyTurn = prev && !prev.handOver && prev.actingIndex === 0;
    state.lastRenderedChips = prev ? prev.lastRenderedChips : new Map();
    state.lastRenderedPot = prev ? prev.lastRenderedPot : null;
    state.animateBoardFrom = prev && state.community.length > prev.community.length ? prev.community.length : null;
    state.animateHoleCards = !prev || prev.handNo !== state.handNo;
    state.thinkSpeed = "fast";
    S.game = state;

    // 训练数据：本手从进行中变为结束时记录一次。
    if (state.heroHand && state.handOver && !(prev && prev.handOver) && state.heroHand.startChips != null) {
      K.recordTrainingHand();
    }

    K.render();
    renderNetOpponents(state);

    const myTurn = !state.handOver && state.actingIndex === 0 && state.players[0]?.human;
    if (myTurn) {
      K.enableHumanTurn();
      if (!wasMyTurn) { K.tone(280); K.haptic(12); }
    } else {
      K.disableActions();
      if (state.handOver && state.started) {
        els.turnLabel.textContent = "本手已结束";
        els.handHint.textContent = `持有 ${formatChips(state.players[0].chips)} 筹码 · 等待下一手`;
      }
    }
  }

  function renderNetOpponents(state) {
    const others = state.players.slice(1);
    els.opponentCount.textContent = String(others.length);
    els.opponentList.innerHTML = others.map((p) => `<article class="opponent-row${p.folded ? " eliminated" : ""}">
      <div class="opponent-head"><span class="mini-avatar">${escapeHtml(p.name[0] || "?")}</span><div><strong>${escapeHtml(p.name)}</strong><small>${formatChips(p.chips)} 筹码</small></div></div>
    </article>`).join("");
  }

  function teardown() {
    net.active = false;
    net.manualClose = true;
    net.reconnects = 0;
    try { net.ws && net.ws.close(); } catch (_) { /* ignore */ }
    net.ws = null;
    try { sessionStorage.removeItem("krpoker-net"); } catch (_) { /* ignore */ }
    netEls.lobbyModal.classList.add("hidden");
  }

  net.leave = () => {
    send({ t: "leave" });
    teardown();
  };

  // --- 事件绑定 ---

  netEls.create.addEventListener("click", () => {
    const name = netEls.name.value.trim();
    if (!name) { K.showToast("先填个昵称"); return; }
    connect(() => ({
      t: "create", name,
      smallBlind: Number(els.blindLevel.value),
      buyIn: Number(els.startingChips.value)
    }));
  });

  netEls.join.addEventListener("click", () => {
    const name = netEls.name.value.trim();
    const code = netEls.room.value.trim().toUpperCase();
    if (!name) { K.showToast("先填个昵称"); return; }
    if (code.length !== 4) { K.showToast("房间号是 4 位字母数字"); return; }
    connect(() => ({ t: "join", room: code, name }));
  });

  netEls.lobbyStart.addEventListener("click", () => send({ t: "start" }));

  try {
    const savedName = localStorage.getItem("krpoker-net-name");
    if (savedName) netEls.name.value = savedName;
  } catch (_) { /* optional */ }
  netEls.name.addEventListener("change", () => {
    try { localStorage.setItem("krpoker-net-name", netEls.name.value.trim()); } catch (_) { /* optional */ }
  });
})();
