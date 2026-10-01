(function (root) {
  "use strict";

  var SUITS = ["♠", "♥", "♦", "♣"];
  var RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  var HAND_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function createDeck() {
    return SUITS.reduce(function (deck, suit) {
      return deck.concat(RANKS.map(function (rank) { return { rank: rank, suit: suit }; }));
    }, []);
  }

  function shuffle(items, rng) {
    rng = rng || Math.random;
    var result = items.slice();
    for (var i = result.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var held = result[i]; result[i] = result[j]; result[j] = held;
    }
    return result;
  }

  function compareScore(a, b) {
    var length = Math.max(a.length, b.length);
    for (var i = 0; i < length; i++) {
      var difference = (a[i] || 0) - (b[i] || 0);
      if (difference) return difference;
    }
    return 0;
  }

  function evaluateFive(cards) {
    var ranks = cards.map(function (card) { return card.rank; }).sort(function (a, b) { return b - a; });
    var counts = new Map();
    ranks.forEach(function (rank) { counts.set(rank, (counts.get(rank) || 0) + 1); });
    var groups = Array.from(counts.entries()).sort(function (a, b) { return b[1] - a[1] || b[0] - a[0]; });
    var flush = cards.every(function (card) { return card.suit === cards[0].suit; });
    var unique = Array.from(new Set(ranks));
    if (unique.indexOf(14) >= 0) unique.push(1);
    var straightHigh = 0;
    for (var i = 0; i <= unique.length - 5; i++) {
      if (unique[i] - unique[i + 4] === 4) { straightHigh = unique[i]; break; }
    }
    var score;
    if (flush && straightHigh) score = [8, straightHigh];
    else if (groups[0][1] === 4) score = [7, groups[0][0], groups[1][0]];
    else if (groups[0][1] === 3 && groups[1][1] === 2) score = [6, groups[0][0], groups[1][0]];
    else if (flush) score = [5].concat(ranks);
    else if (straightHigh) score = [4, straightHigh];
    else if (groups[0][1] === 3) score = [3, groups[0][0]].concat(groups.slice(1).map(function (group) { return group[0]; }).sort(function (a, b) { return b - a; }));
    else if (groups[0][1] === 2 && groups[1][1] === 2) {
      var pairs = [groups[0][0], groups[1][0]].sort(function (a, b) { return b - a; });
      score = [2].concat(pairs, [groups.filter(function (group) { return group[1] === 1; })[0][0]]);
    } else if (groups[0][1] === 2) score = [1, groups[0][0]].concat(groups.slice(1).map(function (group) { return group[0]; }).sort(function (a, b) { return b - a; }));
    else score = [0].concat(ranks);
    return { score: score, name: HAND_NAMES[score[0]] };
  }

  function bestHand(cards) {
    if (cards.length < 5) return null;
    var best = null;
    function choose(start, picked) {
      if (picked.length === 5) {
        var result = evaluateFive(picked);
        if (!best || compareScore(result.score, best.score) > 0) best = result;
        return;
      }
      for (var i = start; i <= cards.length - (5 - picked.length); i++) choose(i + 1, picked.concat([cards[i]]));
    }
    choose(0, []);
    return best;
  }

  function cardKey(card) { return String(card.rank) + card.suit; }

  function preflopStrength(hole) {
    var high = Math.max(hole[0].rank, hole[1].rank);
    var low = Math.min(hole[0].rank, hole[1].rank);
    var pair = high === low;
    var suited = hole[0].suit === hole[1].suit;
    var gap = high - low;
    var score = (high - 2) / 18 + (low - 2) / 32;
    if (pair) score = .48 + (high - 2) / 20;
    if (suited) score += .07;
    if (gap === 1) score += .07;
    else if (gap === 2) score += .035;
    else if (gap >= 5) score -= .08;
    if (high === 14 && low >= 10) score += .1;
    return clamp(score, .03, .99);
  }

  function rankLabel(rank) {
    return rank === 14 ? "A" : rank === 13 ? "K" : rank === 12 ? "Q" : rank === 11 ? "J" : rank === 10 ? "T" : String(rank);
  }

  function startingHandClass(hole) {
    var highCard = hole[0].rank >= hole[1].rank ? hole[0] : hole[1];
    var lowCard = highCard === hole[0] ? hole[1] : hole[0];
    if (highCard.rank === lowCard.rank) return rankLabel(highCard.rank) + rankLabel(lowCard.rank);
    return rankLabel(highCard.rank) + rankLabel(lowCard.rank) + (highCard.suit === lowCard.suit ? "s" : "o");
  }

  var STARTING_HAND_MATRIX = (function () {
    var entries = [];
    for (var high = 14; high >= 2; high--) {
      entries.push({ key: rankLabel(high) + rankLabel(high), score: preflopStrength([{ rank: high, suit: "♠" }, { rank: high, suit: "♥" }]) });
      for (var low = high - 1; low >= 2; low--) {
        entries.push({ key: rankLabel(high) + rankLabel(low) + "s", score: preflopStrength([{ rank: high, suit: "♠" }, { rank: low, suit: "♠" }]) });
        entries.push({ key: rankLabel(high) + rankLabel(low) + "o", score: preflopStrength([{ rank: high, suit: "♠" }, { rank: low, suit: "♥" }]) });
      }
    }
    entries.sort(function (a, b) { return b.score - a.score || a.key.localeCompare(b.key); });
    return entries.map(function (entry, index) { return { key: entry.key, percentile: (index + 1) / entries.length, score: entry.score }; });
  })();

  var STARTING_HAND_PERCENTILES = STARTING_HAND_MATRIX.reduce(function (map, entry) {
    map[entry.key] = entry.percentile;
    return map;
  }, {});

  function startingHandPercentile(hole) {
    return STARTING_HAND_PERCENTILES[startingHandClass(hole)] || 1;
  }

  function drawPotential(hole, board) {
    if (board.length < 3) return 0;
    var cards = hole.concat(board);
    var suitCounts = {};
    cards.forEach(function (card) { suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1; });
    var flushDraw = Object.keys(suitCounts).some(function (suit) { return suitCounts[suit] === 4; });
    var ranks = Array.from(new Set(cards.map(function (card) { return card.rank; })));
    if (ranks.indexOf(14) >= 0) ranks.push(1);
    ranks.sort(function (a, b) { return a - b; });
    var straightDraw = false;
    for (var start = 1; start <= 10; start++) {
      var present = 0;
      for (var rank = start; rank < start + 5; rank++) if (ranks.indexOf(rank) >= 0) present++;
      if (present === 4) { straightDraw = true; break; }
    }
    return (flushDraw ? .18 : 0) + (straightDraw ? .13 : 0);
  }

  function currentStrength(hole, board) {
    if (board.length < 3) return preflopStrength(hole);
    var result = bestHand(hole.concat(board));
    var category = result.score[0] / 8;
    var kicker = (result.score[1] || 2) / 14;
    return clamp(category * .8 + kicker * .2 + drawPotential(hole, board), .02, .99);
  }

  function rangeWeight(hole, board, model) {
    model = model || {};
    var strength = board.length >= 3 ? currentStrength(hole, board) : preflopStrength(hole);
    var bias = clamp(model.strengthBias || 0, -.35, .95);
    var bluffMix = clamp(model.bluffMix == null ? .12 : model.bluffMix, .02, .55);
    var rangeWidth = clamp(model.rangeWidth == null ? 1 : model.rangeWidth, .025, 1);
    var percentile = startingHandPercentile(hole);
    var preflopGate = .035 + .965 / (1 + Math.exp((percentile - rangeWidth) * 32));
    var postflopWeight = Math.abs(bias) < .035
      ? .94
      : bias >= 0
        ? .04 + .96 * Math.pow(strength, .75 + bias * 3.2)
        : .15 + .85 * Math.pow(1 - strength, .8 + Math.abs(bias));
    var bluffWeight = .12 + .88 * (1 - strength);
    var actionWeight = postflopWeight * (1 - bluffMix) + bluffWeight * bluffMix;
    return clamp(preflopGate * actionWeight, .025, 1);
  }

  function takeWeightedHole(pool, board, model, rng) {
    var fallback = null;
    for (var attempt = 0; attempt < 18; attempt++) {
      var first = Math.floor(rng() * pool.length);
      var second = Math.floor(rng() * (pool.length - 1));
      if (second >= first) second++;
      var hole = [pool[first], pool[second]];
      fallback = [first, second, hole];
      if (rng() <= rangeWeight(hole, board, model)) break;
    }
    var indexes = [fallback[0], fallback[1]].sort(function (a, b) { return b - a; });
    indexes.forEach(function (index) { pool.splice(index, 1); });
    return fallback[2];
  }

  function estimateEquity(options) {
    var hole = options.hole;
    var community = options.community || [];
    var opponentModels = options.opponentModels || [];
    var trials = Math.max(1, options.trials || 300);
    var rng = options.rng || Math.random;
    if (!opponentModels.length) return 1;
    var known = new Set(hole.concat(community).map(cardKey));
    var available = createDeck().filter(function (card) { return !known.has(cardKey(card)); });
    var equity = 0;
    for (var trial = 0; trial < trials; trial++) {
      var pool = available.slice();
      var opponents = opponentModels.map(function (model) { return takeWeightedHole(pool, community, model, rng); });
      pool = shuffle(pool, rng);
      var board = community.slice();
      while (board.length < 5) board.push(pool.pop());
      var heroResult = bestHand(hole.concat(board));
      var beaten = false;
      var ties = 1;
      for (var i = 0; i < opponents.length; i++) {
        var opponentResult = bestHand(opponents[i].concat(board));
        var comparison = compareScore(heroResult.score, opponentResult.score);
        if (comparison < 0) { beaten = true; break; }
        if (comparison === 0) ties++;
      }
      if (!beaten) equity += 1 / ties;
    }
    return equity / trials;
  }

  // --- 第二版：筹码深度 / SPR ---

  // 以“大盲”为单位的有效筹码深度。用于区分短码、标准码和深码策略。
  function effectiveStackBb(stacks, bigBlind) {
    var values = (stacks || []).filter(function (value) { return typeof value === "number" && value > 0; });
    if (!values.length || !bigBlind) return 0;
    return Math.min.apply(null, values) / bigBlind;
  }

  // SPR = 有效筹码 / 底池。SPR 越低，顶对类牌力越值得投入全部筹码。
  function spr(stacks, pot) {
    var values = (stacks || []).filter(function (value) { return typeof value === "number" && value > 0; });
    if (!values.length) return 0;
    return pot > 0 ? Math.min.apply(null, values) / pot : Infinity;
  }

  // 按大盲深度归档，供策略分支使用。
  function stackDepthBucket(stacks, bigBlind) {
    var bb = effectiveStackBb(stacks, bigBlind);
    if (bb <= 0) return "unknown";
    if (bb <= 12) return "critical";
    if (bb <= 25) return "short";
    if (bb <= 45) return "medium";
    if (bb <= 90) return "standard";
    return "deep";
  }

  // 多人底池需要更紧的价值门槛：每个额外对手都显著降低胜率要求。
  function multiwayValueThreshold(baseThreshold, opponentCount) {
    var count = Math.max(0, (opponentCount || 0) - 1);
    return clamp(baseThreshold + count * .055, .3, .97);
  }

  function calculateSidePots(contributions, foldedIds) {
    var folded = new Set(foldedIds || []);
    var levels = Array.from(new Set(contributions.map(function (item) { return item.amount; }).filter(Boolean))).sort(function (a, b) { return a - b; });
    var previous = 0;
    return levels.map(function (level) {
      var contributors = contributions.filter(function (item) { return item.amount >= level; });
      var pot = {
        amount: (level - previous) * contributors.length,
        contributorIds: contributors.map(function (item) { return item.id; }),
        eligibleIds: contributors.filter(function (item) { return !folded.has(item.id); }).map(function (item) { return item.id; })
      };
      previous = level;
      return pot;
    }).filter(function (pot) { return pot.amount > 0 && pot.eligibleIds.length > 0; });
  }

  root.PokerCore = Object.freeze({
    SUITS: SUITS, RANKS: RANKS, HAND_NAMES: HAND_NAMES,
    createDeck: createDeck, shuffle: shuffle, compareScore: compareScore,
    evaluateFive: evaluateFive, bestHand: bestHand, cardKey: cardKey,
    preflopStrength: preflopStrength, startingHandClass: startingHandClass,
    startingHandPercentile: startingHandPercentile, startingHandMatrix: STARTING_HAND_MATRIX,
    drawPotential: drawPotential,
    currentStrength: currentStrength, estimateEquity: estimateEquity,
    effectiveStackBb: effectiveStackBb, spr: spr,
    stackDepthBucket: stackDepthBucket, multiwayValueThreshold: multiwayValueThreshold,
    calculateSidePots: calculateSidePots
  });
})(typeof self !== "undefined" ? self : this);
