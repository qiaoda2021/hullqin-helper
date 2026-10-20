/* ============================================================
 * 掼蛋油猴版 · 透视（X-ray）模块
 * ------------------------------------------------------------
 * 用途：读取本机页面已经收到的「本局牌局状态」，把其他三家的手牌、
 *       张数、炸弹与逢人配整理成可直接渲染的结构，供面板展示。
 *
 * 原理（与斗地主透视脚本 hullqin-ddz-esp-script 同一思路，但数据源更稳）：
 *   站点把服务端广播的 DDZGameData 原文（protobuf，rule=2 为掼蛋）放进
 *   React props.game.data。cardPositionList 的 108 个值以 7&v 表示归属
 *   玩家（1..4），服务端没有按玩家裁剪字段，客户端自己也要靠它算四家
 *   剩余张数与抗贡大王数，因此本机解码即可看到全部 108 张牌的归属。
 *   所以这里**不需要劫持网络连接**，只解码现有状态即可，兼容性更好。
 *
 * 本模块是纯函数（无 DOM、无网络、无存储、无 console），可单独 Node 测试。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GDSiteESP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  const TOTAL = 108;
  const SUIT_TEXT = ['♦', '♣', '♥', '♠'];
  const BIG_JOKER = 53;   // 大王 rank 17
  const SMALL_JOKER = 54; // 小王 rank 16
  const RANK_TEXT = {
    17: '大王', 16: '小王', 15: '级', 14: 'A', 13: 'K', 12: 'Q', 11: 'J',
    10: '10', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
  };

  function num(v, dft) {
    const n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : dft;
  }

  function normLevel(level) {
    const lv = num(level, 2);
    return lv >= 2 && lv <= 14 ? lv : 2;
  }

  function normalizeId(id) {
    const n = num(id, 0);
    return n >= 1 && n <= TOTAL ? Math.floor(n) : 0;
  }

  function cardLocal(id) {
    const n = normalizeId(id);
    return n ? (n - 1) % 54 + 1 : 0;
  }

  function cardDeck(id) {
    const n = normalizeId(id);
    return n ? Math.floor((n - 1) / 54) + 1 : 0;
  }

  function rankOf(id) {
    const local = cardLocal(id);
    if (!local) return 0;
    if (local === BIG_JOKER) return 17;
    if (local === SMALL_JOKER) return 16;
    const t = local % 13;
    return t === 1 ? 14 : (t === 0 ? 13 : t);
  }

  /** 花色：0 ♦ / 1 ♣ / 2 ♥ / 3 ♠；王返回 -1 */
  function suitOf(id) {
    const local = cardLocal(id);
    if (!local || local >= BIG_JOKER) return -1;
    return Math.floor((local - 1) / 13);
  }

  function rankText(rank) {
    return RANK_TEXT[rank] || String(rank || '');
  }

  /** 排序权重：级牌排在 A 之上；大王 17、小王 16 */
  function levelOrder(rank, level) {
    const lv = normLevel(level);
    return rank === lv ? 15 : rank;
  }

  /** 逢人配：红桃级牌（local 27..39 且点数等于级牌） */
  function isWildCard(id, level) {
    const local = cardLocal(id);
    return local >= 27 && local <= 39 && rankOf(id) === normLevel(level);
  }

  /** 单张牌的展示信息（不修改入参） */
  function cardInfo(id, level) {
    const n = normalizeId(id);
    if (!n) return null;
    const lv = normLevel(level);
    const rank = rankOf(n);
    const suit = suitOf(n);
    const joker = rank >= 16;
    return {
      id: n,
      local: cardLocal(n),
      deck: cardDeck(n),
      rank: rank,
      suit: suit,
      suitText: joker ? '' : SUIT_TEXT[suit],
      text: joker ? (rank === 17 ? '大王' : '小王') : SUIT_TEXT[suit] + rankText(rank),
      red: !joker && (suit === 0 || suit === 2),
      isLevel: !joker && rank === lv,
      isWild: isWildCard(n, lv),
      isJoker: joker,
      order: levelOrder(rank, lv),
    };
  }

  /** 按「级牌优先、同点按花色」排序，便于肉眼核对 */
  function sortCards(cards, level) {
    const lv = normLevel(level);
    const list = (Array.isArray(cards) ? cards : []).map(normalizeId).filter(Boolean);
    list.sort(function (a, b) {
      const ia = cardInfo(a, lv);
      const ib = cardInfo(b, lv);
      if (ib.order !== ia.order) return ib.order - ia.order;
      if (ia.suit !== ib.suit) return ia.suit - ib.suit;
      return ia.id - ib.id;
    });
    return list;
  }

  /**
   * 识别手牌里「潜在能打出的炸弹」（自然炸弹 + 用逢人配凑出的）。
   * 只做保守统计：同点≥4、四大天王、同花顺（含 A2345），配牌只补缺张。
   * 返回 {bombs, wildCount}；bombs 每项 {kind, size, rank, label, power}。
   */
  function bombsOf(cards, level) {
    const lv = normLevel(level);
    const list = sortCards(cards, lv);
    const wilds = [];
    const others = [];
    for (let i = 0; i < list.length; i++) {
      if (isWildCard(list[i], lv)) wilds.push(list[i]);
      else others.push(list[i]);
    }
    const u = wilds.length;
    const out = [];

    // 1) 四大天王（两副牌：两张大 + 两张小，id 可能是 53/107、54/108）
    let big = 0;
    let small = 0;
    for (let i = 0; i < others.length; i++) {
      const r = rankOf(others[i]);
      if (r === 17) big++;
      else if (r === 16) small++;
    }
    if (big >= 2 && small >= 2) {
      out.push({ kind: 'fourJokers', size: 4, rank: 0, label: '四大天王', power: 99 });
    }

    // 2) 同点炸弹（自然 / 配牌）
    const groups = {};
    for (let i = 0; i < others.length; i++) {
      const c = others[i];
      if (rankOf(c) >= 16) continue;
      const r = rankOf(c);
      const ord = levelOrder(r, lv);
      const g = groups[ord] || (groups[ord] = { rank: r, order: ord, size: 0 });
      g.size++;
    }
    Object.keys(groups).forEach(function (k) {
      const g = groups[k];
      if (g.size >= 4 && g.size <= 8) {
        out.push({ kind: 'sameRank', size: g.size, rank: g.rank, label: g.size + '张' + rankText(g.rank), power: g.size });
      } else if (u > 0) {
        const size = g.size + u;
        if (size >= 4 && size <= 8) {
          out.push({ kind: 'sameRank', size: size, rank: g.rank, label: size + '张' + rankText(g.rank) + '（配）', power: size });
        }
      }
    });

    // 3) 同花顺（自然 / 配牌；A 可作 1 组成 A2345）
    for (let suit = 0; suit < 4; suit++) {
      const ranks = {};
      for (let i = 0; i < others.length; i++) {
        const c = others[i];
        if (rankOf(c) >= 16) continue;
        if (suitOf(c) !== suit) continue;
        ranks[rankOf(c)] = true;
      }
      for (let b = 5; b <= 14; b++) {
        let need = 0;
        let present = 0;
        for (let p = b - 4; p <= b; p++) {
          const r = (b === 5 && p === 1) ? 14 : p; // b=5 即 A2345，1 代表 A
          if (ranks[r]) present++;
          else need++;
        }
        if (present < 1) continue;
        if (need === 0) {
          out.push({ kind: 'straightFlush', size: 5, rank: b, label: '同花顺 ' + SUIT_TEXT[suit] + rankText(b), power: 5.5 });
        } else if (u > 0 && need <= u) {
          out.push({ kind: 'straightFlush', size: 5, rank: b, label: '同花顺 ' + SUIT_TEXT[suit] + rankText(b) + '（配）', power: 5.5 });
        }
      }
    }

    out.sort(function (a, b) {
      if (b.power !== a.power) return b.power - a.power;
      return b.size - a.size;
    });
    return { bombs: out, wildCount: u };
  }

  function partnerOf(seat) {
    const s = num(seat, 0);
    return s <= 2 ? s + 2 : (s >= 3 ? s - 2 : 0);
  }

  function relName(seat, mySeat) {
    const s = num(seat, 0);
    const me = num(mySeat, 0);
    if (!s || !me) return '';
    if (s === me) return '我';
    if (s === partnerOf(me)) return '对家';
    if (s === (me % 4) + 1) return '下家';
    return '上家';
  }

  /**
   * 透视主入口：expanded 为 GDSite.expandState() 的结果。
   * 只读取 playerCardLists / playerRestCardCounts / level，不修改入参。
   */
  function buildXray(expanded, mySeat) {
    const e = expanded && typeof expanded === 'object' ? expanded : {};
    const seat = num(mySeat, 0);
    const lv = normLevel(e.level);
    const base = {
      ok: false,
      reason: 'no-data',
      level: lv,
      levelText: rankText(lv),
      wildText: '♥' + rankText(lv),
      mySeat: seat,
      partnerSeat: partnerOf(seat),
      seats: [],
      warnings: [],
      totalCards: 0,
      bombCount: 0,
    };
    if (!seat || seat < 1 || seat > 4) {
      base.reason = 'not-seated';
      return base;
    }

    const lists = Array.isArray(e.playerCardLists) ? e.playerCardLists : [];
    const rests = Array.isArray(e.playerRestCardCounts) ? e.playerRestCardCounts : [];
    const order = [seat % 4 + 1, partnerOf(seat), seat === 1 ? 4 : seat - 1];
    const seats = [];
    let totalCards = 0;
    let bombCount = 0;
    let unavailableCount = 0;

    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      const raw = Array.isArray(lists[s]) ? lists[s] : [];
      const cards = sortCards(raw, lv);
      const rest = num(rests[s], cards.length);
      const bombsInfo = bombsOf(cards, lv);
      const unavailable = cards.length === 0 && rest > 0;
      if (unavailable) unavailableCount++;
      totalCards += cards.length;
      bombCount += bombsInfo.bombs.length;
      const seatInfo = {
        seat: s,
        name: relName(s, seat),
        isPartner: s === partnerOf(seat),
        count: rest > 0 ? rest : cards.length,
        cards: cards.map(function (id) { return cardInfo(id, lv); }),
        bombs: bombsInfo.bombs,
        wildCount: bombsInfo.wildCount,
        unavailable: unavailable,
      };
      seats.push(seatInfo);
      if (seatInfo.bombs.length) {
        base.warnings.push(seatInfo.name + ' 有 ' + seatInfo.bombs.length + ' 个炸弹（' +
          seatInfo.bombs.map(function (b) { return b.label; }).join('、') + '）');
      }
    }

    base.seats = seats;
    base.totalCards = totalCards;
    base.bombCount = bombCount;
    if (!totalCards) base.reason = unavailableCount ? 'no-data' : 'no-cards';
    else if (unavailableCount) base.reason = 'partial';
    else base.reason = 'ok';
    base.ok = totalCards > 0;
    return base;
  }

  /** 面板底部的一句话汇总 */
  function summaryOf(xray) {
    if (!xray || !xray.seats || !xray.seats.length || !xray.totalCards) return '暂无可透视的手牌';
    let wilds = 0;
    for (let i = 0; i < xray.seats.length; i++) wilds += xray.seats[i].wildCount || 0;
    return '可见 ' + xray.totalCards + ' 张 · 炸弹 ' + xray.bombCount + ' 个' + (wilds ? ' · 逢人配 ' + wilds + ' 张' : '');
  }

  return {
    VERSION: VERSION,
    TOTAL: TOTAL,
    SUIT_TEXT: SUIT_TEXT.slice(),
    buildXray: buildXray,
    bombsOf: bombsOf,
    sortCards: sortCards,
    cardInfo: cardInfo,
    rankOf: rankOf,
    suitOf: suitOf,
    rankText: rankText,
    levelOrder: levelOrder,
    isWildCard: isWildCard,
    relName: relName,
    partnerOf: partnerOf,
    summaryOf: summaryOf,
    _internals: {
      VERSION: VERSION,
      TOTAL: TOTAL,
      BIG_JOKER: BIG_JOKER,
      SMALL_JOKER: SMALL_JOKER,
      RANK_TEXT: RANK_TEXT,
      normalizeId: normalizeId,
      cardLocal: cardLocal,
      cardDeck: cardDeck,
      normLevel: normLevel,
    },
  };
});
