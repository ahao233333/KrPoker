(() => {
  "use strict";

  // 入口模块：牌桌生命周期与事件绑定。
  // 具体流程在 poker-table，决策在 poker-ai，渲染在 poker-ui。
  const K = window.KrPoker;
  const S = K.state;
  const { els, clamp, formatChips } = K;

  // 读取上次选择的思考速度。
  try {
    const savedSpeed = localStorage.getItem("riverstone-think-speed");
    if (["fast", "natural", "slow"].includes(savedSpeed)) els.thinkSpeed.value = savedSpeed;
    S.soundEnabled = localStorage.getItem("riverstone-sound") !== "off";
    els.sound.textContent = `声音：${S.soundEnabled ? "开" : "关"}`;
  } catch (_) { /* use the default */ }

  function openTable() {
    const aiCount = Number(els.aiCount.value);
    const buyIn = Number(els.startingChips.value);
    const mode = els.gameMode ? els.gameMode.value : "cash";
    const smallBlind = mode === "tournament"
      ? window.PokerCore.tournamentLevel(0).smallBlind
      : Number(els.blindLevel.value);
    S.game = {
      players: K.createPlayers(aiCount, buyIn), buyIn, smallBlind, bigBlind: smallBlind * 2,
      mode, levelIndex: 0, ante: mode === "tournament" ? window.PokerCore.tournamentLevel(0).ante : 0,
      tournamentWon: false,
      thinkSpeed: els.thinkSpeed.value, dealerIndex: -1, actingIndex: -1, handNo: 0, handsPlayed: 0,
      street: "idle", community: [], deck: [], currentBet: 0, minRaise: smallBlind * 2,
      heroStats: { actions: 0, raises: 0, calls: 0, folds: 0 }, reveal: false, handOver: true,
      lastRenderedChips: new Map(), lastRenderedPot: null, animateBoardFrom: null, animateHoleCards: false
    };
    K.initAiWorker();
    els.setup.classList.add("hidden");
    els.leave.hidden = false;
    els.log.innerHTML = "";
    K.renderOpponents();
    if (mode === "tournament") {
      K.addLog(`锦标赛开始：${aiCount} 位对手，起始盲注 ${smallBlind} / ${smallBlind * 2}，每 12 手涨盲。`, "system");
    } else {
      K.addLog(`${aiCount} 位 AI 已入座；人格参数将在你离桌前保持不变。`, "system");
    }
    K.startHand();
  }

  function leaveTable() {
    clearTimeout(S.timer);
    S.game = null;
    els.setup.classList.remove("hidden");
    els.leave.hidden = true;
    els.seatLayer.innerHTML = "";
    els.community.innerHTML = [0, 1, 2, 3, 4].map(() => K.renderCard(null)).join("");
    els.pot.textContent = "0";
    els.handNumber.textContent = "等待开桌";
    els.turnLabel.textContent = "先设置牌桌";
    els.handHint.textContent = "—";
    els.handInvestment.textContent = "本手已投入 0";
    els.opponentCount.textContent = "0";
    els.opponentList.innerHTML = '<div class="empty-state">开桌后，这里会记录每位对手的固定风格。</div>';
    els.log.innerHTML = '<div class="empty-state">行动与结算会出现在这里。</div>';
    K.disableActions();
  }

  function setThinkSpeed(value) {
    if (!["fast", "natural", "slow"].includes(value)) return;
    els.thinkSpeed.value = value;
    if (S.game) S.game.thinkSpeed = value;
    try { localStorage.setItem("riverstone-think-speed", value); } catch (_) { /* non-persistent fallback */ }
    if (S.game && !S.game.handOver && !S.paused && !S.game.players[S.game.actingIndex]?.human) {
      clearTimeout(S.timer);
      S.timer = setTimeout(K.scheduleTurn, 40);
    }
  }

  // --- 事件绑定 ---

  els.start.addEventListener("click", openTable);
  els.leave.addEventListener("click", leaveTable);

  // 锦标赛的盲注由级别表决定，固定盲注选择框随之隐藏。
  if (els.gameMode) {
    const syncModeUi = () => {
      const tournament = els.gameMode.value === "tournament";
      if (els.blindField) els.blindField.hidden = tournament;
      if (els.tournamentNote) els.tournamentNote.hidden = !tournament;
    };
    els.gameMode.addEventListener("change", syncModeUi);
    syncModeUi();
  }

  els.statsButton.addEventListener("click", () => { K.renderTrainingStats(); els.statsModal.classList.remove("hidden"); });
  els.statsClose.addEventListener("click", () => els.statsModal.classList.add("hidden"));
  els.statsModal.addEventListener("click", (event) => { if (event.target === els.statsModal) els.statsModal.classList.add("hidden"); });

  els.sound.addEventListener("click", () => {
    S.soundEnabled = !S.soundEnabled;
    try { localStorage.setItem("riverstone-sound", S.soundEnabled ? "on" : "off"); } catch (_) { /* non-persistent fallback */ }
    els.sound.textContent = `声音：${S.soundEnabled ? "开" : "关"}`;
  });

  els.thinkSpeed.addEventListener("change", (event) => setThinkSpeed(event.target.value));

  els.fold.addEventListener("click", () => { if (S.game?.players[S.game.actingIndex]?.human) K.performAction(S.game.players[0], "fold"); });
  els.call.addEventListener("click", () => {
    if (!S.game?.players[S.game.actingIndex]?.human) return;
    const hero = S.game.players[0];
    K.performAction(hero, S.game.currentBet > hero.bet ? "call" : "check");
  });
  els.raise.addEventListener("click", () => {
    const mode = els.raise.dataset.mode;
    if (mode === "next") K.startHand();
    else if (mode === "rescue") K.claimRescue();
    else if (mode === "action" && S.game?.players[S.game.actingIndex]?.human) K.performAction(S.game.players[0], "raise", Number(els.betSlider.value));
  });

  els.betSlider.addEventListener("input", () => els.betAmountLabel.textContent = formatChips(Number(els.betSlider.value)));

  // 点击下注额数字可精确输入，避免在触屏上拖动滑块对准小额。
  const betInput = els.betInput;
  function openBetInput() {
    if (!betInput || els.betSlider.disabled) return;
    betInput.hidden = false;
    betInput.value = String(Number(els.betSlider.value) || 0);
    betInput.focus();
    betInput.select?.();
  }
  function closeBetInput(commit) {
    if (!betInput || betInput.hidden) return;
    if (commit) {
      const min = Number(els.betSlider.min);
      const max = Number(els.betSlider.max);
      const raw = Number(betInput.value);
      if (Number.isFinite(raw)) {
        const target = clamp(Math.round(raw), min, max);
        els.betSlider.value = target;
        els.betAmountLabel.textContent = formatChips(target);
      }
    }
    betInput.hidden = true;
  }
  if (betInput) {
    els.betAmountLabel.addEventListener("click", openBetInput);
    els.betAmountLabel.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openBetInput(); }
    });
    betInput.addEventListener("blur", () => closeBetInput(true));
    betInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); closeBetInput(true); }
      else if (event.key === "Escape") { event.preventDefault(); closeBetInput(false); }
    });
  }

  // 全下：把滑杆推到上限。
  if (els.allInBet) {
    els.allInBet.addEventListener("click", () => {
      if (!S.game) return;
      const hero = S.game.players[0];
      const target = clamp(hero.bet + hero.chips, Number(els.betSlider.min), Number(els.betSlider.max));
      els.betSlider.value = target;
      els.betAmountLabel.textContent = formatChips(target);
    });
  }

  els.quickBets.forEach((button) => button.addEventListener("click", () => {
    if (!S.game) return;
    const hero = S.game.players[0];
    const target = clamp(S.game.currentBet + Math.round(K.potSize() * Number(button.dataset.pot)), Number(els.betSlider.min), hero.bet + hero.chips);
    els.betSlider.value = target;
    els.betAmountLabel.textContent = formatChips(target);
  }));

  document.addEventListener("keydown", (event) => {
    if (!S.game || !S.game.players[S.game.actingIndex]?.human || event.repeat) return;
    const key = event.key.toLowerCase();
    if (key === "f" && !els.fold.disabled) els.fold.click();
    if (key === "c" && !els.call.disabled) els.call.click();
    if (key === "r" && !els.raise.disabled) els.raise.click();
  });

  document.addEventListener("visibilitychange", () => {
    S.paused = document.hidden;
    if (S.paused) clearTimeout(S.timer);
    else if (S.game && !S.game.handOver) S.timer = setTimeout(K.scheduleTurn, 180);
  });

  els.community.innerHTML = [0, 1, 2, 3, 4].map(() => K.renderCard(null)).join("");
  K.renderTrainingStats();

  // 测试钩子：暴露内部状态与决策函数，供 headless 模拟使用。
  // 仅在显式请求时启用，正常运行不读取 __pokerTest。
  if (typeof window !== "undefined" && window.__pokerTest) {
    window.PokerTest = {
      get game() { return S.game; },
      get paused() { return S.paused; },
      set paused(value) { S.paused = value; },
      strategyContext: K.strategyContext,
      updateStreetPlan: K.updateStreetPlan,
      takeAiTurn: K.takeAiTurn,
      performAction: K.performAction,
      startHand: K.startHand,
      scheduleTurn: K.scheduleTurn,
      potSize: K.potSize,
      activePlayers: K.activePlayers,
      renderTournamentHud: K.renderTournamentHud,
      openTable
    };
  }
})();
