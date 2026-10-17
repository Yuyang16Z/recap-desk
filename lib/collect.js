import { fuyaoGet, FuyaoError } from './fuyao.js';
import { DAY, dateMs, msToDate, msToTime, dash, shanghaiNow } from './dates.js';

export class UserError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}

export const INDICES = [
  { code: '000001.SH', name: '上证指数' },
  { code: '399001.SZ', name: '深证成指' },
  { code: '399006.SZ', name: '创业板指' },
  { code: '000300.SH', name: '沪深300' },
  { code: '000688.SH', name: '科创50' },
  { code: '899050.BJ', name: '北证50' },
];
// 两市成交额口径：上证综指成交额 + 深证综指成交额（深证成指只含 500 只成分股，不能代表深市全体）
const SZ_COMPOSITE = { code: '399106.SZ', name: '深证综指' };

export const fmtYi = (yuan) => `${Math.round(yuan / 1e8).toLocaleString('en-US')}亿元`;
export function pctText(p, digits = 2) {
  if (p > 0) return `上涨${p.toFixed(digits)}%`;
  if (p < 0) return `下跌${Math.abs(p).toFixed(digits)}%`;
  return '持平';
}

// 事实底稿：F 编号是可计算的数字事实，E 编号是文本证据；正文只能通过编号引用它们
export class FactSheet {
  constructor() {
    this.facts = [];
    this.evidence = [];
    this.gaps = [];
    this.dq = [];
  }
  fact(call, f) {
    const id = `F${this.facts.length + 1}`;
    this.facts.push({ id, source: '扶摇', endpoint: call?.path, call_id: call?.id, request_id: call?.request_id, ...f });
    return id;
  }
  ev(call, e) {
    const id = `E${this.evidence.length + 1}`;
    this.evidence.push({ id, endpoint: call?.path, call_id: call?.id, request_id: call?.request_id, ...e });
    return id;
  }
  gap(g) { this.gaps.push(g); }
  issue(i) { this.dq.push(i); }
  findFact(label) { return this.facts.find((f) => f.label === label)?.id; }
}

async function safe(sheet, section, title, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FuyaoError) {
      sheet.gap({ section, title, reason: `接口调用失败：${e.message}（code=${e.code}）` });
      return null;
    }
    throw e;
  }
}

async function fetchAllPages(ctx, label, title, path, params) {
  const first = await fuyaoGet(ctx, label, title, path, { ...params, page: 1 });
  const items = [...(first.data?.item || [])];
  const pages = Math.min(first.data?.pagination?.pages || 1, 5);
  for (let p = 2; p <= pages; p++) {
    const more = await fuyaoGet(ctx, label, `${title}（第${p}页）`, path, { ...params, page: p });
    items.push(...(more.data?.item || []));
  }
  const out = { items, total: first.data?.pagination?.total ?? items.length, timestamp: first.data?.timestamp };
  Object.defineProperty(out, '_call', { value: first._call, enumerable: false });
  return out;
}

async function fetchSnapshotAll(ctx) {
  const path = '/api/a-share/prices/snapshot';
  const first = await fuyaoGet(ctx, 'market_snapshot', '全A行情快照（第1页）', path, { limit: 1000, offset: 0 });
  const total = first.data?.total || 0;
  const offsets = [];
  for (let o = 1000; o < total; o += 1000) offsets.push(o);
  const rest = await Promise.all(offsets.map((o, i) => fuyaoGet(ctx, 'market_snapshot', `全A行情快照（第${i + 2}页）`, path, { limit: 1000, offset: o })));
  const items = [first, ...rest].flatMap((b) => b.data?.item || []);
  const out = { items, total, timestamp: first.data?.timestamp };
  Object.defineProperty(out, '_call', { value: first._call, enumerable: false });
  return out;
}

export async function resolveTradingDate(ctx, requested, nowMs = Date.now()) {
  const body = await fuyaoGet(ctx, 'trading_calendar', 'A股交易日历', '/api/a-share/calendar/trading-days');
  const days = (body.data?.item || []).map((x) => dash(x.date)).sort();
  if (!days.length) throw new UserError('交易日历返回为空，无法确定交易日，已停止生成');
  const now = shanghaiNow(nowMs);
  const todayTrading = days.includes(now.date);
  const closed = now.minutes >= 15 * 60 + 10; // 15:10 后视为收盘数据已落定
  const past = days.filter((d) => d < now.date || (d === now.date && closed));
  const latestClosed = past[past.length - 1];
  const date = requested || latestClosed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UserError('日期格式应为 YYYY-MM-DD');
  if (date < days[0]) throw new UserError(`交易日历只覆盖近一年（${days[0]} 起），${date} 超出数据范围`, { suggestion: latestClosed });
  // 先判断是否交易日，再判断是否已收盘：最近收盘日之后的周末/节假日应报"休市"而不是"未收盘"
  if (!days.includes(date)) {
    if (date > now.date) throw new UserError(`${date} 是未来日期，不能生成收盘复盘；最近一个已收盘交易日是 ${latestClosed}`, { suggestion: latestClosed });
    const prev = days.filter((d) => d < date && d <= latestClosed).pop();
    throw new UserError(`${date} 不是 A 股交易日（休市）；它之前最近的已收盘交易日是 ${prev}`, { suggestion: prev });
  }
  if (date > latestClosed) {
    const why = date > now.date ? '是未来日期' : '尚未收盘';
    throw new UserError(`${date} ${why}，不能生成收盘复盘；最近一个已收盘交易日是 ${latestClosed}`, { suggestion: latestClosed });
  }
  // 行情快照只给"最新"数据：仅当所选日就是最近收盘日、且当前不在下一交易日盘中时，快照才等于该日收盘口径
  const snapshotIsDateClose = date === latestClosed && !(todayTrading && date !== now.date && now.minutes >= 9 * 60 + 15);
  return {
    date,
    prevDate: days[days.indexOf(date) - 1] || null,
    latestClosed,
    isLatest: date === latestClosed,
    snapshotIsDateClose,
    now: now.text,
    calendar: { first: days[0], last: days[days.length - 1], request_id: body.request_id },
  };
}

export async function collectBase(ctx, td) {
  const sheet = new FactSheet();
  const D = td.date;
  const Dms = dateMs(D);
  const asOf = `${D} 收盘`;
  const base = { td, ids: { index: {}, limit: {}, leaders: [], themes: [], hot: [], breadth: {} }, up: [], down: [], brk: [], hot: [], anomByTicker: new Map(), names: new Map() };

  const allIdx = [...INDICES, SZ_COMPOSITE];
  const [klines, stats, up, down, brk, ladder, hot, anom, breadth] = await Promise.all([
    Promise.all(allIdx.map((ix) => safe(sheet, 'index', `${ix.name}日K线`, () =>
      fuyaoGet(ctx, 'index_kline', `${ix.name}日K线`, '/api/a-share-index/prices/historical', { thscode: ix.code, interval: '1d', start: Dms - 20 * DAY, end: Dms })))),
    safe(sheet, 'limit', '涨停强度与晋级统计', () => fuyaoGet(ctx, 'limit_up_statistics', '涨停强度与晋级统计', '/api/a-share/special-data/limit-up-statistics', { date: D })),
    safe(sheet, 'limit', '涨停股票池', () => fetchAllPages(ctx, 'limit_up_pool', '涨停股票池', '/api/a-share/special-data/limit-up-pool', { date_ms: Dms, size: 200, sort_field: 'continue_day_cnt', sort_dir: 'desc' })),
    safe(sheet, 'limit', '跌停股票池', () => fetchAllPages(ctx, 'limit_down_pool', '跌停股票池', '/api/a-share/special-data/limit-down-pool', { date_ms: Dms, size: 200 })),
    safe(sheet, 'limit', '炸板股票池', () => fetchAllPages(ctx, 'limit_break_pool', '炸板股票池', '/api/a-share/special-data/limit-break-pool', { date_ms: Dms, size: 200 })),
    safe(sheet, 'limit', '连板天梯', () => fuyaoGet(ctx, 'limit_up_ladder', '连板天梯（近30交易日）', '/api/a-share/special-data/limit-up-ladder')),
    safe(sheet, 'hot', '历史热股排行', () => fuyaoGet(ctx, 'hot_list', '历史热股排行', '/api/a-share/special-data/hot-stock-list-history', { date: D })),
    safe(sheet, 'theme', '异动解读', () => fuyaoGet(ctx, 'anomaly_analysis', '日期范围异动解读', '/api/news/anomaly/analysis', { begin_date: D, end_date: D }, { timeoutMs: 30000 })),
    td.snapshotIsDateClose ? safe(sheet, 'breadth', '全A行情快照', () => fetchSnapshotAll(ctx)) : Promise.resolve(null),
  ]);

  // ---------- 一、指数与量能 ----------
  const rows = {};
  allIdx.forEach((ix, i) => {
    const body = klines[i];
    if (!body) return;
    const bars = body.data?.item || [];
    const bar = bars.find((b) => b.date_ms === Dms);
    const prev = bars.filter((b) => b.date_ms < Dms).pop();
    if (!bar) {
      const last = bars.length ? msToDate(bars[bars.length - 1].date_ms) : '无';
      sheet.gap({ section: 'index', title: `${ix.name}日K线`, reason: `日K中没有 ${D} 这根K线（最新一根为 ${last}），不拿其他日期顶替` });
      sheet.issue({ level: 'error', code: 'missing_bar', title: `${ix.name}缺少所选交易日K线`, detail: `最新一根为 ${last}` });
      return;
    }
    rows[ix.code] = { ix, bar, prev, call: body._call };
  });
  for (const ix of INDICES) {
    const r = rows[ix.code];
    if (!r) continue;
    const ids = {};
    ids.close = sheet.fact(r.call, { label: `${ix.name}收盘点位`, value: r.bar.close_price, display: `${r.bar.close_price.toFixed(2)}点`, unit: '点', field: `item[date_ms=${Dms}].close_price`, as_of: asOf, caliber: `${ix.code} 日K收盘价` });
    if (r.prev) {
      const pct = (r.bar.close_price / r.prev.close_price - 1) * 100;
      ids.pct = sheet.fact(r.call, { label: `${ix.name}涨跌幅`, value: +pct.toFixed(4), display: pctText(pct), unit: '%', field: `close_price（${D} 与 ${msToDate(r.prev.date_ms)}）`, as_of: asOf, caliber: '（当日收盘 ÷ 前一交易日收盘 − 1）× 100，系统按原始字段计算' });
    }
    base.ids.index[ix.code] = { name: ix.name, ...ids };
  }
  const sh = rows['000001.SH'];
  const sz = rows[SZ_COMPOSITE.code];
  if (sh && sz && sh.prev && sz.prev) {
    const total = sh.bar.turnover + sz.bar.turnover;
    const prevTotal = sh.prev.turnover + sz.prev.turnover;
    const diff = total - prevTotal;
    const caliber = '上证综指(000001.SH)成交额 + 深证综指(399106.SZ)成交额，日K turnover 字段，单位元换算为亿元';
    base.ids.turnover = sheet.fact(sh.call, { label: '沪深两市成交额', value: total, display: fmtYi(total), unit: '亿元', field: `turnover（000001.SH + 399106.SZ，${D}）`, as_of: asOf, caliber, extra_calls: [sz.call.id] });
    base.ids.turnoverChg = sheet.fact(sh.call, { label: '两市成交额较前一交易日变化', value: diff, display: `较前一交易日${diff >= 0 ? '增加' : '减少'}${fmtYi(Math.abs(diff))}（${diff >= 0 ? '+' : '−'}${Math.abs(diff / prevTotal * 100).toFixed(2)}%）`, unit: '亿元', field: `turnover（${D} 对比 ${msToDate(sh.prev.date_ms)}）`, as_of: asOf, caliber });
  } else {
    sheet.gap({ section: 'index', title: '沪深两市成交额', reason: '上证综指或深证综指日K缺失，无法按统一口径计算两市成交额' });
  }

  // ---------- 二、涨停结构与情绪 ----------
  let statsOk = false;
  if (stats) {
    const s = stats.data || {};
    if (ctx.simulate?.includes('stale_stats')) s.trade_date = td.prevDate; // 故障演练：模拟接口返回过期日期
    if (s.trade_date !== D) {
      sheet.issue({ level: 'error', code: 'stale', title: '涨停统计返回日期与所选交易日不一致', detail: `请求 ${D}，接口返回 trade_date=${s.trade_date}；该接口数据整体不采用` });
      sheet.gap({ section: 'limit', title: '涨停强度与晋级统计', reason: `接口返回的是 ${s.trade_date} 的数据，与 ${D} 不符（过期或未就绪）` });
    } else {
      statsOk = true;
      const c = stats._call;
      const L = base.ids.limit;
      L.up = sheet.fact(c, { label: '涨停家数', value: s.limit_up_stock_count, display: `${s.limit_up_stock_count}家`, unit: '家', field: 'limit_up_stock_count', as_of: asOf, caliber: '收盘仍封住涨停的个股家数' });
      L.open = sheet.fact(c, { label: '炸板家数', value: s.open_stock_count, display: `${s.open_stock_count}家`, unit: '家', field: 'open_stock_count', as_of: asOf, caliber: '盘中触及涨停、收盘未封住的个股家数' });
      if (s.seal_rate != null) {
        L.sealRate = sheet.fact(c, { label: '封板率', value: s.seal_rate, display: `${(s.seal_rate * 100).toFixed(1)}%`, unit: '%', field: 'seal_rate', as_of: asOf, caliber: `上游 seal_rate（小数比例）×100；分母为触及涨停家数 ${s.touched_limit_up_stock_count} 家` });
        const recomputed = s.touched_limit_up_stock_count ? s.limit_up_stock_count / s.touched_limit_up_stock_count : null;
        if (recomputed != null && Math.abs(recomputed - s.seal_rate) > 0.005) {
          sheet.issue({ level: 'warn', code: 'conflict', title: '封板率与家数不自洽', detail: `seal_rate=${s.seal_rate}，涨停/触及=${recomputed.toFixed(4)}` });
        }
      }
      const exact = s.exact_boards || [];
      if (exact.length) {
        const top = exact.reduce((a, b) => (b.board_num > a.board_num ? b : a));
        L.maxBoard = sheet.fact(c, { label: '最高连板高度', value: top.board_num, display: `${top.board_num}连板`, unit: '板', field: 'exact_boards[max board_num].board_num', as_of: asOf, caliber: '精确连板数最大值' });
        const multi = exact.filter((x) => x.board_num >= 2).reduce((a, b) => a + b.stock_count, 0);
        L.multi = sheet.fact(c, { label: '连板股家数（二板及以上）', value: multi, display: `${multi}家`, unit: '家', field: 'exact_boards[board_num>=2].stock_count 求和', as_of: asOf, caliber: '系统按精确连板分布求和' });
      }
      const two = (s.page_boards || []).find((x) => x.board_level === 'two');
      if (two && two.promotion_rate != null) {
        L.promo2 = sheet.fact(c, { label: '二板晋级率', value: two.promotion_rate, display: `${Math.round(two.promotion_rate * 100)}%`, unit: '%', field: 'page_boards[board_level=two].promotion_rate', as_of: asOf, caliber: '上游提供的晋级率（前一日首板晋级为二板的比例），口径以同花顺涨停复盘页为准' });
      }
    }
  }
  if (up) {
    base.up = up.items;
    base.upCall = up._call;
    for (const it of up.items) base.names.set(it.name, it.thscode);
    if (statsOk && up.total !== stats.data.limit_up_stock_count) {
      sheet.issue({ level: 'warn', code: 'conflict', title: '涨停池记录数与统计口径不一致', detail: `涨停池 total=${up.total}，统计接口涨停家数=${stats.data.limit_up_stock_count}；正文采用统计接口口径` });
    }
    if (!statsOk) {
      base.ids.limit.upPool = sheet.fact(up._call, { label: '涨停池股票数', value: up.total, display: `${up.total}只`, unit: '只', field: 'pagination.total', as_of: asOf, caliber: '涨停股票池记录数（统计接口不可用时的替代口径）' });
    }
    const leaders = up.items.filter((x) => x.continue_day_cnt >= 2).sort((a, b) => b.continue_day_cnt - a.continue_day_cnt).slice(0, 6);
    for (const it of leaders) {
      const f = sheet.fact(up._call, { label: `${it.name}连板高度`, value: it.continue_day_cnt, display: it.continue_day_text || `${it.continue_day_cnt}连板`, unit: '板', field: `item[thscode=${it.thscode}].continue_day_cnt`, as_of: asOf, caliber: '涨停池连板天数', stock: it.name, thscode: it.thscode });
      const e = sheet.ev(up._call, { kind: '涨停原因标签', stock: it.name, thscode: it.thscode, text: `${it.name}涨停原因标签：${it.limit_up_reason || '（上游未提供）'}`, time: `${D} 首次涨停 ${it.limit_up_time || '未知'}`, source: '扶摇·涨停股票池 limit_up_reason' });
      base.ids.leaders.push({ name: it.name, thscode: it.thscode, fact: f, ev: e });
    }
    // 题材聚类：涨停原因标签按"+"拆分计数（确定性），语义归并交给 Agent
    const counter = new Map();
    for (const it of up.items) {
      for (const tag of (it.limit_up_reason || '').split('+').map((t) => t.trim()).filter(Boolean)) {
        if (!counter.has(tag)) counter.set(tag, []);
        counter.get(tag).push(it.name);
      }
    }
    const themes = [...counter.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
    for (const [tag, members] of themes) {
      const f = sheet.fact(up._call, { label: `涨停原因含「${tag}」的个股数`, value: members.length, display: `${members.length}只`, unit: '只', field: 'item[].limit_up_reason 按“+”拆分计数', as_of: asOf, caliber: '同一股票可同时属于多个标签；标签文本为上游原文', members });
      base.ids.themes.push({ tag, members, fact: f });
    }
    const topSeal = [...up.items].sort((a, b) => (b.seal_money || 0) - (a.seal_money || 0))[0];
    if (topSeal?.seal_money) {
      base.ids.topSeal = sheet.fact(up._call, { label: `${topSeal.name}收盘封单额`, value: topSeal.seal_money, display: `${(topSeal.seal_money / 1e8).toFixed(2)}亿元`, unit: '亿元', field: `item[thscode=${topSeal.thscode}].seal_money`, as_of: asOf, caliber: '涨停池收盘封单金额（元）换算为亿元，为当日涨停池最大值', stock: topSeal.name });
    }
  }
  if (down) {
    base.down = down.items;
    for (const it of down.items) base.names.set(it.name, it.thscode);
    base.ids.limit.down = sheet.fact(down._call, { label: '跌停家数', value: down.total, display: `${down.total}家`, unit: '家', field: 'pagination.total', as_of: asOf, caliber: '跌停股票池记录数', members: down.items.slice(0, 10).map((x) => x.name) });
  }
  if (brk) {
    base.brk = brk.items;
    if (statsOk && brk.total !== stats.data.open_stock_count) {
      sheet.issue({ level: 'warn', code: 'conflict', title: '炸板池记录数与统计口径不一致', detail: `炸板池 total=${brk.total}，统计接口炸板家数=${stats.data.open_stock_count}` });
    }
  }
  if (ladder) {
    const day = (ladder.data?.item || []).find((x) => x.date === D);
    if (!day) {
      sheet.issue({ level: 'info', code: 'window', title: '连板天梯窗口不含所选日', detail: '天梯只覆盖近30个交易日，仅影响交叉校验' });
    } else if (statsOk && base.ids.limit.maxBoard) {
      const ladderMax = Math.max(0, ...Object.values(day.boards || {}).flat().map((x) => x.board_num || 0));
      const statMax = sheet.facts.find((f) => f.id === base.ids.limit.maxBoard).value;
      if (ladderMax && ladderMax !== statMax) {
        sheet.issue({ level: 'warn', code: 'conflict', title: '连板天梯与涨停统计的最高板不一致', detail: `天梯=${ladderMax}板，统计=${statMax}板` });
      }
    }
  }

  // ---------- 热度 ----------
  if (hot) {
    const h = hot.data || {};
    if (h.date && h.date !== D) {
      sheet.issue({ level: 'error', code: 'stale', title: '热股榜日期不符', detail: `请求 ${D}，返回 ${h.date}；不采用` });
    } else {
      base.hot = (h.item || []).slice(0, 10);
      for (const it of base.hot) base.names.set(it.name, it.thscode);
      for (const it of base.hot.slice(0, 5)) {
        const f = sheet.fact(hot._call, { label: `${it.name}热股榜排名`, value: it.rank, display: `第${it.rank}名`, unit: '名', field: `item[thscode=${it.thscode}].rank`, as_of: `${D}（自然日榜单）`, caliber: '同花顺历史热股排行', stock: it.name, thscode: it.thscode });
        base.ids.hot.push({ name: it.name, fact: f });
      }
      const upSet = new Set(base.up.map((x) => x.thscode));
      const both = base.hot.filter((x) => upSet.has(x.thscode));
      if (base.up.length) {
        base.ids.hotLimitUp = sheet.fact(hot._call, { label: '热股榜前十中当日涨停的个股数', value: both.length, display: `${both.length}只`, unit: '只', field: '热股榜 item[] 与涨停池 thscode 交集', as_of: asOf, caliber: '系统交叉计算', members: both.map((x) => x.name) });
      }
    }
  }

  // ---------- 异动解读（证据池，按需由 Agent 调取） ----------
  if (anom) {
    const items = anom.data?.items || [];
    if (anom.data?.was_truncated) sheet.issue({ level: 'warn', code: 'truncated', title: '异动解读结果被截断', detail: '上游标记 was_truncated=true，部分个股可能缺少异动解读' });
    for (const it of items) {
      const m = /thsHqCode=(\w+)/.exec(it.link_url || '');
      if (!m) continue;
      if (!base.anomByTicker.has(m[1])) base.anomByTicker.set(m[1], []);
      base.anomByTicker.get(m[1]).push(it);
    }
    base.anomCall = anom._call;
    // 预先为最高连板个股挂上异动证据，保证即使 Agent 失败，撰写阶段也有归因材料
    for (const l of base.ids.leaders.slice(0, 3)) attachAnomaly(sheet, base, l.thscode, l.name);
  }

  // ---------- 全市场涨跌家数 ----------
  if (!td.snapshotIsDateClose) {
    sheet.gap({ section: 'breadth', title: '全市场涨跌家数', reason: td.isLatest ? '当前处于下一交易日交易时段，行情快照是盘中数据，不能当作所选日收盘口径' : '行情快照只提供最新行情，无法回溯历史交易日的涨跌家数' });
  } else if (breadth) {
    const snapDate = breadth.timestamp ? msToDate(breadth.timestamp) : null;
    if (!snapDate || snapDate < D) {
      sheet.gap({ section: 'breadth', title: '全市场涨跌家数', reason: `快照时间 ${breadth.timestamp ? msToTime(breadth.timestamp) : '未知'} 早于所选交易日，数据过期` });
    } else if (breadth.items.length < breadth.total) {
      sheet.gap({ section: 'breadth', title: '全市场涨跌家数', reason: `快照只取到 ${breadth.items.length}/${breadth.total} 只，样本不完整，不出具家数结论` });
    } else {
      let upN = 0; let downN = 0; let flat = 0; let idle = 0;
      for (const it of breadth.items) {
        if (!it.volume || it.last_price == null) idle++;
        else if (it.price_change_ratio_pct > 0) upN++;
        else if (it.price_change_ratio_pct < 0) downN++;
        else flat++;
      }
      const cal = `全A快照 ${breadth.items.length} 只、剔除无成交 ${idle} 只后按 price_change_ratio_pct 正负计数；快照时间 ${msToTime(breadth.timestamp)}`;
      const B = base.ids.breadth;
      B.up = sheet.fact(breadth._call, { label: '上涨家数', value: upN, display: `${upN}家`, unit: '家', field: 'item[].price_change_ratio_pct > 0 计数', as_of: asOf, caliber: cal });
      B.down = sheet.fact(breadth._call, { label: '下跌家数', value: downN, display: `${downN}家`, unit: '家', field: 'item[].price_change_ratio_pct < 0 计数', as_of: asOf, caliber: cal });
      B.flat = sheet.fact(breadth._call, { label: '平盘家数', value: flat, display: `${flat}家`, unit: '家', field: 'item[].price_change_ratio_pct = 0 计数', as_of: asOf, caliber: cal });
    }
  }
  return { sheet, base };
}

export function attachAnomaly(sheet, base, thscodeOrTicker, name) {
  const ticker = String(thscodeOrTicker).split('.')[0];
  const list = base.anomByTicker.get(ticker) || [];
  const existing = sheet.evidence.filter((e) => e.kind === '异动解读' && e.ticker === ticker);
  if (existing.length) return existing.map((e) => e.id);
  return list.slice(0, 2).map((it) => sheet.ev(base.anomCall, {
    kind: '异动解读', stock: name, ticker, tag: it.tag_name,
    keywords: it.key_word_list || [],
    text: (it.analysis_content || '').replace(/（免责声明[\s\S]*$/, '').trim().slice(0, 700),
    time: it.first_publish_time ? msToTime(it.first_publish_time) : null,
    link: it.link_url, source: '扶摇·日期范围异动解读（同花顺 AI 汇总公开信息，以公司公告为准）',
  }));
}
