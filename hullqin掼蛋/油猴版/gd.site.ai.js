/*!
 * gd.site.ai.js — 掼蛋 AI 助手（油猴版）· 本地启发式出牌
 *
 * 依赖全局 `GDSite`（浏览器）/ `require('./gd.site.core.js')`（Node）；契约见 SPEC2.md §3。
 * 纯逻辑、无 DOM、不联网。
 */
(function (root, factory) {
  const G = (typeof module !== 'undefined' && module.exports)
    ? require('./gd.site.core.js')
    : root.GDSite;
  const api = factory(G);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDSiteAI = api;
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  const BOMB_TYPES = {};
  BOMB_TYPES[G.TYPE.Four] = true;
  BOMB_TYPES[G.TYPE.Five] = true;
  BOMB_TYPES[G.TYPE.StraightFlush] = true;
  BOMB_TYPES[G.TYPE.Six] = true;
  BOMB_TYPES[G.TYPE.Seven] = true;
  BOMB_TYPES[G.TYPE.Eight] = true;
  BOMB_TYPES[G.TYPE.FourJokers] = true;

  function isBombType(type) {
    return !!BOMB_TYPES[type];
  }

  function countByRank(hand, level) {
    const lv = G.normLevel(level);
    const cnt = {};
    let wilds = 0;
    let levelCards = 0;
    (hand || []).forEach(function (c) {
      if (G.isWildCard(c, lv)) wilds += 1;
      const r = G.rankOf(c);
      if (r === lv) levelCards += 1;
      cnt[r] = (cnt[r] || 0) + 1;
    });
    return { cnt: cnt, wilds: wilds, levelCards: levelCards };
  }

  /**
   * 贪心估计「这手牌最少还要出几手」（用于比较出牌收益）。
   */
  function playsEstimate(hand, level) {
    const lv = G.normLevel(level);
    const cs = (hand || []).map(Number).filter(function (c) { return c >= 1 && c <= 108; });
    if (!cs.length) return 0;
    const info = countByRank(cs, lv);
    const cnt = info.cnt;
    const wildCount = info.wilds;
    let plays = 0;

    function take(r, n) {
      cnt[r] = Math.max(0, (cnt[r] || 0) - n);
    }

    // 王对子
    [17, 16].forEach(function (r) {
      if ((cnt[r] || 0) >= 2) { plays += 1; take(r, 2); }
    });

    // 炸弹（同点 4 张以上，一次出完）
    Object.keys(cnt).map(Number).forEach(function (r) {
      if (r < 16 && cnt[r] >= 4) { plays += 1; take(r, cnt[r]); }
    });

    // 顺子（只贪心自然牌，A 可当 1 或 14）
    let guard = 0;
    while (guard < 6) {
      guard += 1;
      let found = false;
      for (let b = 14; b >= 5 && !found; b--) {
        const pos = [];
        for (let P = b - 4; P <= b; P++) pos.push((P === 1 && b === 5) ? 14 : P);
        if (pos.every(function (r) { return (cnt[r] || 0) >= 1; })) {
          pos.forEach(function (r) { take(r, 1); });
          plays += 1;
          found = true;
        }
      }
      if (!found) break;
    }

    // 钢板（连续两组三张）
    guard = 0;
    while (guard < 4) {
      guard += 1;
      let found = false;
      for (let e = 14; e >= 2 && !found; e--) {
        const a = (e === 2) ? 14 : e - 1;
        if ((cnt[a] || 0) >= 3 && (cnt[e] || 0) >= 3) {
          take(a, 3); take(e, 3);
          plays += 1;
          found = true;
        }
      }
      if (!found) break;
    }

    // 三连对
    guard = 0;
    while (guard < 4) {
      guard += 1;
      let found = false;
      for (let e = 14; e >= 3 && !found; e--) {
        const win = [(e === 3) ? 14 : e - 2, e - 1, e];
        if (win.every(function (r) { return (cnt[r] || 0) >= 2; })) {
          win.forEach(function (r) { take(r, 2); });
          plays += 1;
          found = true;
        }
      }
      if (!found) break;
    }

    // 三带二：一组三张 + 一副对子合并为 1 手（比分出少 1 手）
    const triRanks = [], pairRanks = [];
    for (let r = 15; r >= 2; r--) if ((cnt[r] || 0) >= 3) triRanks.push(r);
    for (let r = 15; r >= 2; r--) if ((cnt[r] || 0) === 2) pairRanks.push(r);
    while (triRanks.length && pairRanks.length) {
      const tr = triRanks.shift();
      const pr = pairRanks.shift();
      take(tr, 3); take(pr, 2);
      plays += 1;
    }

    // 三张 / 对子 / 单张
    [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].forEach(function (r) {
      let left = cnt[r] || 0;
      while (left >= 3) { plays += 1; left -= 3; }
      if (left >= 2) { plays += 1; left = 0; }
      if (left === 1) { plays += 1; }
      cnt[r] = 0;
    });

    // 逢人配：优先并入现有的单张/对子减少手数，剩下一对算 1 手
    if (wildCount > 0) {
      const merged = Math.min(wildCount, plays);
      plays -= merged;
      const rest = wildCount - merged;
      if (rest > 0) plays += Math.ceil(rest / 2);
    }

    return Math.max(1, plays);
  }

  function countBombs(hand, level) {
    const lv = G.normLevel(level);
    const info = countByRank(hand, lv);
    const cnt = info.cnt;
    let bombs = 0;
    Object.keys(cnt).map(Number).forEach(function (r) {
      if (r < 16 && cnt[r] >= 4) bombs += 1;
    });
    if ((cnt[17] || 0) >= 2 && (cnt[16] || 0) >= 2) bombs += 1;
    return bombs;
  }

  function handSummary(hand, level) {
    const lv = G.normLevel(level);
    const cs = hand || [];
    const info = countByRank(cs, lv);
    return {
      size: cs.length,
      bombs: countBombs(cs, lv),
      wilds: info.wilds,
      levelCards: info.levelCards,
      playsEstimate: playsEstimate(cs, lv)
    };
  }

  function opponentThreat(state) {
    const partner = state.partnerSeat;
    const seats = state.seatsRemaining || [];
    let min = Infinity;
    let who = 0;
    seats.forEach(function (s) {
      if (s.isMe || s.isPartner || s.seat === partner) return;
      if (s.count > 0 && s.count < min) { min = s.count; who = s.seat; }
    });
    return { isThreat: min <= 3, count: min, seat: who };
  }

  /** 是否拆掉了手里的炸弹（单张/对子/三张从 4 张同点里抽牌） */
  function breaksBomb(play, hand, level) {
    if (play.bomb) return false;
    const lv = G.normLevel(level);
    const info = countByRank(hand, lv);
    const used = countByRank(play.cards, lv).cnt;
    let broke = false;
    Object.keys(used).forEach(function (key) {
      const r = Number(key);
      if (r < 16 && (info.cnt[r] || 0) >= 4) broke = true;
    });
    return broke;
  }

  /**
   * 给单个候选打分（越高越推荐）。
   * - 一手出完：10000
   * - 领出看重「减少手数」，跟牌看重「用最小代价压住」
   * - 逢人配、炸弹有保留成本；队友牌权时大幅降分
   */
  function scorePlay(play, state) {
    const lv = G.normLevel(state.level);
    const hand = state.hand || [];
    const prev = state.prevCode || 0;
    if (!play || !play.cards || !play.cards.length) return -1e9;
    if (play.size === hand.length) return 10000;

    const info = handSummary(hand, lv);
    const after = hand.filter(function (c) { return play.cards.indexOf(c) < 0; });
    const estAfter = playsEstimate(after, lv);
    const reduction = Math.max(0, info.playsEstimate - estAfter);
    const wildsUsed = play.cards.filter(function (c) { return G.isWildCard(c, lv); }).length;
    const rank = play.rank || 0;

    let score = 0;
    if (!prev) {
      score = reduction * 12 + play.size * 4 - rank * 0.3;
      if (play.bomb) score -= 20 + play.bomb * 2;
    } else {
      score = (14 - rank) * 0.4 + reduction * 8;
      if (play.bomb) score -= 30 + play.bomb * 2;
      const owner = state.trickOwner || 0;
      if (owner && G.sameTeam(owner, state.mySeat)) score -= 100;
      const threat = opponentThreat(state);
      if (threat.isThreat) score += 45 + play.size * 2 + (play.bomb ? 20 : 0);
    }
    score -= wildsUsed * 10;
    if (breaksBomb(play, hand, lv)) score -= 8;
    if (play.bomb && !prev && play.size >= 4) score -= 4;
    return Math.round(score * 100) / 100;
  }

  function tagOf(play, state) {
    if (play.size === (state.hand || []).length) return '一手出完';
    if (play.bomb) return '炸弹';
    if (!state.prevCode) return '领出';
    const threat = opponentThreat(state);
    if (threat.isThreat) return '拦截';
    return '跟牌';
  }

  function dedupeScored(list, limit) {
    const out = [];
    const seen = {};
    for (let i = 0; i < list.length && out.length < limit; i++) {
      const item = list[i];
      const key = item.play.type + '|' + item.play.rank + '|' + item.play.size;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(item);
    }
    return out;
  }

  function candidates(state, limit) {
    const lim = Math.max(1, Math.floor(Number(limit) || 12));
    const hand = state.hand || [];
    if (!hand.length) return [];
    const prev = state.prevCode || 0;
    const moves = G.genMoves(hand, state.level, prev);
    const scored = moves.map(function (play) {
      return { play: play, score: scorePlay(play, state), tag: tagOf(play, state) };
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.play.cards.length !== b.play.cards.length) return a.play.cards.length - b.play.cards.length;
      return (a.play.rank || 0) - (b.play.rank || 0);
    });
    return dedupeScored(scored, lim);
  }

  function suggest(state) {
    const hand = state.hand || [];
    const handInfo = handSummary(hand, state.level);
    const empty = { source: 'local', action: 'pass', play: null, reason: '', candidates: [], handInfo: handInfo };

    if (!hand.length) { empty.reason = '手里没有牌'; return empty; }
    if (!state.isMyTurn) { empty.reason = '还没轮到我'; return empty; }
    if (state.phase === 'tribute' || state.phase === 'return') {
      empty.reason = '当前是进贡/还贡阶段';
      return empty;
    }

    const cands = candidates(state, 12);
    const partner = state.partnerSeat;
    const owner = state.trickOwner || 0;

    // 1) 能一手出完：无论牌权在谁，直接出完
    const finish = cands.filter(function (c) { return c.play.size === hand.length; })
      .sort(function (a, b) { return (a.play.rank || 0) - (b.play.rank || 0); })[0];
    if (finish) {
      return {
        source: 'local', action: 'play', play: finish.play,
        reason: '一手出完（' + finish.play.name + '），本局结束',
        candidates: cands, handInfo: handInfo
      };
    }

    // 2) 队友牌权：默认让过
    if (owner && (owner === partner || G.sameTeam(owner, state.mySeat))) {
      return {
        source: 'local', action: 'pass', play: null,
        reason: '队友当前最大，让过（除非能一手出完）',
        candidates: cands, handInfo: handInfo
      };
    }

    // 3) 没有能压过的牌
    if (!cands.length) {
      return {
        source: 'local', action: 'pass', play: null,
        reason: state.prevCode ? '没有能压过的牌，过' : '没有可出的牌',
        candidates: [], handInfo: handInfo
      };
    }

    // 4) 取最优
    const best = cands[0];
    let reason;
    if (!state.prevCode) {
      reason = '领出 ' + best.play.name + ' ' + G.cardTexts(best.play.cards).join('')
        + '，减少手数（预计还需 ' + handInfo.playsEstimate + ' 手）';
    } else {
      const threat = opponentThreat(state);
      if (threat.isThreat && best.play.bomb) {
        reason = '对手只剩 ' + threat.count + ' 张，用' + best.play.name + '拦截';
      } else {
        reason = '跟牌：用' + best.play.name + ' ' + G.cardTexts(best.play.cards).join('')
          + ' 压住（预计还需 ' + handInfo.playsEstimate + ' 手）';
      }
    }
    return {
      source: 'local', action: 'play', play: best.play,
      reason: reason, candidates: cands, handInfo: handInfo
    };
  }

  /** 转成 GDDeepSeek 的 localSuggestion 结构（回退用） */
  function toLocalSuggestion(suggestion) {
    const s = suggestion || {};
    const play = s.play || null;
    return {
      action: s.action || 'pass',
      play: play,
      reason: s.reason || '',
      typeName: play ? play.name : '过',
      cards: play ? G.cardTexts(play.cards) : []
    };
  }

  return {
    VERSION: '1.0.0',
    isBombType: isBombType,
    playsEstimate: playsEstimate,
    countBombs: countBombs,
    handSummary: handSummary,
    opponentThreat: opponentThreat,
    scorePlay: scorePlay,
    candidates: candidates,
    suggest: suggest,
    toLocalSuggestion: toLocalSuggestion
  };
});
