(() => {
  "use strict";

  // AI 模块：人格生成、对手建模、胜率估算与决策。
  // 只依赖 K.state.game 与核心引擎，不直接接触 DOM。
  const K = window.KrPoker;
  const { clamp, random, randomBetween } = K;
  const S = K.state;

  function createProfile(index, usedTypes) {
    let options = K.ARCHETYPES.filter((a) => !usedTypes.has(a.name));
    if (!options.length) options = K.ARCHETYPES;
    const type = options[Math.floor(random() * options.length)];
    usedTypes.add(type.name);
    const value = (range) => randomBetween(range[0], range[1]);
    return {
      type: type.name, tightness: value(type.tightness), aggression: value(type.aggression),
      bluffRate: value(type.bluff), riskTolerance: value(type.risk), trapRate: value(type.trap),
      mistakeRate: value(type.mistake),
      adaptiveness: randomBetween(.35, .95), rangeAccuracy: randomBetween(.45, .98),
      simulationCount: Math.round(randomBetween(420, 980))
    };
  }

  function createPlayers(aiCount, buyIn) {
    const usedTypes = new Set();
    const names = K.shuffle(K.NAMES).slice(0, aiCount);
    const players = [{ id: "hero", name: "你", human: true, chips: buyIn, cards: [], bet: 0, totalInvested: 0, publicStats: { actions: 0, raises: 0, calls: 0, folds: 0 } }];
    names.forEach((name, index) => players.push({
      id: `ai-${index}-${Math.floor(random() * 1e6)}`, name, human: false, chips: buyIn,
      cards: [], bet: 0, totalInvested: 0, profile: createProfile(index, usedTypes), publicStats: { actions: 0, raises: 0, calls: 0, folds: 0 }
    }));
    return players;
  }

  // --- 胜率估算（后台 Worker，失败时回落到主线程） ---

  function initAiWorker() {
    if (S.aiWorker) return;
    try {
      S.aiWorker = new Worker(new URL("./ai-worker.js", document.baseURI));
      S.aiWorker.onmessage = (event) => {
        const pending = S.workerRequests.get(event.data.id);
        if (!pending) return;
        S.workerRequests.delete(event.data.id);
        if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve(event.data.equity);
      };
      S.aiWorker.onerror = () => {
        S.workerRequests.forEach((pending) => pending.reject(new Error("worker unavailable")));
        S.workerRequests.clear();
        S.aiWorker.terminate();
        S.aiWorker = null;
      };
    } catch (_) { S.aiWorker = null; }
  }

  function adaptiveTrials(player, opponentCount) {
    const cores = navigator.hardwareConcurrency || 4;
    const deviceFactor = cores <= 4 ? .58 : cores <= 6 ? .78 : 1;
    const tableFactor = clamp(1.12 - opponentCount * .075, .52, 1);
    return Math.max(150, Math.round(player.profile.simulationCount * deviceFactor * tableFactor));
  }

  function opponentRangeModels(player) {
    const game = S.game;
    return game.players.filter((opponent) => opponent.id !== player.id && !opponent.folded).map((opponent) => ({
      strengthBias: opponent.rangeModel.strengthBias * player.profile.rangeAccuracy,
      bluffMix: .18 + (opponent.rangeModel.bluffMix - .18) * player.profile.rangeAccuracy,
      rangeWidth: 1 - (1 - opponent.rangeModel.rangeWidth) * player.profile.rangeAccuracy
    }));
  }

  function estimateEquityAsync(player) {
    const game = S.game;
    const models = opponentRangeModels(player);
    if (!models.length) return Promise.resolve(1);
    const request = {
      id: ++S.workerSequence,
      hole: player.cards,
      community: game.community,
      opponentModels: models,
      trials: adaptiveTrials(player, models.length),
      seed: Math.floor(random() * 4294967295)
    };
    if (S.aiWorker) {
      return new Promise((resolve, reject) => {
        S.workerRequests.set(request.id, { resolve, reject });
        S.aiWorker.postMessage(request);
      }).catch(() => window.PokerCore.estimateEquity({ ...request, rng: K.createSimulationRng() }));
    }
    return new Promise((resolve) => setTimeout(() => resolve(window.PokerCore.estimateEquity({ ...request, rng: K.createSimulationRng() })), 0));
  }

  // --- 对手范围推断 ---

  function updateRangeModel(player, type, invested, potBefore, raisesBefore) {
    const game = S.game;
    const model = player.rangeModel;
    const sizing = invested / Math.max(game.bigBlind, potBefore || game.bigBlind);
    const positionFromDealer = (game.players.indexOf(player) - game.dealerIndex + game.players.length) % game.players.length;
    const earlyPosition = positionFromDealer > 0 && positionFromDealer <= Math.ceil(game.players.length / 3);
    let evidence = 0;
    if (game.street === "preflop") {
      const seatIndex = game.players.indexOf(player);
      const baseOpenWidth = seatIndex === game.dealerIndex ? .44 : seatIndex === game.smallIndex ? .38 : seatIndex === game.bigIndex ? .5 : earlyPosition ? .17 : .29;
      if (type === "raise") {
        evidence = .19 + Math.min(.16, sizing * .08) + (earlyPosition ? .06 : 0);
        const reRaiseFactor = raisesBefore >= 2 ? .25 : raisesBefore === 1 ? .48 : 1;
        const sizeFactor = clamp(1.12 - sizing * .08, .65, 1.05);
        model.rangeWidth = Math.min(model.rangeWidth, clamp(baseOpenWidth * reRaiseFactor * sizeFactor, .035, .62));
      } else if (type === "call") {
        evidence = .055 + Math.min(.05, sizing * .03);
        model.rangeWidth = Math.min(model.rangeWidth, raisesBefore ? clamp(baseOpenWidth + .16, .16, .58) : .62);
      }
      else if (type === "check") evidence = -.015;
    } else {
      if (type === "raise") evidence = .13 + Math.min(.2, sizing * .1);
      else if (type === "call") evidence = .045 + Math.min(.08, sizing * .04);
      else if (type === "check") evidence = -.04;
    }
    model.strengthBias = clamp(model.strengthBias + evidence, -.25, .92);
    const stats = player.publicStats;
    const observedRaiseRate = stats.raises / Math.max(1, stats.actions);
    model.bluffMix = clamp(.08 + observedRaiseRate * .72, .06, .46);
  }

  // --- 决策辅助 ---

  function strategyContext(player) {
    const core = window.PokerCore;
    const game = S.game;
    const live = K.activePlayers().filter((p) => p.id !== player.id);
    const stacks = [player.chips].concat(live.map((p) => p.chips)).filter((value) => value > 0);
    const pot = Math.max(K.potSize(), game.bigBlind);
    const bucket = core.stackDepthBucket(stacks, game.bigBlind);
    const opponents = Math.max(1, live.length);
    return {
      bucket,
      opponents,
      multiway: opponents >= 2,
      effectiveBb: core.effectiveStackBb(stacks, game.bigBlind),
      spr: core.spr(stacks, pot),
      // 短码更倾向于直接全下，深码更倾向于控池。
      pushFold: bucket === "critical" || bucket === "short",
      deep: bucket === "standard" || bucket === "deep"
    };
  }

  function isScareCard(card, board) {
    if (!card) return false;
    const highCard = card.rank >= 12;
    const paired = board.slice(0, -1).some((other) => other.rank === card.rank);
    const sameSuitCount = board.filter((other) => other.suit === card.suit).length;
    return highCard || paired || sameSuitCount >= 3;
  }

  function exploitAdjustments(player) {
    const game = S.game;
    const neutral = { bluff: 0, value: 0, aggression: 0, sizing: 0 };
    const hero = game.players[0];
    const stats = game.heroStats;
    if (hero.folded || stats.actions < 5) return neutral;
    const confidence = Math.min(1, stats.actions / 24) * player.profile.adaptiveness;
    const foldRate = stats.folds / Math.max(1, stats.actions);
    const callRate = stats.calls / Math.max(1, stats.actions);
    const raiseRate = stats.raises / Math.max(1, stats.actions);
    return {
      bluff: clamp((foldRate - .34) * .7 - Math.max(0, callRate - .48) * .5, -.16, .2) * confidence,
      value: clamp((callRate - .34) * .35, -.05, .16) * confidence,
      aggression: clamp((.2 - raiseRate) * .35 + (foldRate - .34) * .25, -.1, .16) * confidence,
      sizing: clamp((callRate - .38) * .45, -.12, .2) * confidence
    };
  }

  function bluffCandidateScore(player) {
    const game = S.game;
    const highBlocker = player.cards.some((card) => card.rank >= 13) ? .16 : 0;
    const draw = window.PokerCore.drawPotential(player.cards, game.community);
    const suitBlocker = game.community.some((boardCard) =>
      player.cards.some((card) => card.rank === 14 && card.suit === boardCard.suit) &&
      game.community.filter((other) => other.suit === boardCard.suit).length >= 3
    ) ? .16 : 0;
    return clamp(.25 + highBlocker + draw * 1.7 + suitBlocker, .2, .92);
  }

  function positionAdjustment(player) {
    const game = S.game;
    const index = game.players.indexOf(player);
    const distanceToButton = (game.dealerIndex - index + game.players.length) % game.players.length;
    if (index === game.dealerIndex || distanceToButton <= 1) return .045;
    if (distanceToButton >= Math.ceil(game.players.length * .65)) return -.035;
    return 0;
  }

  function updateStreetPlan(player, equity, exploit, context) {
    const game = S.game;
    if (player.plan && player.plan.street === game.street) return player.plan;
    const previous = player.plan;
    const strength = window.PokerCore.currentStrength(player.cards, game.community);
    const draw = window.PokerCore.drawPotential(player.cards, game.community);
    const info = context || strategyContext(player);
    let mode = "potControl";
    // 价值门槛随对手数量收紧，多人底池不再用单挑标准做价值下注。
    const valueThreshold = window.PokerCore.multiwayValueThreshold(.72, info.opponents) - exploit.value + positionAdjustment(player);
    let balancedBluffRate = clamp(player.profile.bluffRate + exploit.bluff, .03, .56) * bluffCandidateScore(player);
    // 多人底池诈唬成功率更低，深码也应收敛纯诈唬。
    if (info.multiway) balancedBluffRate *= .62;
    if (info.deep) balancedBluffRate *= .88;
    if (strength > .76 || equity > valueThreshold) mode = random() < player.profile.trapRate && game.street !== "river" ? "trap" : "value";
    else if (draw >= .13 && random() < player.profile.aggression) mode = "semiBluff";
    else if (strength < .4 && random() < balancedBluffRate) mode = "bluff";
    else if (strength < .3) mode = "giveUp";
    if (previous?.mode === "semiBluff" && strength > previous.strength + .14) mode = "value";
    if (previous?.mode === "bluff" && isScareCard(game.community[game.community.length - 1], game.community) && random() < player.profile.aggression) mode = "bluff";
    player.plan = {
      street: game.street, mode, strength, draw,
      sizing: mode === "value" ? randomBetween(.68, 1.08) + exploit.sizing : mode === "semiBluff" ? randomBetween(.48, .72) : mode === "bluff" ? randomBetween(.58, .9) - exploit.sizing * .35 : .36
    };
    return player.plan;
  }

  // --- 主决策入口 ---

  async function takeAiTurn(player) {
    const game = S.game;
    if (!game || game.handOver || S.paused || game.players[game.actingIndex] !== player) return;
    const handToken = `${game.handNo}:${game.street}:${player.id}:${game.actingIndex}`;
    const rawEquity = await estimateEquityAsync(player);
    if (!S.game || S.game.handOver || S.paused || handToken !== `${S.game.handNo}:${S.game.street}:${player.id}:${S.game.actingIndex}` || S.game.players[S.game.actingIndex] !== player) return;
    const toCall = Math.max(0, game.currentBet - player.bet);
    const pot = K.potSize();
    const potOdds = toCall ? toCall / (pot + toCall) : 0;
    const profile = player.profile;
    const exploit = exploitAdjustments(player);
    const context = strategyContext(player);
    const heroAggression = game.heroStats.raises / Math.max(1, game.heroStats.actions);
    const adaptation = (heroAggression - .28) * profile.adaptiveness * .08;
    const equity = clamp(rawEquity, .01, .99);
    const caution = (profile.tightness - .5) * .14 + adaptation;
    const error = (random() - .5) * profile.mistakeRate * .55;
    const edge = equity - potOdds - caution + error;
    const plan = updateStreetPlan(player, equity, exploit, context);
    const bluffing = plan.mode === "bluff" || plan.mode === "semiBluff";
    // 多人底池需要更强的牌力才值得继续投入。
    const valueBar = window.PokerCore.multiwayValueThreshold(.58, context.opponents) + caution * .35;
    const strong = equity > valueBar;

    if (toCall > 0 && (plan.mode === "giveUp" || edge < (-.08 - profile.riskTolerance * .1)) && !bluffing) {
      K.performAction(player, "fold");
      return;
    }

    const canRaise = player.chips > toCall && !player.raiseLocked;
    if (plan.mode === "trap" && game.street !== "river" && toCall <= pot * .32 && random() < profile.trapRate + .28) {
      K.performAction(player, toCall ? "call" : "check");
      return;
    }

    // 短码：牌力足够时直接全下，而不是反复小额加注留下尴尬的后手筹码。
    if (context.pushFold && strong && canRaise && player.chips <= pot * 1.35) {
      const commitChance = clamp(profile.aggression * .82 + (equity - valueBar) * 1.5, .12, .94);
      if (random() < commitChance) {
        K.performAction(player, "raise", player.bet + player.chips);
        return;
      }
    }

    const planFactor = plan.mode === "value" ? .94 : plan.mode === "semiBluff" ? .72 : plan.mode === "bluff" ? .58 : .16;
    let raiseChance = clamp(profile.aggression * (strong ? Math.max(.82, planFactor) : bluffing ? planFactor : .12) + exploit.aggression, .03, .97);
    // 深码时对大额投入更谨慎，降低纯诈唬的加注频率。
    if (context.deep && bluffing) raiseChance *= .82;
    if (canRaise && random() < raiseChance) {
      const basePot = Math.max(pot + toCall, game.bigBlind * 2);
      let sizing = plan.sizing;
      // SPR 偏低时用更大的尺度，把决策简化成明确的承诺。
      if (context.spr <= 3) sizing = Math.min(1.35, sizing * 1.25);
      const target = Math.min(player.bet + player.chips, Math.max(game.currentBet + game.minRaise, game.currentBet + Math.round(basePot * sizing)));
      K.performAction(player, "raise", target);
    } else {
      K.performAction(player, toCall ? "call" : "check");
    }
  }

  K.createProfile = createProfile;
  K.createPlayers = createPlayers;
  K.initAiWorker = initAiWorker;
  K.adaptiveTrials = adaptiveTrials;
  K.opponentRangeModels = opponentRangeModels;
  K.estimateEquityAsync = estimateEquityAsync;
  K.updateRangeModel = updateRangeModel;
  K.strategyContext = strategyContext;
  K.isScareCard = isScareCard;
  K.exploitAdjustments = exploitAdjustments;
  K.bluffCandidateScore = bluffCandidateScore;
  K.positionAdjustment = positionAdjustment;
  K.updateStreetPlan = updateStreetPlan;
  K.takeAiTurn = takeAiTurn;
})();
