// collect.js 单元测试：交易日解析（resolveTradingDate）与基础数据采集的故障处理（collectBase），全部 mock fetch
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTradingDate, collectBase, UserError } from '../lib/collect.js';
import { dateMs, DAY } from '../lib/dates.js';

process.env.FUYAO_API_KEY = 'unit-test-dummy-key';
process.env.FUYAO_BASE_URL = 'http://fuyao.test';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
// 北京时间 → 毫秒戳
const bj = (date, hh, mm = 0) => dateMs(date) + (hh * 60 + mm) * 60000;

// 小型交易日历：国庆休市 10-01~10-07，周末休市；10-17/18 为周六日
const TRADING_DAYS = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20'];
const calendarBody = { code: 0, request_id: 'cal-1', data: { item: TRADING_DAYS.map((d) => ({ date_ms: dateMs(d), date: d.replaceAll('-', '') })) } };
const ctx = () => ({ calls: [], simulate: [] });

describe('resolveTradingDate', () => {
  test('周末（2026-10-10 周六）→ UserError，建议前一交易日 2026-10-09', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    await assert.rejects(resolveTradingDate(ctx(), '2026-10-10', bj('2026-10-16', 20)), (e) => {
      assert.ok(e instanceof UserError);
      assert.match(e.message, /不是 A 股交易日/);
      assert.equal(e.extra.suggestion, '2026-10-09');
      return true;
    });
  });

  test('法定节假日（2026-10-05 国庆）→ UserError，建议节前最后交易日 2026-09-30', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    await assert.rejects(resolveTradingDate(ctx(), '2026-10-05', bj('2026-10-16', 20)), (e) => e instanceof UserError && e.extra.suggestion === '2026-09-30');
  });

  test('未来日期 → UserError，建议最近已收盘交易日', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    await assert.rejects(resolveTradingDate(ctx(), '2026-10-20', bj('2026-10-16', 20)), (e) => {
      assert.ok(e instanceof UserError);
      assert.match(e.message, /未来日期/);
      assert.equal(e.extra.suggestion, '2026-10-16');
      return true;
    });
  });

  test('当天盘中选择当天 → UserError（尚未收盘）', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    await assert.rejects(resolveTradingDate(ctx(), '2026-10-16', bj('2026-10-16', 10)), (e) => e instanceof UserError && e.extra.suggestion === '2026-10-15');
  });

  test('不传日期、交易日盘中（北京 10:00）→ 取前一交易日，且快照不能当收盘口径', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    const td = await resolveTradingDate(ctx(), null, bj('2026-10-16', 10));
    assert.equal(td.date, '2026-10-15');
    assert.equal(td.latestClosed, '2026-10-15');
    assert.equal(td.prevDate, '2026-10-14');
    assert.equal(td.isLatest, true);
    assert.equal(td.snapshotIsDateClose, false);
    assert.equal(td.calendar.request_id, 'cal-1');
  });

  test('不传日期、15:10 之后（北京 15:30）→ 取当天，快照可作收盘口径', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    const td = await resolveTradingDate(ctx(), undefined, bj('2026-10-16', 15, 30));
    assert.equal(td.date, '2026-10-16');
    assert.equal(td.snapshotIsDateClose, true);
  });

  test('15:00–15:10 之间仍按未收盘处理；开盘前（08:30）快照仍是前一日收盘', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    const td1 = await resolveTradingDate(ctx(), null, bj('2026-10-16', 15, 5));
    assert.equal(td1.date, '2026-10-15');
    assert.equal(td1.snapshotIsDateClose, false);
    const td2 = await resolveTradingDate(ctx(), null, bj('2026-10-16', 8, 30));
    assert.equal(td2.date, '2026-10-15');
    assert.equal(td2.snapshotIsDateClose, true);
  });

  test('历史交易日 → 正常返回，非最新日的快照不可用', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    const td = await resolveTradingDate(ctx(), '2026-10-09', bj('2026-10-16', 20));
    assert.equal(td.date, '2026-10-09');
    assert.equal(td.prevDate, '2026-10-08');
    assert.equal(td.isLatest, false);
    assert.equal(td.snapshotIsDateClose, false);
  });

  test('格式错误、早于日历覆盖范围、日历为空 → UserError', async (t) => {
    const m = t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    await assert.rejects(resolveTradingDate(ctx(), '2026/10/16', bj('2026-10-16', 20)), /日期格式/);
    await assert.rejects(resolveTradingDate(ctx(), '2025-01-02', bj('2026-10-16', 20)), /超出数据范围/);
    m.mock.mockImplementation(async () => json({ code: 0, data: { item: [] } }));
    await assert.rejects(resolveTradingDate(ctx(), null, bj('2026-10-16', 20)), (e) => e instanceof UserError && /为空/.test(e.message));
  });

  test('周日查询刚过去的周六（2026-10-17）→ 应提示"非交易日"并建议 2026-10-16', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => json(calendarBody));
    await assert.rejects(resolveTradingDate(ctx(), '2026-10-17', bj('2026-10-18', 10)), (e) => {
      assert.equal(e.extra.suggestion, '2026-10-16');
      assert.match(e.message, /不是 A 股交易日/);
      return true;
    });
  });
});

// ---------- collectBase：用路由式 mock 模拟扶摇全部端点 ----------
const D = '2026-10-16';
const Dms = dateMs(D);
function fuyaoRouter() {
  return async (url) => {
    const u = new URL(url);
    const p = u.pathname;
    let data;
    if (p === '/api/a-share-index/prices/historical') {
      data = { item: [{ date_ms: Dms - DAY, close_price: 3700, turnover: 7e11 }, { date_ms: Dms, close_price: 3716.28, turnover: 7.5e11 }] };
    } else if (p.endsWith('/limit-up-statistics')) {
      data = { trade_date: u.searchParams.get('date'), limit_up_stock_count: 2, open_stock_count: 1, touched_limit_up_stock_count: 3, seal_rate: 0.6667, exact_boards: [{ board_num: 1, stock_count: 1 }, { board_num: 5, stock_count: 1 }], page_boards: [{ board_level: 'two', promotion_rate: 0.25 }] };
    } else if (p.endsWith('/limit-up-pool')) {
      data = { pagination: { pages: 1, total: 2 }, item: [
        { name: '新华传媒', thscode: '600825.SH', continue_day_cnt: 5, continue_day_text: '5连板', limit_up_reason: '复牌+重组', limit_up_time: '09:25', seal_money: 3e8 },
        { name: '冰山冷热', thscode: '000530.SZ', continue_day_cnt: 1, limit_up_reason: '重组+冷链', limit_up_time: '10:01', seal_money: 1e8 },
      ] };
    } else if (p.endsWith('/limit-down-pool')) {
      data = { pagination: { pages: 1, total: 1 }, item: [{ name: '阳光乳业', thscode: '001318.SZ' }] };
    } else if (p.endsWith('/limit-break-pool')) {
      data = { pagination: { pages: 1, total: 1 }, item: [{ name: '某股', thscode: '000001.SZ' }] };
    } else if (p.endsWith('/limit-up-ladder')) {
      data = { item: [] };
    } else if (p.endsWith('/hot-stock-list-history')) {
      data = { date: D, item: [{ name: '新华传媒', thscode: '600825.SH', rank: 1 }] };
    } else if (p === '/api/news/anomaly/analysis') {
      data = { items: [] };
    } else {
      data = { item: [], total: 0 };
    }
    return json({ code: 0, request_id: `req-${p}`, data });
  };
}
const TD = { date: D, prevDate: '2026-10-15', latestClosed: D, isLatest: true, snapshotIsDateClose: false };

describe('collectBase 故障处理', () => {
  test('正常采集：事实带调用编号与端点；盘中快照不用于涨跌家数（记为缺失）', async (t) => {
    t.mock.method(globalThis, 'fetch', fuyaoRouter());
    const c = ctx();
    const { sheet, base } = await collectBase(c, TD);
    assert.ok(sheet.facts.length > 10);
    for (const f of sheet.facts) assert.ok(f.call_id && f.endpoint, `${f.id} 缺少调用回链`);
    assert.ok(base.ids.limit.up && base.ids.turnover);
    assert.equal(c.calls.filter((x) => x.label === 'market_snapshot').length, 0);
    const g = sheet.gaps.find((x) => x.section === 'breadth');
    assert.match(g.reason, /盘中数据/);
  });

  test('fuyao:index_kline 故障 → 全部指数与两市成交额记为缺失，其他数据照常', async (t) => {
    t.mock.method(globalThis, 'fetch', fuyaoRouter());
    const c = { calls: [], simulate: ['fuyao:index_kline'] };
    const { sheet, base } = await collectBase(c, TD);
    const idxGaps = sheet.gaps.filter((g) => g.section === 'index');
    assert.equal(idxGaps.length, 8); // 7 条指数日K + 两市成交额
    assert.ok(idxGaps.some((g) => g.title === '沪深两市成交额'));
    assert.deepEqual(base.ids.index, {});
    assert.equal(base.ids.turnover, undefined);
    assert.ok(base.ids.limit.up, '涨停统计不受影响');
    assert.equal(c.calls.filter((x) => x.label === 'index_kline' && x.code === 5003).length, 7);
  });

  test('fuyao:limit_up_pool + stale_stats → 涨停池缺失、统计接口日期过期整体不采用', async (t) => {
    t.mock.method(globalThis, 'fetch', fuyaoRouter());
    const { sheet, base } = await collectBase({ calls: [], simulate: ['fuyao:limit_up_pool', 'stale_stats'] }, TD);
    assert.ok(sheet.gaps.some((g) => g.title === '涨停股票池' && /5003/.test(g.reason)));
    assert.ok(sheet.gaps.some((g) => g.title === '涨停强度与晋级统计' && /2026-10-15/.test(g.reason)));
    assert.ok(sheet.dq.some((d) => d.code === 'stale' && d.level === 'error'));
    assert.equal(base.ids.limit.up, undefined);
    assert.equal(base.ids.limit.upPool, undefined);
    assert.equal(sheet.facts.filter((f) => f.label === '涨停家数').length, 0);
  });
});
