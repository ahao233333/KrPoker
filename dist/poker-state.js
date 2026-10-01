(() => {
  "use strict";

  // 共享状态层：牌局状态、DOM 引用与通用工具。
  // 拆分为多模块后，这里集中管理唯一可变状态，避免各模块各持一份副本。
  const K = window.KrPoker = window.KrPoker || {};

  const $ = (id) => document.getElementById(id);

  K.RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  K.STREET_NAMES = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", done: "本手结束" };
  K.NAMES = ["林默", "陈策", "许岚", "周野", "沈砚", "顾言", "程川", "叶舟", "陆遥", "苏禾", "江澈", "温宁"];

  K.ARCHETYPES = [
    { name: "紧凶型", tightness: [.72, .9], aggression: [.66, .86], bluff: [.08, .22], risk: [.34, .58], trap: [.18, .38], mistake: [.02, .07] },
    { name: "松凶型", tightness: [.32, .56], aggression: [.72, .94], bluff: [.24, .44], risk: [.62, .9], trap: [.08, .24], mistake: [.06, .14] },
    { name: "稳健型", tightness: [.62, .8], aggression: [.42, .63], bluff: [.08, .2], risk: [.3, .52], trap: [.22, .42], mistake: [.02, .08] },
    { name: "跟注站", tightness: [.32, .55], aggression: [.18, .38], bluff: [.03, .12], risk: [.56, .82], trap: [.12, .3], mistake: [.08, .17] },
    { name: "诡诈型", tightness: [.45, .68], aggression: [.58, .82], bluff: [.3, .52], risk: [.48, .76], trap: [.34, .58], mistake: [.04, .12] },
    { name: "均衡型", tightness: [.52, .7], aggression: [.52, .7], bluff: [.16, .3], risk: [.44, .66], trap: [.18, .34], mistake: [.02, .07] },
    { name: "冒险型", tightness: [.26, .5], aggression: [.6, .86], bluff: [.2, .4], risk: [.78, .96], trap: [.06, .2], mistake: [.1, .2] }
  ];

  K.els = {
    setup: $("setupModal"), start: $("startButton"), leave: $("leaveButton"),
    aiCount: $("aiCount"), startingChips: $("startingChips"), blindLevel: $("blindLevel"), thinkSpeed: $("thinkSpeed"),
    gameMode: $("gameMode"), blindField: $("blindField"), tournamentNote: $("tournamentNote"),
    opponentList: $("opponentList"), opponentCount: $("opponentCount"), seatLayer: $("seatLayer"),
    community: $("communityCards"), chipFx: $("chipFxLayer"),
    pot: $("potAmount"), handNumber: $("handNumber"), blindInfo: $("blindInfo"), handsPlayed: $("handsPlayed"),
    log: $("gameLog"),
    turnLabel: $("turnLabel"), handHint: $("handHint"), handInvestment: $("handInvestment"),
    betSlider: $("betSlider"), betAmountLabel: $("betAmountLabel"), betInput: $("betInput"),
    betControl: $("betControl"),
    fold: $("foldButton"), call: $("callButton"), raise: $("raiseButton"),
    quickBets: [...document.querySelectorAll("[data-pot]")],
    allInBet: document.querySelector("[data-allin]"),
    sound: $("soundButton"), toast: $("toast"), statsButton: $("statsButton"),
    statsModal: $("statsModal"), statsClose: $("statsClose"),
    statHands: $("statHands"), statVpip: $("statVpip"), statPfr: $("statPfr"), statShowdown: $("statShowdown"),
    statNet: $("statNet"), statNetBar: $("statNetBar"), positionStats: $("positionStats"),
    tournamentHud: $("tournamentHud"), hudLevel: $("hudLevel"), hudNextLevel: $("hudNextLevel"),
    hudAverage: $("hudAverage"), hudPressure: $("hudPressure"), hudProgress: $("hudProgress")
  };

  // 唯一可变状态。各模块通过 K.state 读写，不各自持有副本。
  K.state = {
    game: null,
    timer: null,
    toastTimer: null,
    paused: false,
    soundEnabled: true,
    aiWorker: null,
    workerSequence: 0,
    workerRequests: new Map()
  };

  // --- 通用工具 ---

  K.random = function random() {
    const data = new Uint32Array(1);
    crypto.getRandomValues(data);
    return data[0] / 4294967296;
  };

  K.randomBetween = (min, max) => min + (max - min) * K.random();
  K.clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  K.formatChips = (n) => Math.round(n).toLocaleString("zh-CN");
  K.shuffle = (items, rng = K.random) => window.PokerCore.shuffle(items, rng);

  // 模拟专用随机源：可复现，避免消耗系统熵。
  K.createSimulationRng = function createSimulationRng() {
    const seedData = new Uint32Array(1);
    crypto.getRandomValues(seedData);
    let seed = seedData[0] || 0x9e3779b9;
    return function () {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
  };

  K.percentage = (value, total) => total ? `${Math.round(value / total * 100)}%` : "0%";

  // 锦标赛：按手数推进盲注级别并淘汰破产对手。
  K.updateTournamentBlinds = function updateTournamentBlinds() {
    const game = K.state.game;
    if (!game || game.mode !== "tournament") return;
    const level = window.PokerCore.tournamentLevel(game.handsPlayed);
    if (level.index !== game.levelIndex) {
      game.levelIndex = level.index;
      game.smallBlind = level.smallBlind;
      game.bigBlind = level.smallBlind * 2;
      game.ante = level.ante;
      game.minRaise = game.bigBlind;
      const anteNote = level.ante ? `，前注 ${level.ante}` : "";
      K.addLog(`<strong>盲注升到 ${level.smallBlind} / ${level.bigBlind}</strong>${anteNote}`, "system");
      K.showToast(`盲注升级：${level.smallBlind} / ${level.bigBlind}`);
      K.tone(520);
    }
  };

  K.eliminateBustedPlayers = function eliminateBustedPlayers() {
    const game = K.state.game;
    if (!game || game.mode !== "tournament") return false;
    let eliminated = false;
    game.players.forEach((p) => {
      if (!p.human && !p.eliminated && p.chips <= 0) {
        p.eliminated = true;
        p.placement = game.players.filter((other) => !other.eliminated).length + 1;
        K.addLog(`<strong>${p.name}</strong> 被淘汰（第 ${p.placement} 名）`, "system");
        eliminated = true;
      }
    });
    if (eliminated) {
      const survivors = game.players.filter((p) => !p.eliminated);
      if (survivors.length === 1 && survivors[0].human) {
        game.tournamentWon = true;
        K.addLog("<strong>你赢下了这场锦标赛！</strong>", "system");
        K.showToast("🏆 锦标赛冠军！");
      }
      K.renderOpponents();
    }
    return eliminated;
  };
})();
