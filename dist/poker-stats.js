(() => {
  "use strict";

  // 训练数据模块：本地长期统计的读写与展示。
  const K = window.KrPoker;
  const S = K.state;
  const { els, formatChips } = K;
  const STORAGE_KEY = "riverstone-training-stats";

  function emptyTrainingStats() {
    return {
      hands: 0, vpip: 0, pfr: 0, showdowns: 0, showdownWins: 0, net: 0,
      positions: { BTN: { hands: 0, net: 0 }, SB: { hands: 0, net: 0 }, BB: { hands: 0, net: 0 }, Early: { hands: 0, net: 0 }, Middle: { hands: 0, net: 0 }, Late: { hands: 0, net: 0 } }
    };
  }

  function loadTrainingStats() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return stored?.positions ? { ...emptyTrainingStats(), ...stored, positions: { ...emptyTrainingStats().positions, ...stored.positions } } : emptyTrainingStats();
    } catch (_) { return emptyTrainingStats(); }
  }

  const trainingStats = loadTrainingStats();

  function persistTrainingStats() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trainingStats)); } catch (_) { /* local persistence is optional */ }
  }

  function renderTrainingStats() {
    els.statHands.textContent = formatChips(trainingStats.hands);
    els.statVpip.textContent = K.percentage(trainingStats.vpip, trainingStats.hands);
    els.statPfr.textContent = K.percentage(trainingStats.pfr, trainingStats.hands);
    els.statShowdown.textContent = K.percentage(trainingStats.showdownWins, trainingStats.showdowns);
    els.statNet.textContent = `${trainingStats.net >= 0 ? "+" : ""}${formatChips(trainingStats.net)}`;
    els.statNet.parentElement?.classList.toggle("negative", trainingStats.net < 0);
    els.statNetBar.style.setProperty("--value", `${Math.min(100, Math.abs(trainingStats.net) / Math.max(1, trainingStats.hands * 40) * 100)}%`);
    els.positionStats.innerHTML = Object.entries(trainingStats.positions).map(([position, data]) =>
      `<div class="position-row"><span>${position} · ${data.hands} 手</span><strong>${data.net >= 0 ? "+" : ""}${formatChips(data.net)}</strong></div>`
    ).join("");
  }

  function recordTrainingHand() {
    const game = S.game;
    const hand = game?.heroHand;
    if (!hand || hand.recorded) return;
    hand.recorded = true;
    const net = game.players[0].chips - hand.startChips;
    trainingStats.hands++;
    if (hand.vpip) trainingStats.vpip++;
    if (hand.pfr) trainingStats.pfr++;
    if (hand.showdown) trainingStats.showdowns++;
    if (hand.showdown && hand.won) trainingStats.showdownWins++;
    trainingStats.net += net;
    const position = trainingStats.positions[hand.position] || trainingStats.positions.Middle;
    position.hands++;
    position.net += net;
    persistTrainingStats();
    renderTrainingStats();
  }

  K.trainingStats = trainingStats;
  K.renderTrainingStats = renderTrainingStats;
  K.recordTrainingHand = recordTrainingHand;
})();
