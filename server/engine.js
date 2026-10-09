"use strict";

// 服务端桌流引擎：规则与 dist/poker-table.js 保持一致，去 DOM/AI。
// 输出只有两类钩子：log（牌局记录）与 broadcast（脱敏状态），传输层在 index.js。
// PokerCore 由 index.js 加载到 globalThis 后再 require 本模块。

const PokerCore = () => globalThis.PokerCore;

const TURN_TIMEOUT = 45000;          // 在线玩家行动时限
const TURN_TIMEOUT_OFFLINE = 8000;   // 掉线玩家更快自动弃牌，不拖累牌桌
const NEXT_HAND_DELAY = 8000;
const STREET_DELAY = 700;
const RUNOUT_DELAY = 1400;           // 全下跑牌时每条街的停顿
const MAX_SEATS = 9;

const STREET_NAMES = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", done: "本手结束" };
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const formatChips = (n) => Math.round(n).toLocaleString("zh-CN");
const cardText = (card) => `${RANK_LABEL[card.rank] || card.rank}${card.suit}`;
// 脱敏占位牌：客户端只会以背面渲染，rank/suit 不会被读取。
const HIDDEN_CARD = { rank: 0, suit: "" };

function random() {
  const data = new Uint32Array(1);
  require("crypto").randomFillSync(data);
  return data[0] / 4294967296;
}

function shuffleDeck() {
  const deck = PokerCore().createDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const held = deck[i]; deck[i] = deck[j]; deck[j] = held;
  }
  return deck;
}

// hooks: { log(html, type), broadcast(), isOnline(playerId) }
function createTable(options, hooks) {
  const game = {
    players: [],
    smallBlind: options.smallBlind,
    bigBlind: options.smallBlind * 2,
    buyIn: options.buyIn,
    dealerIndex: -1, actingIndex: -1,
    handNo: 0, handsPlayed: 0,
    street: "idle", community: [], deck: [],
    currentBet: 0, minRaise: options.smallBlind * 2, streetRaiseCount: 0,
    reveal: false, handOver: true, started: false
  };
  let turnTimer = null;
  let stepTimer = null;
  let nextHandTimer = null;
  let destroyed = false;

  const log = (html, type) => hooks.log(html, type || "");

  function seatedCount() {
    return game.players.filter((p) => !p.left).length;
  }

  function nextEligible(from, predicate = (p) => p.chips > 0 && !p.folded && !p.allIn) {
    for (let step = 1; step <= game.players.length; step++) {
      const index = (from + step) % game.players.length;
      if (predicate(game.players[index])) return index;
    }
    return -1;
  }

  const occupiedFrom = (from) => nextEligible(from, (p) => p.chips > 0);
  const potSize = () => game.players.reduce((sum, p) => sum + p.totalInvested, 0);

  function positionLabel(index) {
    if (index === game.dealerIndex) return "BTN";
    if (index === game.smallIndex) return "SB";
    if (index === game.bigIndex) return "BB";
    const n = game.players.length;
    const distance = (game.dealerIndex - index + n) % n;
    return distance <= Math.ceil(n / 3) ? "Late" : distance >= Math.floor(n * 2 / 3) ? "Early" : "Middle";
  }

  function postBlind(index, amount, label) {
    const p = game.players[index];
    const paid = Math.min(amount, p.chips);
    p.chips -= paid; p.bet += paid; p.totalInvested += paid;
    if (!p.chips) p.allIn = true;
    log(`<strong>${p.name}</strong> 投入${label} ${formatChips(paid)}`);
  }

  function startHand() {
    clearTimeout(stepTimer);
    clearTimeout(turnTimer);
    game.players = game.players.filter((p) => !p.left);
    if (game.players.filter((p) => p.chips > 0).length < 2) return;
    game.players.forEach((p) => {
      Object.assign(p, {
        cards: [], bet: 0, totalInvested: 0, folded: p.chips <= 0, allIn: false, acted: false,
        raiseLocked: false, lastAction: "", winner: false
      });
    });
    game.handNo++;
    game.handsPlayed++;
    game.street = "preflop";
    game.community = [];
    game.deck = shuffleDeck();
    game.currentBet = 0;
    game.minRaise = game.bigBlind;
    game.streetRaiseCount = 0;
    game.reveal = false;
    game.handOver = false;
    game.dealerIndex = occupiedFrom(game.dealerIndex);

    for (let round = 0; round < 2; round++) {
      for (let step = 0; step < game.players.length; step++) {
        const index = (game.dealerIndex + 1 + step) % game.players.length;
        if (game.players[index].chips > 0) game.players[index].cards.push(game.deck.shift());
      }
    }

    let smallIndex;
    let bigIndex;
    const inHand = game.players.filter((p) => p.chips > 0);
    if (inHand.length === 2) {
      smallIndex = game.dealerIndex;
      bigIndex = occupiedFrom(smallIndex);
    } else {
      smallIndex = occupiedFrom(game.dealerIndex);
      bigIndex = occupiedFrom(smallIndex);
    }
    game.smallIndex = smallIndex;
    game.bigIndex = bigIndex;
    game.players.forEach((p, index) => {
      p.hand = {
        startChips: p.chips, vpip: false, pfr: false, showdown: false, won: false,
        position: positionLabel(index), recorded: false
      };
    });
    log(`第 <strong>${game.handNo}</strong> 手开始 · ${game.players[game.dealerIndex].name} 在庄位`, "system");
    postBlind(smallIndex, game.smallBlind, "小盲");
    postBlind(bigIndex, game.bigBlind, "大盲");
    game.currentBet = Math.max(...game.players.map((p) => p.bet));
    game.actingIndex = nextEligible(bigIndex);
    scheduleTurn();
  }

  function isRoundComplete() {
    const canAct = game.players.filter((p) => !p.folded && !p.allIn && p.chips > 0);
    if (!canAct.length) return true;
    if (canAct.length === 1 && canAct[0].bet === game.currentBet && game.players.some((p) => !p.folded && p.allIn)) return true;
    return canAct.every((p) => p.acted && p.bet === game.currentBet);
  }

  function scheduleTurn() {
    clearTimeout(turnTimer);
    if (destroyed || game.handOver) return;
    const alive = game.players.filter((p) => !p.folded);
    if (alive.length === 1) { awardUncontested(alive[0]); return; }
    if (isRoundComplete()) { stepTimer = setTimeout(advanceStreet, STREET_DELAY); return; }

    let actor = game.players[game.actingIndex];
    if (!actor || actor.folded || actor.allIn || actor.chips <= 0) {
      game.actingIndex = nextEligible(game.actingIndex);
      actor = game.players[game.actingIndex];
    }
    if (!actor) { stepTimer = setTimeout(advanceStreet, STREET_DELAY); return; }
    hooks.broadcast();
    const timeout = hooks.isOnline(actor.id) ? TURN_TIMEOUT : TURN_TIMEOUT_OFFLINE;
    turnTimer = setTimeout(() => {
      const toCall = Math.max(0, game.currentBet - actor.bet);
      log(`<strong>${actor.name}</strong> 超时${toCall ? "弃牌" : "过牌"}`, "system");
      applyAction(actor, toCall ? "fold" : "check", 0);
    }, timeout);
  }

  function applyAction(player, type, target) {
    clearTimeout(turnTimer);
    const previousBet = game.currentBet;
    const raisesBefore = game.streetRaiseCount || 0;
    if (type === "fold") {
      player.folded = true;
      player.acted = true;
      player.lastAction = "弃牌";
      log(`<strong>${player.name}</strong> 弃牌`);
    } else if (type === "check") {
      player.acted = true;
      player.lastAction = "过牌";
      log(`<strong>${player.name}</strong> 过牌`);
    } else if (type === "call") {
      const needed = Math.max(0, game.currentBet - player.bet);
      const paid = Math.min(needed, player.chips);
      player.chips -= paid; player.bet += paid; player.totalInvested += paid; player.acted = true;
      if (!player.chips) player.allIn = true;
      player.lastAction = player.allIn ? "跟注全下" : "跟注";
      log(`<strong>${player.name}</strong> ${player.lastAction} ${formatChips(paid)}`);
    } else if (type === "raise") {
      // 非全下加注必须满足最小加注额；全下允许不足额，由 fullRaise 分支处理行动重开。
      const maxTarget = player.bet + player.chips;
      const minTarget = Math.min(maxTarget, game.currentBet + game.minRaise);
      const desired = clamp(Math.round(target), minTarget, maxTarget);
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
      log(`<strong>${player.name}</strong> ${player.lastAction}到 ${formatChips(player.bet)}`);
    }
    if (game.street === "preflop" && (type === "call" || type === "raise")) player.hand.vpip = true;
    if (game.street === "preflop" && type === "raise") player.hand.pfr = true;
    if (type === "raise") game.streetRaiseCount = raisesBefore + 1;
    game.actingIndex = nextEligible(game.actingIndex);
    scheduleTurn();
  }

  // 客户端行动入口：只在轮到该玩家时生效。
  function handleAction(playerId, type, target) {
    if (!game.started || game.handOver) return false;
    const actor = game.players[game.actingIndex];
    if (!actor || actor.id !== playerId) return false;
    if (!["fold", "check", "call", "raise"].includes(type)) return false;
    if (type === "check" && game.currentBet > actor.bet) return false;
    if (type === "call" && game.currentBet <= actor.bet) return false;
    if (type === "raise") {
      const toCall = Math.max(0, game.currentBet - actor.bet);
      if (actor.chips <= toCall || actor.raiseLocked) return false;
      if (!Number.isFinite(target)) return false;
    }
    applyAction(actor, type, target);
    return true;
  }

  function advanceStreet() {
    clearTimeout(stepTimer);
    if (destroyed || game.handOver) return;
    if (game.street === "river") { showdown(); return; }
    game.players.forEach((p) => { p.bet = 0; p.acted = false; p.raiseLocked = false; });
    game.currentBet = 0;
    game.minRaise = game.bigBlind;
    game.streetRaiseCount = 0;
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
    log(`<strong>${STREET_NAMES[game.street]}</strong> · ${game.community.map(cardText).join(" ")}`, "system");
    game.actingIndex = nextEligible(game.dealerIndex);
    if (isRoundComplete()) {
      hooks.broadcast();
      stepTimer = setTimeout(advanceStreet, RUNOUT_DELAY);
    } else {
      scheduleTurn();
    }
  }

  function awardUncontested(winner) {
    const pot = potSize();
    winner.chips += pot;
    winner.winner = true;
    if (winner.hand) winner.hand.won = true;
    log(`<strong>${winner.name}</strong> 赢得 ${formatChips(pot)} · 其他玩家均已弃牌`, "win");
    finishHand();
  }

  function showdown() {
    const core = PokerCore();
    game.reveal = true;
    const contenders = game.players.filter((p) => !p.folded);
    contenders.forEach((p) => { if (p.hand) p.hand.showdown = true; });
    const results = new Map(contenders.map((p) => [p.id, core.bestHand([...p.cards, ...game.community])]));
    contenders.forEach((p) => log(`<strong>${p.name}</strong> 摊牌 ${p.cards.map(cardText).join(" ")} · ${results.get(p.id).name}`));

    const pots = core.calculateSidePots(
      game.players.map((p) => ({ id: p.id, amount: p.totalInvested })),
      game.players.filter((p) => p.folded).map((p) => p.id)
    );
    pots.forEach((pot, potIndex) => {
      const eligible = pot.eligibleIds.map((id) => game.players.find((p) => p.id === id));
      let winners = [eligible[0]];
      for (let i = 1; i < eligible.length; i++) {
        const cmp = core.compareScore(results.get(eligible[i].id).score, results.get(winners[0].id).score);
        if (cmp > 0) winners = [eligible[i]];
        else if (cmp === 0) winners.push(eligible[i]);
      }
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach((p) => { p.chips += share; p.winner = true; if (p.hand) p.hand.won = true; });
      let remainder = pot.amount - share * winners.length;
      let cursor = game.dealerIndex;
      while (remainder > 0) {
        cursor = (cursor + 1) % game.players.length;
        if (winners.includes(game.players[cursor])) { game.players[cursor].chips++; remainder--; }
      }
      const potName = pots.length > 1 ? (potIndex === 0 ? "主池" : `边池 ${potIndex}`) : "底池";
      log(`<strong>${winners.map((p) => p.name).join("、")}</strong> 以 ${results.get(winners[0].id).name} 赢得${potName} ${formatChips(pot.amount)}`, "win");
    });
    finishHand();
  }

  function finishHand() {
    game.handOver = true;
    game.street = "done";
    game.actingIndex = -1;
    clearTimeout(turnTimer);
    // 朋友局现金桌：破产自动补回买入，免得有人提前出局看戏。
    game.players.forEach((p) => {
      if (p.chips <= 0 && !p.left) {
        p.chips = game.buyIn;
        log(`<strong>${p.name}</strong> 补充到 ${formatChips(game.buyIn)} 筹码`, "system");
      }
    });
    hooks.broadcast();
    scheduleNextHand();
  }

  function scheduleNextHand() {
    clearTimeout(nextHandTimer);
    if (destroyed) return;
    nextHandTimer = setTimeout(() => {
      if (!game.handOver) return;
      if (game.players.filter((p) => !p.left && p.chips > 0).length >= 2) startHand();
    }, NEXT_HAND_DELAY);
  }

  // 中途入座：当前手以旁观身份坐下，下一手自动参与。
  function addPlayer(player) {
    if (seatedCount() >= MAX_SEATS) return null;
    const seated = {
      id: player.id, name: player.name,
      chips: game.buyIn, cards: [], bet: 0, totalInvested: 0,
      folded: true, allIn: false, acted: true, raiseLocked: false,
      lastAction: "", winner: false, left: false, hand: null
    };
    if (game.handOver || game.street === "idle") seated.folded = false;
    game.players.push(seated);
    return seated;
  }

  // 离桌：立即弃牌，手边界从数组移除；若轮到 TA 则推进。
  function removePlayer(playerId) {
    const player = game.players.find((p) => p.id === playerId);
    if (!player || player.left) return;
    player.left = true;
    if (!game.handOver && !player.folded) {
      player.folded = true;
      player.acted = true;
      log(`<strong>${player.name}</strong> 离桌弃牌`, "system");
      if (game.players[game.actingIndex]?.id === playerId) {
        game.actingIndex = nextEligible(game.actingIndex);
      }
      // 无论是否轮到 TA，弃牌都可能让轮次完成或只剩一人，统一重新评估。
      scheduleTurn();
    }
    if (game.handOver) game.players = game.players.filter((p) => !p.left);
  }

  // 以自己为 0 号位旋转并脱敏后的状态，客户端可直接套用现有渲染。
  function stateFor(playerId) {
    const myIndex = game.players.findIndex((p) => p.id === playerId);
    const n = game.players.length;
    const rotate = (index) => (index - myIndex + n) % n;
    const players = [];
    for (let offset = 0; offset < n; offset++) {
      const p = game.players[(myIndex + offset) % n];
      const self = offset === 0;
      const showCards = self || (game.reveal && !p.folded);
      players.push({
        id: p.id, name: p.name, human: self,
        chips: p.chips, bet: p.bet, totalInvested: p.totalInvested,
        folded: p.folded, allIn: p.allIn, raiseLocked: p.raiseLocked,
        lastAction: p.lastAction, winner: p.winner,
        cards: showCards ? p.cards : p.cards.map(() => HIDDEN_CARD)
      });
    }
    const me = game.players[myIndex];
    return {
      mode: "cash", online: true, started: game.started,
      smallBlind: game.smallBlind, bigBlind: game.bigBlind, ante: 0, buyIn: game.buyIn,
      handNo: game.handNo, handsPlayed: game.handsPlayed,
      street: game.street, community: game.community,
      currentBet: game.currentBet, minRaise: game.minRaise,
      dealerIndex: rotate(game.dealerIndex), smallIndex: rotate(game.smallIndex),
      bigIndex: rotate(game.bigIndex), actingIndex: game.actingIndex < 0 ? -1 : rotate(game.actingIndex),
      reveal: game.reveal, handOver: game.handOver,
      players,
      heroHand: me?.hand || null
    };
  }

  function destroy() {
    destroyed = true;
    clearTimeout(turnTimer);
    clearTimeout(stepTimer);
    clearTimeout(nextHandTimer);
  }

  return {
    game,
    start() {
      if (game.started || game.players.length < 2) return false;
      game.started = true;
      startHand();
      return true;
    },
    addPlayer, removePlayer, handleAction, stateFor,
    seatedCount, destroy,
    maybeStart: scheduleNextHand
  };
}

module.exports = { createTable, MAX_SEATS };
