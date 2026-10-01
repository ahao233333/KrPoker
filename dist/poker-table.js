(() => {
  "use strict";

  // 牌桌流程模块：发牌、行动、街道推进与结算。
  // 所有状态都读写 K.state.game，渲染交给 poker-ui，AI 决策交给 poker-ai。
  const K = window.KrPoker;
  const S = K.state;
  const { els, clamp, shuffle, formatChips, random, randomBetween, addLog } = K;

  const nextEligible = (from, predicate = (p) => p.chips > 0 && !p.folded && !p.allIn) => {
    const game = S.game;
    for (let step = 1; step <= game.players.length; step++) {
      const index = (from + step) % game.players.length;
      if (predicate(game.players[index])) return index;
    }
    return -1;
  };

  const occupiedFrom = (from) => nextEligible(from, (p) => p.chips > 0);

  const activePlayers = () => S.game.players.filter((p) => !p.folded && (p.chips > 0 || p.totalInvested > 0));
  const potSize = () => S.game.players.reduce((sum, p) => sum + p.totalInvested, 0);

  function animateChipFlow(player, direction) {
    const game = S.game;
    if (!els.chipFx || !player || typeof document.createElement !== "function") return;
    const index = game.players.indexOf(player);
    const angle = (90 + index * 360 / game.players.length) * Math.PI / 180;
    const x = 50 + 43.5 * Math.cos(angle);
    const y = 50 + 41 * Math.sin(angle);
    for (let chipIndex = 0; chipIndex < 3; chipIndex++) {
      const chip = document.createElement("span");
      chip.className = `flying-chip ${direction}`;
      chip.style.setProperty("--seat-x", `${x + (chipIndex - 1) * .8}%`);
      chip.style.setProperty("--seat-y", `${y + (chipIndex % 2) * .7}%`);
      chip.style.setProperty("--chip-delay", `${chipIndex * 55}ms`);
      chip.addEventListener("animationend", () => chip.remove());
      els.chipFx.appendChild(chip);
      setTimeout(() => chip.remove(), 1300);
    }
  }

  function heroPositionLabel() {
    const game = S.game;
    if (game.dealerIndex === 0) return "BTN";
    if (game.smallIndex === 0) return "SB";
    if (game.bigIndex === 0) return "BB";
    const distance = (game.dealerIndex - 0 + game.players.length) % game.players.length;
    return distance <= Math.ceil(game.players.length / 3) ? "Late" : distance >= Math.floor(game.players.length * 2 / 3) ? "Early" : "Middle";
  }

  function postBlind(index, amount, label) {
    const game = S.game;
    const p = game.players[index];
    const paid = Math.min(amount, p.chips);
    p.chips -= paid; p.bet += paid; p.totalInvested += paid;
    if (!p.chips) p.allIn = true;
    animateChipFlow(p, "to-pot");
    addLog(`<strong>${p.name}</strong> 投入${label} ${formatChips(paid)}`);
  }

  function startHand() {
    clearTimeout(S.timer);
    const game = S.game;
    if (!game) return;
    const hero = game.players[0];
    if (hero.chips <= 0) { setRescueMode(); return; }
    if (game.mode === "tournament") {
      K.updateTournamentBlinds();
      // 兜底：即使某一手未经 finishHand，也不会让破产的 AI 重新入座。
      K.eliminateBustedPlayers();
    }
    game.players.forEach((p) => {
      // 现金局里破产的 AI 会重新买入；锦标赛里它们已被淘汰。
      if (!p.human && p.chips <= 0 && game.mode !== "tournament") {
        p.chips = game.buyIn;
        addLog(`<strong>${p.name}</strong> 补充到 ${formatChips(game.buyIn)} 筹码`, "system");
      }
      Object.assign(p, {
        cards: [], bet: 0, totalInvested: 0, folded: p.chips <= 0 || p.eliminated, allIn: false, acted: false,
        raiseLocked: false, lastAction: "", winner: false, plan: null, rangeModel: { strengthBias: 0, bluffMix: .16, rangeWidth: 1 }
      });
    });
    game.handNo++;
    game.handsPlayed++;
    game.street = "preflop";
    game.community = [];
    game.deck = shuffle(window.PokerCore.createDeck());
    game.currentBet = 0;
    game.minRaise = game.bigBlind;
    game.streetRaiseCount = 0;
    game.reveal = false;
    game.handOver = false;
    game.animateHoleCards = true;
    game.dealerIndex = occupiedFrom(game.dealerIndex);
    const inHand = game.players.filter((p) => p.chips > 0);
    if (inHand.length < 2) return;

    for (let round = 0; round < 2; round++) {
      for (let step = 0; step < game.players.length; step++) {
        const index = (game.dealerIndex + 1 + step) % game.players.length;
        if (game.players[index].chips > 0) game.players[index].cards.push(game.deck.shift());
      }
    }

    let smallIndex;
    let bigIndex;
    if (inHand.length === 2) {
      smallIndex = game.dealerIndex;
      bigIndex = occupiedFrom(smallIndex);
    } else {
      smallIndex = occupiedFrom(game.dealerIndex);
      bigIndex = occupiedFrom(smallIndex);
    }
    game.smallIndex = smallIndex;
    game.bigIndex = bigIndex;
    game.heroHand = {
      startChips: hero.chips, vpip: false, pfr: false, showdown: false, won: false,
      position: heroPositionLabel(), recorded: false
    };
    addLog(`第 <strong>${game.handNo}</strong> 手开始 · ${game.players[game.dealerIndex].name} 在庄位`, "system");
    // 锦标赛前注：直接进入底池，不计入当前下注额。
    if (game.ante > 0) {
      let anteTotal = 0;
      game.players.forEach((p) => {
        if (p.folded || p.chips <= 0) return;
        const paid = Math.min(game.ante, p.chips);
        p.chips -= paid;
        p.totalInvested += paid;
        anteTotal += paid;
        if (!p.chips) p.allIn = true;
      });
      if (anteTotal > 0) addLog(`每人投入前注 <strong>${formatChips(game.ante)}</strong>`, "system");
    }
    postBlind(smallIndex, game.smallBlind, "小盲");
    postBlind(bigIndex, game.bigBlind, "大盲");
    game.currentBet = Math.max(...game.players.map((p) => p.bet));
    game.actingIndex = nextEligible(bigIndex);
    K.render();
    scheduleTurn();
  }

  function isRoundComplete() {
    const game = S.game;
    const canAct = game.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (!canAct.length) return true;
    if (canAct.length === 1 && canAct[0].bet === game.currentBet && game.players.some((p) => !p.folded && p.allIn)) return true;
    return canAct.every((p) => p.acted && p.bet === game.currentBet);
  }

  function scheduleTurn() {
    const game = S.game;
    clearTimeout(S.timer);
    if (!game || game.handOver || S.paused) return;
    const alive = game.players.filter((p) => !p.folded);
    if (alive.length === 1) { awardUncontested(alive[0]); return; }
    if (isRoundComplete()) { advanceStreet(); return; }

    let actor = game.players[game.actingIndex];
    if (!actor || actor.folded || actor.allIn || actor.chips <= 0) {
      game.actingIndex = nextEligible(game.actingIndex);
      actor = game.players[game.actingIndex];
    }
    if (!actor) { advanceStreet(); return; }
    K.render();
    if (actor.human) enableHumanTurn();
    else {
      disableActions();
      const speed = { fast: [220, 500], natural: [650, 1300], slow: [1200, 2300] }[game.thinkSpeed];
      S.timer = setTimeout(() => K.takeAiTurn(actor), randomBetween(speed[0], speed[1]));
    }
  }

  function performAction(player, type, target = 0) {
    const game = S.game;
    if (!game || game.handOver) return;
    const previousBet = game.currentBet;
    const potBefore = potSize();
    const investedBefore = player.totalInvested;
    const raisesBefore = game.streetRaiseCount || 0;
    let message = "";
    if (type === "fold") {
      player.folded = true;
      player.acted = true;
      player.lastAction = "弃牌";
      message = `<strong>${player.name}</strong> 弃牌`;
    } else if (type === "check") {
      player.acted = true;
      player.lastAction = "过牌";
      message = `<strong>${player.name}</strong> 过牌`;
    } else if (type === "call") {
      const needed = Math.max(0, game.currentBet - player.bet);
      const paid = Math.min(needed, player.chips);
      player.chips -= paid; player.bet += paid; player.totalInvested += paid; player.acted = true;
      if (!player.chips) player.allIn = true;
      player.lastAction = player.allIn ? "跟注全下" : "跟注";
      message = `<strong>${player.name}</strong> ${player.allIn ? "跟注全下" : "跟注"} ${formatChips(paid)}`;
    } else if (type === "raise") {
      const desired = clamp(Math.round(target), game.currentBet + 1, player.bet + player.chips);
      const paid = desired - player.bet;
      player.chips -= paid; player.bet = desired; player.totalInvested += paid;
      if (!player.chips) player.allIn = true;
      const raiseSize = player.bet - previousBet;
      const fullRaise = raiseSize >= game.minRaise;
      game.players.forEach((p) => {
        if (p.id === player.id || p.folded || p.allIn) return;
        if (fullRaise) {
          p.acted = false;
          p.raiseLocked = false;
        } else if (p.bet < player.bet) {
          if (p.acted) p.raiseLocked = true;
          p.acted = false;
        }
      });
      if (fullRaise) game.minRaise = raiseSize;
      game.currentBet = player.bet;
      player.acted = true;
      player.lastAction = player.allIn ? "全下" : previousBet ? "加注" : "下注";
      message = `<strong>${player.name}</strong> ${player.lastAction}到 ${formatChips(player.bet)}`;
    }

    if (player.human) {
      game.heroStats.actions++;
      if (type === "raise") game.heroStats.raises++;
      if (type === "call") game.heroStats.calls++;
      if (type === "fold") game.heroStats.folds++;
      if (game.street === "preflop" && (type === "call" || type === "raise")) game.heroHand.vpip = true;
      if (game.street === "preflop" && type === "raise") game.heroHand.pfr = true;
    }
    player.publicStats.actions++;
    if (type === "raise") player.publicStats.raises++;
    if (type === "call") player.publicStats.calls++;
    if (type === "fold") player.publicStats.folds++;
    K.updateRangeModel(player, type, player.totalInvested - investedBefore, potBefore, raisesBefore);
    if (type === "raise") game.streetRaiseCount = raisesBefore + 1;
    if (player.totalInvested > investedBefore) animateChipFlow(player, "to-pot");
    addLog(message);
    K.tone(type === "raise" ? 390 : type === "fold" ? 180 : 280);
    K.haptic(type === "raise" ? 24 : 12);
    game.actingIndex = nextEligible(game.actingIndex);
    K.render();
    S.timer = setTimeout(scheduleTurn, 180);
  }

  function advanceStreet() {
    const game = S.game;
    clearTimeout(S.timer);
    if (game.street === "river") { showdown(); return; }
    game.players.forEach((p) => { p.bet = 0; p.acted = false; p.raiseLocked = false; });
    game.currentBet = 0;
    game.minRaise = game.bigBlind;
    game.streetRaiseCount = 0;
    game.animateBoardFrom = game.community.length;
    game.deck.shift();
    if (game.street === "preflop") {
      game.street = "flop";
      game.community.push(game.deck.shift(), game.deck.shift(), game.deck.shift());
    } else if (game.street === "flop") {
      game.street = "turn";
      game.community.push(game.deck.shift());
    } else {
      game.street = "river";
      game.community.push(game.deck.shift());
    }
    addLog(`<strong>${K.STREET_NAMES[game.street]}</strong> · ${game.community.map(K.cardText).join(" ")}`, "system");
    game.actingIndex = nextEligible(game.dealerIndex);
    K.render();
    if (isRoundComplete()) S.timer = setTimeout(advanceStreet, 650);
    else S.timer = setTimeout(scheduleTurn, 260);
  }

  function awardUncontested(winner) {
    const game = S.game;
    const pot = potSize();
    winner.chips += pot;
    winner.winner = true;
    animateChipFlow(winner, "from-pot");
    if (winner.human) game.heroHand.won = true;
    addLog(`<strong>${winner.name}</strong> 赢得 ${formatChips(pot)} · 其他玩家均已弃牌`, "win");
    K.haptic(winner.human ? [35, 45, 55] : 14);
    finishHand();
  }

  function showdown() {
    const game = S.game;
    const { bestHand, compareScore, calculateSidePots } = window.PokerCore;
    game.reveal = true;
    const contenders = game.players.filter((p) => !p.folded);
    if (!game.players[0].folded) game.heroHand.showdown = true;
    const results = new Map(contenders.map((p) => [p.id, bestHand([...p.cards, ...game.community])]));
    contenders.forEach((p) => addLog(`<strong>${p.name}</strong> 摊牌 ${p.cards.map(K.cardText).join(" ")} · ${results.get(p.id).name}`));

    const pots = calculateSidePots(
      game.players.map((p) => ({ id: p.id, amount: p.totalInvested })),
      game.players.filter((p) => p.folded).map((p) => p.id)
    );
    pots.forEach((pot, potIndex) => {
      const eligible = pot.eligibleIds.map((id) => game.players.find((p) => p.id === id));
      let winners = [eligible[0]];
      for (let i = 1; i < eligible.length; i++) {
        const cmp = compareScore(results.get(eligible[i].id).score, results.get(winners[0].id).score);
        if (cmp > 0) winners = [eligible[i]];
        else if (cmp === 0) winners.push(eligible[i]);
      }
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach((p) => { p.chips += share; p.winner = true; animateChipFlow(p, "from-pot"); });
      if (winners.some((p) => p.human)) game.heroHand.won = true;
      let remainder = pot.amount - share * winners.length;
      let cursor = game.dealerIndex;
      while (remainder > 0) {
        cursor = (cursor + 1) % game.players.length;
        if (winners.includes(game.players[cursor])) { game.players[cursor].chips++; remainder--; }
      }
      const potName = pots.length > 1 ? (potIndex === 0 ? "主池" : `边池 ${potIndex}`) : "底池";
      addLog(`<strong>${winners.map((p) => p.name).join("、")}</strong> 以 ${results.get(winners[0].id).name} 赢得${potName} ${formatChips(pot.amount)}`, "win");
    });
    if (game.heroHand.won) K.haptic([35, 45, 55]);
    finishHand();
  }

  function finishHand() {
    const game = S.game;
    game.handOver = true;
    game.street = "done";
    game.actingIndex = -1;
    K.recordTrainingHand();
    disableActions();
    if (game.mode === "tournament") K.eliminateBustedPlayers();
    K.render();
    const hero = game.players[0];
    if (hero.chips <= 0) setRescueMode();
    else if (game.tournamentWon) {
      els.turnLabel.textContent = "🏆 锦标赛冠军";
      els.handHint.textContent = `最终筹码 ${formatChips(hero.chips)}`;
      els.raise.disabled = false;
      els.raise.textContent = "再来一场";
      els.raise.dataset.mode = "next";
    } else {
      els.turnLabel.textContent = "本手已结束";
      els.handHint.textContent = `持有 ${formatChips(hero.chips)} 筹码`;
      els.raise.disabled = false;
      els.raise.textContent = "下一手";
      els.raise.dataset.mode = "next";
    }
  }

  function setRescueMode() {
    disableActions();
    els.turnLabel.textContent = "筹码已经用完";
    els.handHint.textContent = "可从系统领取救济筹码";
    els.raise.disabled = false;
    els.raise.textContent = "领取 2,000";
    els.raise.dataset.mode = "rescue";
    K.showToast("你可以免费领取 2,000 救济筹码");
  }

  function claimRescue() {
    const game = S.game;
    if (!game || game.players[0].chips > 0) return;
    game.players[0].chips = 2000;
    addLog("<strong>你</strong> 从系统领取了 2,000 救济筹码", "system");
    K.showToast("已领取 2,000 筹码");
    startHand();
  }

  function enableHumanTurn() {
    const game = S.game;
    const hero = game.players[0];
    const toCall = Math.max(0, game.currentBet - hero.bet);
    els.fold.disabled = false;
    els.call.disabled = false;
    els.call.textContent = toCall ? `跟注 ${formatChips(Math.min(toCall, hero.chips))}` : "过牌";
    const minTarget = Math.min(hero.bet + hero.chips, Math.max(game.currentBet + game.minRaise, game.bigBlind));
    const maxTarget = hero.bet + hero.chips;
    const canRaise = maxTarget > game.currentBet && !hero.raiseLocked;
    els.raise.disabled = !canRaise;
    els.raise.dataset.mode = "action";
    els.raise.textContent = game.currentBet ? "加注" : "下注";
    els.betSlider.disabled = !canRaise;
    els.betSlider.min = minTarget;
    els.betSlider.max = maxTarget;
    els.betSlider.step = Math.max(1, Math.round(game.smallBlind));
    els.betSlider.value = minTarget;
    els.betAmountLabel.textContent = formatChips(minTarget);
    els.quickBets.forEach((b) => b.disabled = !canRaise);
    if (els.allInBet) els.allInBet.disabled = !canRaise;
    // 轮次切换时收起精确输入框，避免残留到下一次行动。
    if (els.betInput && !els.betInput.hidden) els.betInput.hidden = true;
  }

  function disableActions() {
    els.fold.disabled = true;
    els.call.disabled = true;
    els.raise.disabled = true;
    els.betSlider.disabled = true;
    els.quickBets.forEach((b) => b.disabled = true);
    if (els.allInBet) els.allInBet.disabled = true;
    if (els.betInput) els.betInput.hidden = true;
    delete els.raise.dataset.mode;
  }

  K.nextEligible = nextEligible;
  K.occupiedFrom = occupiedFrom;
  K.activePlayers = activePlayers;
  K.potSize = potSize;
  K.animateChipFlow = animateChipFlow;
  K.heroPositionLabel = heroPositionLabel;
  K.postBlind = postBlind;
  K.startHand = startHand;
  K.isRoundComplete = isRoundComplete;
  K.scheduleTurn = scheduleTurn;
  K.performAction = performAction;
  K.advanceStreet = advanceStreet;
  K.awardUncontested = awardUncontested;
  K.showdown = showdown;
  K.finishHand = finishHand;
  K.setRescueMode = setRescueMode;
  K.claimRescue = claimRescue;
  K.enableHumanTurn = enableHumanTurn;
  K.disableActions = disableActions;
})();
