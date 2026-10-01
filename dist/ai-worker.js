"use strict";

importScripts("./poker-core.js");

function seededRandom(seed) {
  var value = seed || 0x9e3779b9;
  return function () {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

self.onmessage = function (event) {
  var request = event.data;
  try {
    var equity = PokerCore.estimateEquity({
      hole: request.hole,
      community: request.community,
      opponentModels: request.opponentModels,
      trials: request.trials,
      rng: seededRandom(request.seed)
    });
    self.postMessage({ id: request.id, equity: equity });
  } catch (error) {
    self.postMessage({ id: request.id, error: String(error && error.message || error) });
  }
};
