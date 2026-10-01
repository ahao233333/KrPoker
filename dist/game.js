(() => {
  "use strict";

  const { createDeck, compareScore, bestHand, calculateSidePots } = window.PokerCore;
  const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  const STREET_NAMES = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", done: "本手结束" };
  const NAMES = ["林默", "陈策", "许岚", "周野", "沈砚", "顾言", "程川", "叶舟", "陆遥", "苏禾", "江澈", "温宁"];

  const ARCHETYPES = [
    { name: "紧凶型", tightness: [.72, .9], aggression: [.66, .86], bluff: [.08, .22], risk: [.34, .58], trap: [.18, .38], mistake: [.02, .07] },
    { name: "松凶型", tightness: [.32, .56], aggression: [.72, .94], bluff: [.24, .44], risk: [.62, .9], trap: [.08, .24], mistake: [.06, .14] },
    { name: "稳健型", tightness: [.62, .8], aggression: [.42, .63], bluff: [.08, .2], risk: [.3, .52], trap: [.22, .42], mistake: [.02, .08] },
    { name: "跟注站", tightness: [.32, .55], aggression: [.18, .38], bluff: [.03, .12], risk: [.56, .82], trap: [.12, .3], mistake: [.08, .17] },
    { name: "诡诈型", tightness: [.45, .68], aggression: [.58, .82], bluff: [.3, .52], risk: [.48, .76], trap: [.34, .58], mistake: [.04, .12] },
    { name: "均衡型", tightness: [.52, .7], aggression: [.52, .7], bluff: [.16, .3], risk: [.44, .66], trap: [.18, .34], mistake: [.02, .07] },
    { name: "冒险型", tightness: [.26, .5], aggression: [.6, .86], bluff: [.2, .4], risk: [.78, .96], trap: [.06, .2], mistake: [.1, .2] }
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    setup: $("setupModal"), start: $("startButton"), leave: $("leaveButton"),
    aiCount: $("aiCount"), startingChips: $("startingChips"), blindLevel: $("blindLevel"), thinkSpeed: $("thinkSpeed"),
    opponentList: $("opponentList"), opponentCount: $("opponentCount"), seatLayer: $("seatLayer"), community: $("communityCards"), chipFx: $("chipFxLayer"),
    pot: $("potAmount"), handNumber: $("handNumber"), blindInfo: $("blindInfo"), handsPlayed: $("handsPlayed"), log: $("gameLog"),
    turnLabel: $("turnLabel"), handHint: $("handHint"), handInvestment: $("handInvestment"), betSlider: $("betSlider"), betAmountLabel: $("betAmountLabel"),
    fold: $("foldButton"), call: $("callButton"), raise: $("raiseButton"), quickBets: [...document.querySelectorAll("[data-pot]")],
    sound: $("soundButton"), toast: $("toast"), statsButton: $("statsButton"), statsModal: $("statsModal"), statsClose: $("statsClose"),
    statHands: $("statHands"), statVpip: $("statVpip"), statPfr: $("statPfr"), statShowdown: $("statShowdown"),
    statNet: $("statNet"), statNetBar: $("statNetBar"), positionStats: $("positionStats")
  };

  let game = null;
  let timer = null;
  let toastTimer = null;
  let paused = false;
  let aiWorker = null;
  let workerSequence = 0;
  const workerRequests = new Map();
  let soundEnabled = true;
  try { soundEnabled = localStorage.getItem("riverstone-sound") !== "off"; } catch (_) { /* file URLs may restrict storage */ }
  els.sound.textContent = `声音：${soundEnabled ? "开" : "关"}`;
  try {
    const savedSpeed = localStorage.getItem("riverstone-think-speed");
    if (["fast", "natural", "slow"].includes(savedSpeed)) els.thinkSpeed.value = savedSpeed;
  } catch (_) { /* use the default */ }

  function emptyTrainingStats() {
    return {
      hands: 0, vpip: 0, pfr: 0, showdowns: 0, showdownWins: 0, net: 0,
      positions: { BTN: { hands: 0, net: 0 }, SB: { hands: 0, net: 0 }, BB: { hands: 0, net: 0 }, Early: { hands: 0, net: 0 }, Middle: { hands: 0, net: 0 }, Late: { hands: 0, net: 0 } }
    };
  }

  function loadTrainingStats() {
    try {
      const stored = JSON.parse(localStorage.getItem("riverstone-training-stats"));
      return stored?.positions ? { ...emptyTrainingStats(), ...stored, positions: { ...emptyTrainingStats().positions, ...stored.positions } } : emptyTrainingStats();
    } catch (_) { return emptyTrainingStats(); }
  }

  const trainingStats = loadTrainingStats();

  function persistTrainingStats() {
    try { localStorage.setItem("riverstone-training-stats", JSON.stringify(trainingStats)); } catch (_) { /* local persistence is optional */ }
  }

  function percentage(value, total) { return total ? `${Math.round(value / total * 100)}%` : "0%"; }

  function renderTrainingStats() {
    els.statHands.textContent = formatChips(trainingStats.hands);
    els.statVpip.textContent = percentage(trainingStats.vpip, trainingStats.hands);
    els.statPfr.textContent = percentage(trainingStats.pfr, trainingStats.hands);
    els.statShowdown.textContent = percentage(trainingStats.showdownWins, trainingStats.showdowns);
    els.statNet.textContent = `${trainingStats.net >= 0 ? "+" : ""}${formatChips(trainingStats.net)}`;
    els.statNet.parentElement?.classList.toggle("negative", trainingStats.net < 0);
    els.statNetBar.style.setProperty("--value", `${Math.min(100, Math.abs(trainingStats.net) / Math.max(1, trainingStats.hands * 40) * 100)}%`);
    els.positionStats.innerHTML = Object.entries(trainingStats.positions).map(([position, data]) =>
      `<div class="position-row"><span>${position} · ${data.hands} 手</span><strong>${data.net >= 0 ? "+" : ""}${formatChips(data.net)}</strong></div>`
    ).join("");
  }

  function recordTrainingHand() {
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

  function random() {
    const data = new Uint32Array(1);
    crypto.getRandomValues(data);
    return data[0] / 4294967296;
  }

  function randomBetween(min, max) { return min + (max - min) * random(); }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function formatChips(n) { return Math.round(n).toLocaleString("zh-CN"); }

  function shuffle(items, rng = random) { return window.PokerCore.shuffle(items, rng); }

  function createSimulationRng() {
    const seedData = new Uint32Array(1);
    crypto.getRandomValues(seedData);
    let seed = seedData[0] || 0x9e3779b9;
    return () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
  }

  function createProfile(index, usedTypes) {
    let options = ARCHETYPES.filter((a) => !usedTypes.has(a.name));
    if (!options.length) options = ARCHETYPES;
    const type = options[Math.floor(random() * options.length)];
    usedTypes.add(type.name);
    const value = (range) => randomBetween(range[0], range[1]);
    return Object.freeze({
      archetype: type.name,
      tightness: value(type.tightness), aggression: value(type.aggression), bluffRate: value(type.bluff),
      riskTolerance: value(type.risk), trapRate: value(type.trap), mistakeRate: value(type.mistake),
      patience: randomBetween(.35, .9), adaptiveness: randomBetween(.35, .92),
      rangeAccuracy: randomBetween(.55, .94), simulationCount: Math.round(randomBetween(260, 720)),
      fingerprint: `${Date.now().toString(36)}-${index}-${Math.floor(random() * 1e7).toString(36)}`
    });
  }

  function createPlayers(aiCount, buyIn) {
    const usedTypes = new Set();
    const names = shuffle(NAMES).slice(0, aiCount);
    const players = [{ id: "hero", name: "你", human: true, chips: buyIn, cards: [], bet: 0, totalInvested: 0, publicStats: { actions: 0, raises: 0, calls: 0, folds: 0 } }];
    names.forEach((name, index) => players.push({
      id: `ai-${index}-${Math.floor(random() * 1e6)}`, name, human: false, chips: buyIn,
      cards: [], bet: 0, totalInvested: 0, profile: createProfile(index, usedTypes), publicStats: { actions: 0, raises: 0, calls: 0, folds: 0 }
    }));
    return players;
  }

  function initAiWorker() {
    if (aiWorker) return;
    try {
      aiWorker = new Worker(new URL("./ai-worker.js", document.baseURI));
      aiWorker.onmessage = (event) => {
        const pending = workerRequests.get(event.data.id);
        if (!pending) return;
        workerRequests.delete(event.data.id);
        if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve(event.data.equity);
      };
      aiWorker.onerror = () => {
        workerRequests.forEach((pending) => pending.reject(new Error("worker unavailable")));
        workerRequests.clear();
        aiWorker.terminate();
        aiWorker = null;
      };
    } catch (_) { aiWorker = null; }
  }

  function adaptiveTrials(player, opponentCount) {
    const cores = navigator.hardwareConcurrency || 4;
    const deviceFactor = cores <= 4 ? .58 : cores <= 6 ? .78 : 1;
    const tableFactor = clamp(1.12 - opponentCount * .075, .52, 1);
    return Math.max(150, Math.round(player.profile.simulationCount * deviceFactor * tableFactor));
  }

  function opponentRangeModels(player) {
    return game.players.filter((opponent) => opponent.id !== player.id && !opponent.folded).map((opponent) => ({
      strengthBias: opponent.rangeModel.strengthBias * player.profile.rangeAccuracy,
      bluffMix: .18 + (opponent.rangeModel.bluffMix - .18) * player.profile.rangeAccuracy,
      rangeWidth: 1 - (1 - opponent.rangeModel.rangeWidth) * player.profile.rangeAccuracy
    }));
  }

  function estimateEquityAsync(player) {
    const models = opponentRangeModels(player);
    if (!models.length) return Promise.resolve(1);
    const request = {
      id: ++workerSequence,
      hole: player.cards,
      community: game.community,
      opponentModels: models,
      trials: adaptiveTrials(player, models.length),
      seed: Math.floor(random() * 4294967295)
    };
    if (aiWorker) {
      return new Promise((resolve, reject) => {
        workerRequests.set(request.id, { resolve, reject });
        aiWorker.postMessage(request);
      }).catch(() => window.PokerCore.estimateEquity({ ...request, rng: createSimulationRng() }));
    }
    return new Promise((resolve) => setTimeout(() => resolve(window.PokerCore.estimateEquity({ ...request, rng: createSimulationRng() })), 0));
  }

  function updateRangeModel(player, type, invested, potBefore, raisesBefore) {
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

  function isScareCard(card, board) {
    if (!card) return false;
    const highCard = card.rank >= 12;
    const paired = board.slice(0, -1).some((other) => other.rank === card.rank);
    const sameSuitCount = board.filter((other) => other.suit === card.suit).length;
    return highCard || paired || sameSuitCount >= 3;
  }

  function exploitAdjustments(player) {
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
    const highBlocker = player.cards.some((card) => card.rank >= 13) ? .16 : 0;
    const draw = window.PokerCore.drawPotential(player.cards, game.community);
    const suitBlocker = game.community.some((boardCard) =>
      player.cards.some((card) => card.rank === 14 && card.suit === boardCard.suit) &&
      game.community.filter((other) => other.suit === boardCard.suit).length >= 3
    ) ? .16 : 0;
    return clamp(.25 + highBlocker + draw * 1.7 + suitBlocker, .2, .92);
  }

  function positionAdjustment(player) {
    const index = game.players.indexOf(player);
    const distanceToButton = (game.dealerIndex - index + game.players.length) % game.players.length;
    if (index === game.dealerIndex || distanceToButton <= 1) return .045;
    if (distanceToButton >= Math.ceil(game.players.length * .65)) return -.035;
    return 0;
  }

  function updateStreetPlan(player, equity, exploit) {
    if (player.plan && player.plan.street === game.street) return player.plan;
    const previous = player.plan;
    const strength = window.PokerCore.currentStrength(player.cards, game.community);
    const draw = window.PokerCore.drawPotential(player.cards, game.community);
    let mode = "potControl";
    const valueThreshold = .72 - exploit.value + positionAdjustment(player);
    const balancedBluffRate = clamp(player.profile.bluffRate + exploit.bluff, .03, .56) * bluffCandidateScore(player);
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

  function nextEligible(from, predicate = (p) => p.chips > 0 && !p.folded && !p.allIn) {
    for (let step = 1; step <= game.players.length; step++) {
      const index = (from + step) % game.players.length;
      if (predicate(game.players[index])) return index;
    }
    return -1;
  }

  function occupiedFrom(from) {
    return nextEligible(from, (p) => p.chips > 0);
  }

  function activePlayers() { return game.players.filter((p) => !p.folded && (p.chips > 0 || p.totalInvested > 0)); }
  function potSize() { return game.players.reduce((sum, p) => sum + p.totalInvested, 0); }

  function animateChipFlow(player, direction) {
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
    if (game.dealerIndex === 0) return "BTN";
    if (game.smallIndex === 0) return "SB";
    if (game.bigIndex === 0) return "BB";
    const distance = (game.dealerIndex - 0 + game.players.length) % game.players.length;
    return distance <= Math.ceil(game.players.length / 3) ? "Late" : distance >= Math.floor(game.players.length * 2 / 3) ? "Early" : "Middle";
  }

  function postBlind(index, amount, label) {
    const p = game.players[index];
    const paid = Math.min(amount, p.chips);
    p.chips -= paid; p.bet += paid; p.totalInvested += paid;
    if (!p.chips) p.allIn = true;
    animateChipFlow(p, "to-pot");
    addLog(`<strong>${p.name}</strong> 投入${label} ${formatChips(paid)}`);
  }

  function startHand() {
    clearTimeout(timer);
    if (!game) return;
    const hero = game.players[0];
    if (hero.chips <= 0) { setRescueMode(); return; }
    game.players.forEach((p) => {
      if (!p.human && p.chips <= 0) {
        p.chips = game.buyIn;
        addLog(`<strong>${p.name}</strong> 补充到 ${formatChips(game.buyIn)} 筹码`, "system");
      }
      Object.assign(p, {
        cards: [], bet: 0, totalInvested: 0, folded: p.chips <= 0, allIn: false, acted: false,
        raiseLocked: false, lastAction: "", winner: false, plan: null, rangeModel: { strengthBias: 0, bluffMix: .16, rangeWidth: 1 }
      });
    });
    game.handNo++;
    game.handsPlayed++;
    game.street = "preflop";
    game.community = [];
    game.deck = shuffle(createDeck());
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
    postBlind(smallIndex, game.smallBlind, "小盲");
    postBlind(bigIndex, game.bigBlind, "大盲");
    game.currentBet = Math.max(...game.players.map((p) => p.bet));
    game.actingIndex = nextEligible(bigIndex);
    render();
    scheduleTurn();
  }

  function isRoundComplete() {
    const canAct = game.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (!canAct.length) return true;
    if (canAct.length === 1 && canAct[0].bet === game.currentBet && game.players.some((p) => !p.folded && p.allIn)) return true;
    return canAct.every((p) => p.acted && p.bet === game.currentBet);
  }

  function scheduleTurn() {
    clearTimeout(timer);
    if (!game || game.handOver || paused) return;
    const alive = game.players.filter((p) => !p.folded);
    if (alive.length === 1) { awardUncontested(alive[0]); return; }
    if (isRoundComplete()) { advanceStreet(); return; }

    let actor = game.players[game.actingIndex];
    if (!actor || actor.folded || actor.allIn || actor.chips <= 0) {
      game.actingIndex = nextEligible(game.actingIndex);
      actor = game.players[game.actingIndex];
    }
    if (!actor) { advanceStreet(); return; }
    render();
    if (actor.human) enableHumanTurn();
    else {
      disableActions();
      const speed = { fast: [220, 500], natural: [650, 1300], slow: [1200, 2300] }[game.thinkSpeed];
      timer = setTimeout(() => takeAiTurn(actor), randomBetween(speed[0], speed[1]));
    }
  }

  async function takeAiTurn(player) {
    if (!game || game.handOver || paused || game.players[game.actingIndex] !== player) return;
    const handToken = `${game.handNo}:${game.street}:${player.id}:${game.actingIndex}`;
    const rawEquity = await estimateEquityAsync(player);
    if (!game || game.handOver || paused || handToken !== `${game.handNo}:${game.street}:${player.id}:${game.actingIndex}` || game.players[game.actingIndex] !== player) return;
    const toCall = Math.max(0, game.currentBet - player.bet);
    const pot = potSize();
    const potOdds = toCall ? toCall / (pot + toCall) : 0;
    const profile = player.profile;
    const exploit = exploitAdjustments(player);
    const heroAggression = game.heroStats.raises / Math.max(1, game.heroStats.actions);
    const adaptation = (heroAggression - .28) * profile.adaptiveness * .08;
    const equity = clamp(rawEquity, .01, .99);
    const caution = (profile.tightness - .5) * .14 + adaptation;
    const error = (random() - .5) * profile.mistakeRate * .55;
    const edge = equity - potOdds - caution + error;
    const plan = updateStreetPlan(player, equity, exploit);
    const bluffing = plan.mode === "bluff" || plan.mode === "semiBluff";
    const strong = equity > (.58 + caution * .35);

    if (toCall > 0 && (plan.mode === "giveUp" || edge < (-.08 - profile.riskTolerance * .1)) && !bluffing) {
      performAction(player, "fold");
      return;
    }

    const canRaise = player.chips > toCall && !player.raiseLocked;
    if (plan.mode === "trap" && game.street !== "river" && toCall <= pot * .32 && random() < profile.trapRate + .28) {
      performAction(player, toCall ? "call" : "check");
      return;
    }
    const planFactor = plan.mode === "value" ? .94 : plan.mode === "semiBluff" ? .72 : plan.mode === "bluff" ? .58 : .16;
    const raiseChance = clamp(profile.aggression * (strong ? Math.max(.82, planFactor) : bluffing ? planFactor : .12) + exploit.aggression, .03, .97);
    if (canRaise && random() < raiseChance) {
      const basePot = Math.max(pot + toCall, game.bigBlind * 2);
      const sizing = plan.sizing;
      const target = Math.min(player.bet + player.chips, Math.max(game.currentBet + game.minRaise, game.currentBet + Math.round(basePot * sizing)));
      performAction(player, "raise", target);
    } else {
      performAction(player, toCall ? "call" : "check");
    }
  }

  function performAction(player, type, target = 0) {
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
    updateRangeModel(player, type, player.totalInvested - investedBefore, potBefore, raisesBefore);
    if (type === "raise") game.streetRaiseCount = raisesBefore + 1;
    if (player.totalInvested > investedBefore) animateChipFlow(player, "to-pot");
    addLog(message);
    tone(type === "raise" ? 390 : type === "fold" ? 180 : 280);
    haptic(type === "raise" ? 24 : 12);
    game.actingIndex = nextEligible(game.actingIndex);
    render();
    timer = setTimeout(scheduleTurn, 180);
  }

  function advanceStreet() {
    clearTimeout(timer);
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
    addLog(`<strong>${STREET_NAMES[game.street]}</strong> · ${game.community.map(cardText).join(" ")}`, "system");
    game.actingIndex = nextEligible(game.dealerIndex);
    render();
    if (isRoundComplete()) timer = setTimeout(advanceStreet, 650);
    else timer = setTimeout(scheduleTurn, 260);
  }

  function awardUncontested(winner) {
    const pot = potSize();
    winner.chips += pot;
    winner.winner = true;
    animateChipFlow(winner, "from-pot");
    if (winner.human) game.heroHand.won = true;
    addLog(`<strong>${winner.name}</strong> 赢得 ${formatChips(pot)} · 其他玩家均已弃牌`, "win");
    haptic(winner.human ? [35, 45, 55] : 14);
    finishHand();
  }

  function showdown() {
    game.reveal = true;
    const contenders = game.players.filter((p) => !p.folded);
    if (!game.players[0].folded) game.heroHand.showdown = true;
    const results = new Map(contenders.map((p) => [p.id, bestHand([...p.cards, ...game.community])]));
    contenders.forEach((p) => addLog(`<strong>${p.name}</strong> 摊牌 ${p.cards.map(cardText).join(" ")} · ${results.get(p.id).name}`));

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
    if (game.heroHand.won) haptic([35, 45, 55]);
    finishHand();
  }

  function finishHand() {
    game.handOver = true;
    game.street = "done";
    game.actingIndex = -1;
    recordTrainingHand();
    disableActions();
    render();
    const hero = game.players[0];
    if (hero.chips <= 0) setRescueMode();
    else {
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
    showToast("你可以免费领取 2,000 救济筹码");
  }

  function claimRescue() {
    if (!game || game.players[0].chips > 0) return;
    game.players[0].chips = 2000;
    addLog("<strong>你</strong> 从系统领取了 2,000 救济筹码", "system");
    showToast("已领取 2,000 筹码");
    startHand();
  }

  function enableHumanTurn() {
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
  }

  function disableActions() {
    els.fold.disabled = true;
    els.call.disabled = true;
    els.raise.disabled = true;
    els.betSlider.disabled = true;
    els.quickBets.forEach((b) => b.disabled = true);
    delete els.raise.dataset.mode;
  }

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
    if (!game) return;
    const currentPot = potSize();
    els.pot.textContent = formatChips(currentPot);
    if (game.lastRenderedPot != null && game.lastRenderedPot !== currentPot) {
      els.pot.classList.remove("pot-pop");
      void els.pot.offsetWidth;
      els.pot.classList.add("pot-pop");
    }
    game.lastRenderedPot = currentPot;
    els.handNumber.textContent = `第 ${game.handNo} 手 · ${STREET_NAMES[game.street] || "准备中"}`;
    els.handsPlayed.textContent = game.handsPlayed;
    els.blindInfo.textContent = `${game.smallBlind} / ${game.bigBlind}`;
    els.handInvestment.textContent = `本手已投入 ${formatChips(game.players[0].totalInvested)}`;
    els.community.innerHTML = [0, 1, 2, 3, 4].map((i) =>
      renderCard(game.community[i], false, game.animateBoardFrom != null && i >= game.animateBoardFrom ? i - game.animateBoardFrom : null)
    ).join("");
    renderSeats();
    game.animateBoardFrom = null;
    if (!game.handOver && game.actingIndex >= 0) {
      const actor = game.players[game.actingIndex];
      els.turnLabel.textContent = actor.human ? "轮到你行动" : `${actor.name} 正在思考`;
      const heroResult = bestHand([...game.players[0].cards, ...game.community]);
      els.handHint.textContent = heroResult ? heroResult.name : "观察位置与下注尺度";
    }
  }

  function renderSeats() {
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
      return `<div class="seat ${isActor ? "active" : ""} ${p.folded ? "folded" : ""} ${p.winner ? "winner" : ""} ${isActor && !p.human ? "ai-thinking" : ""}" style="left:${x}%;top:${y}%">
        <div class="seat-cards">${cards}</div>
        <div class="seat-box">${dealer}<div class="seat-name"><span>${p.name}</span></div><div class="seat-chips ${chipChanged ? "chip-change" : ""}">${formatChips(p.chips)}</div>${p.lastAction ? `<div class="seat-bet">${p.lastAction}${p.bet ? ` · ${formatChips(p.bet)}` : ""}</div>` : p.bet ? `<div class="seat-bet">${formatChips(p.bet)}</div>` : ""}</div>
      </div>`;
    }).join("");
    game.animateHoleCards = false;
  }

  function renderOpponents() {
    const opponents = game.players.slice(1);
    els.opponentCount.textContent = opponents.length;
    els.opponentList.innerHTML = opponents.map((p) => `<article class="opponent-row">
      <div class="opponent-head"><span class="mini-avatar">${p.name[0]}</span><div><strong>${p.name}</strong><small>本桌参数已锁定</small></div></div>
    </article>`).join("");
  }

  function addLog(html, type = "") {
    if (!game) return;
    if (els.log.querySelector(".empty-state")) els.log.innerHTML = "";
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.innerHTML = html;
    els.log.prepend(entry);
    while (els.log.children.length > 50) els.log.lastElementChild.remove();
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("show");
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  function tone(frequency) {
    if (!soundEnabled) return;
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

  function openTable() {
    const aiCount = Number(els.aiCount.value);
    const buyIn = Number(els.startingChips.value);
    const smallBlind = Number(els.blindLevel.value);
    game = {
      players: createPlayers(aiCount, buyIn), buyIn, smallBlind, bigBlind: smallBlind * 2,
      thinkSpeed: els.thinkSpeed.value, dealerIndex: -1, actingIndex: -1, handNo: 0, handsPlayed: 0,
      street: "idle", community: [], deck: [], currentBet: 0, minRaise: smallBlind * 2,
      heroStats: { actions: 0, raises: 0, calls: 0, folds: 0 }, reveal: false, handOver: true,
      lastRenderedChips: new Map(), lastRenderedPot: null, animateBoardFrom: null, animateHoleCards: false
    };
    initAiWorker();
    els.setup.classList.add("hidden");
    els.leave.hidden = false;
    els.log.innerHTML = "";
    renderOpponents();
    addLog(`${aiCount} 位 AI 已入座；人格参数将在你离桌前保持不变。`, "system");
    startHand();
  }

  function leaveTable() {
    clearTimeout(timer);
    game = null;
    els.setup.classList.remove("hidden");
    els.leave.hidden = true;
    els.seatLayer.innerHTML = "";
    els.community.innerHTML = [0, 1, 2, 3, 4].map(() => renderCard(null)).join("");
    els.pot.textContent = "0";
    els.handNumber.textContent = "等待开桌";
    els.turnLabel.textContent = "先设置牌桌";
    els.handHint.textContent = "—";
    els.handInvestment.textContent = "本手已投入 0";
    els.opponentCount.textContent = "0";
    els.opponentList.innerHTML = '<div class="empty-state">开桌后，这里会记录每位对手的固定风格。</div>';
    els.log.innerHTML = '<div class="empty-state">行动与结算会出现在这里。</div>';
    disableActions();
  }

  els.start.addEventListener("click", openTable);
  els.leave.addEventListener("click", leaveTable);
  els.statsButton.addEventListener("click", () => { renderTrainingStats(); els.statsModal.classList.remove("hidden"); });
  els.statsClose.addEventListener("click", () => els.statsModal.classList.add("hidden"));
  els.statsModal.addEventListener("click", (event) => { if (event.target === els.statsModal) els.statsModal.classList.add("hidden"); });
  els.sound.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    try { localStorage.setItem("riverstone-sound", soundEnabled ? "on" : "off"); } catch (_) { /* non-persistent fallback */ }
    els.sound.textContent = `声音：${soundEnabled ? "开" : "关"}`;
  });
  function setThinkSpeed(value) {
    if (!["fast", "natural", "slow"].includes(value)) return;
    els.thinkSpeed.value = value;
    if (game) game.thinkSpeed = value;
    try { localStorage.setItem("riverstone-think-speed", value); } catch (_) { /* non-persistent fallback */ }
    if (game && !game.handOver && !paused && !game.players[game.actingIndex]?.human) {
      clearTimeout(timer);
      timer = setTimeout(scheduleTurn, 40);
    }
  }
  els.thinkSpeed.addEventListener("change", (event) => setThinkSpeed(event.target.value));
  els.fold.addEventListener("click", () => { if (game?.players[game.actingIndex]?.human) performAction(game.players[0], "fold"); });
  els.call.addEventListener("click", () => {
    if (!game?.players[game.actingIndex]?.human) return;
    const hero = game.players[0];
    performAction(hero, game.currentBet > hero.bet ? "call" : "check");
  });
  els.raise.addEventListener("click", () => {
    const mode = els.raise.dataset.mode;
    if (mode === "next") startHand();
    else if (mode === "rescue") claimRescue();
    else if (mode === "action" && game?.players[game.actingIndex]?.human) performAction(game.players[0], "raise", Number(els.betSlider.value));
  });
  els.betSlider.addEventListener("input", () => els.betAmountLabel.textContent = formatChips(Number(els.betSlider.value)));
  els.quickBets.forEach((button) => button.addEventListener("click", () => {
    if (!game) return;
    const hero = game.players[0];
    const target = clamp(game.currentBet + Math.round(potSize() * Number(button.dataset.pot)), Number(els.betSlider.min), hero.bet + hero.chips);
    els.betSlider.value = target;
    els.betAmountLabel.textContent = formatChips(target);
  }));
  document.addEventListener("keydown", (event) => {
    if (!game || !game.players[game.actingIndex]?.human || event.repeat) return;
    const key = event.key.toLowerCase();
    if (key === "f" && !els.fold.disabled) els.fold.click();
    if (key === "c" && !els.call.disabled) els.call.click();
    if (key === "r" && !els.raise.disabled) els.raise.click();
  });
  document.addEventListener("visibilitychange", () => {
    paused = document.hidden;
    if (paused) clearTimeout(timer);
    else if (game && !game.handOver) timer = setTimeout(scheduleTurn, 180);
  });

  els.community.innerHTML = [0, 1, 2, 3, 4].map(() => renderCard(null)).join("");
  renderTrainingStats();
})();
