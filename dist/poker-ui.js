(() => {
  "use strict";

  // UI 模块：渲染、牌局记录、音效与触感反馈。
  // 只读取 K.state.game，不修改牌局流程。
  const K = window.KrPoker;
  const S = K.state;
  const { els, formatChips, RANK_LABEL, STREET_NAMES } = K;

  function cardText(card) { return `${RANK_LABEL[card.rank] || card.rank}${card.suit}`; }

  function renderCard(card, hidden = false, dealIndex = null) {
    if (!card) return '<div class="card placeholder"></div>';
    const animationClass = dealIndex == null ? "" : " deal-in";
    const animationStyle = dealIndex == null ? "" : ` style="--deal-index:${dealIndex}"`;
    if (hidden) return `<div class="card back${animationClass}"${animationStyle} aria-label="底牌"></div>`;
    const red = card.suit === "♥" || card.suit === "♦";
    return `<div class="card ${red ? "red" : ""}${animationClass}"${animationStyle} aria-label="${cardText(card)}"><span>${RANK_LABEL[card.rank] || card.rank}</span><span class="suit">${card.suit}</span><span class="pip">${card.suit}</span></div>`;
  }

  function render() {
    const game = S.game;
    if (!game) return;
    const currentPot = K.potSize();
    els.pot.textContent = formatChips(currentPot);
    if (game.lastRenderedPot != null && game.lastRenderedPot !== currentPot) {
      els.pot.classList.remove("pot-pop");
      void els.pot.offsetWidth;
      els.pot.classList.add("pot-pop");
    }
    game.lastRenderedPot = currentPot;
    els.handNumber.textContent = `第 ${game.handNo} 手 · ${STREET_NAMES[game.street] || "准备中"}`;
    els.handsPlayed.textContent = game.handsPlayed;
    els.blindInfo.textContent = game.ante
      ? `${game.smallBlind} / ${game.bigBlind} · 前注 ${game.ante}`
      : `${game.smallBlind} / ${game.bigBlind}`;
    els.handInvestment.textContent = `本手已投入 ${formatChips(game.players[0].totalInvested)}`;
    els.community.innerHTML = [0, 1, 2, 3, 4].map((i) =>
      renderCard(game.community[i], false, game.animateBoardFrom != null && i >= game.animateBoardFrom ? i - game.animateBoardFrom : null)
    ).join("");
    renderSeats();
    renderTournamentHud();
    game.animateBoardFrom = null;
    if (!game.handOver && game.actingIndex >= 0) {
      const actor = game.players[game.actingIndex];
      els.turnLabel.textContent = actor.human ? "轮到你行动" : `${actor.name} 正在思考`;
      const heroResult = window.PokerCore.bestHand([...game.players[0].cards, ...game.community]);
      els.handHint.textContent = heroResult ? heroResult.name : "观察位置与下注尺度";
    }
  }

  function renderSeats() {
    const game = S.game;
    const n = game.players.length;
    const animateHoles = game.animateHoleCards;
    const compactLandscape = typeof window.matchMedia === "function" && window.matchMedia("(max-height: 560px) and (orientation: landscape)").matches;
    const compactYRadius = (window.innerHeight || 999) <= 380 ? 28 : 30;
    const compactXRadius = compactLandscape && n >= 7 ? 45.5 : 43.5;
    els.seatLayer.dataset.count = String(n);
    els.seatLayer.innerHTML = game.players.map((p, index) => {
      const angle = (90 + index * 360 / n) * Math.PI / 180;
      const x = 50 + compactXRadius * Math.cos(angle);
      const y = 50 + (compactLandscape ? compactYRadius : 41) * Math.sin(angle);
      const isActor = index === game.actingIndex && !game.handOver;
      const revealCards = p.human || (game.reveal && !p.folded);
      const cards = p.cards.map((c, cardIndex) => renderCard(c, !revealCards, animateHoles ? index * 2 + cardIndex : null)).join("");
      const dealer = index === game.dealerIndex ? '<span class="dealer-button">D</span>' : "";
      const previousChips = game.lastRenderedChips.get(p.id);
      const chipChanged = previousChips != null && previousChips !== p.chips;
      game.lastRenderedChips.set(p.id, p.chips);
      return `<div class="seat ${isActor ? "active" : ""} ${p.folded ? "folded" : ""} ${p.winner ? "winner" : ""} ${p.eliminated ? "eliminated" : ""} ${isActor && !p.human ? "ai-thinking" : ""}" style="left:${x}%;top:${y}%">
        <div class="seat-cards">${cards}</div>
        <div class="seat-box">${dealer}<div class="seat-name"><span>${p.name}</span></div><div class="seat-chips ${chipChanged ? "chip-change" : ""}">${p.eliminated ? `第 ${p.placement} 名` : formatChips(p.chips)}</div>${p.eliminated ? "" : p.lastAction ? `<div class="seat-bet">${p.lastAction}${p.bet ? ` · ${formatChips(p.bet)}` : ""}</div>` : p.bet ? `<div class="seat-bet">${formatChips(p.bet)}</div>` : ""}</div>
      </div>`;
    }).join("");
    game.animateHoleCards = false;
  }

  function renderOpponents() {
    const game = S.game;
    if (!game) return;
    const opponents = game.players.slice(1);
    const live = opponents.filter((p) => !p.eliminated).length;
    els.opponentCount.textContent = game.mode === "tournament" ? `${live}/${opponents.length}` : opponents.length;
    els.opponentList.innerHTML = opponents.map((p) => `<article class="opponent-row${p.eliminated ? " eliminated" : ""}">
      <div class="opponent-head"><span class="mini-avatar">${p.name[0]}</span><div><strong>${p.name}</strong><small>${p.eliminated ? `已淘汰 · 第 ${p.placement} 名` : "本桌参数已锁定"}</small></div></div>
    </article>`).join("");
  }

  function addLog(html, type = "") {
    if (!S.game) return;
    if (els.log.querySelector(".empty-state")) els.log.innerHTML = "";
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.innerHTML = html;
    els.log.prepend(entry);
    while (els.log.children.length > 50) els.log.lastElementChild.remove();
  }

  function showToast(message) {
    clearTimeout(S.toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("show");
    S.toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  function tone(frequency) {
    if (!S.soundEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.025, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .08);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + .08);
    } catch (_) { /* sound is optional */ }
  }

  function haptic(pattern) {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
    } catch (_) { /* vibration support varies by device */ }
  }

  // 锦标赛 HUD：只在锦标赛模式显示，用级别进度与均码对比提示处境。
  function renderTournamentHud() {
    const game = S.game;
    const hud = els.tournamentHud;
    if (!hud) return;
    if (!game || game.mode !== "tournament") { hud.hidden = true; return; }
    hud.hidden = false;

    const core = window.PokerCore;
    els.hudLevel.textContent = `第 ${game.levelIndex + 1} 级`;

    // 距下次涨盲：溢出阶段没有下一级别，直接显示盲注仍会继续上升。
    const remaining = core.handsUntilNextLevel(game.handsPlayed);
    els.hudNextLevel.textContent = remaining == null ? "持续递增" : `${remaining} 手`;
    els.hudNextLevel.classList.toggle("urgent", remaining != null && remaining <= 3);

    // 均码：场上未淘汰玩家的平均筹码（大盲数）。
    const stacks = game.players.filter((p) => !p.eliminated && p.chips > 0).map((p) => p.chips);
    const averageBb = core.averageStackBb(stacks, game.bigBlind);
    els.hudAverage.textContent = averageBb ? `${Math.round(averageBb)} BB` : "—";

    // 自身处境：相对均码的百分比。正为领先，负为落后。
    const heroStack = game.players[0].chips;
    const pressure = core.stackPressure(heroStack, stacks, game.bigBlind);
    const heroBb = game.bigBlind > 0 ? Math.round(heroStack / game.bigBlind) : 0;
    const percent = Math.round(pressure * 100);
    els.hudPressure.textContent = `${heroBb} BB (${percent >= 0 ? "+" : ""}${percent}%)`;
    els.hudPressure.classList.toggle("ahead", percent > 8);
    els.hudPressure.classList.toggle("behind", percent < -8);

    // 进度条：当前级别内已打的手数占比。
    const progress = core.levelProgress(game.handsPlayed);
    els.hudProgress.style.width = `${Math.min(100, Math.max(0, progress.elapsed / progress.length * 100))}%`;
  }

  K.cardText = cardText;
  K.renderCard = renderCard;
  K.render = render;
  K.renderSeats = renderSeats;
  K.renderOpponents = renderOpponents;
  K.addLog = addLog;
  K.renderTournamentHud = renderTournamentHud;
  K.showToast = showToast;
  K.tone = tone;
  K.haptic = haptic;
})();
