// fuyao.js 单元测试：mock 全局 fetch，不访问真实扶摇接口
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fuyaoGet, FuyaoError, publicCall } from '../lib/fuyao.js';

process.env.FUYAO_API_KEY = 'unit-test-dummy-key';
process.env.FUYAO_BASE_URL = 'http://fuyao.test';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function mockFetch(t, impl) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    seen.push({ url: String(url), opts });
    return impl(String(url), opts, seen.length);
  });
  return seen;
}
const newCtx = (simulate = []) => ({ calls: [], simulate });

describe('fuyaoGet', () => {
  test('code=0 → 返回 body，记录调用（鉴权头、参数清洗、request_id、数据时间）', async (t) => {
    const seen = mockFetch(t, () => json({ code: 0, request_id: 'req-1', data: { timestamp: 1792080000000, item: [{ a: 1 }] } }));
    const ctx = newCtx();
    const body = await fuyaoGet(ctx, 'hot_list', '历史热股排行', '/api/x', { date: '2026-10-16', empty: '', none: null });
    assert.equal(body.code, 0);
    assert.deepEqual(body.data.item, [{ a: 1 }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'http://fuyao.test/api/x?date=2026-10-16');
    assert.equal(seen[0].opts.headers['X-api-key'], 'unit-test-dummy-key');
    const c = ctx.calls[0];
    assert.equal(c.id, 'T1');
    assert.equal(c.ok, true);
    assert.equal(c.attempts, 1);
    assert.equal(c.request_id, 'req-1');
    assert.equal(c.data_ts, 1792080000000);
    // _call 不可枚举：事实回链用，不随 JSON 序列化
    assert.deepEqual(body._call, { id: 'T1', path: '/api/x', request_id: 'req-1' });
    assert.ok(!Object.keys(body).includes('_call'));
    assert.equal(publicCall(c).data_time, '2026-10-16 00:00');
  });

  test('HTTP 429 后成功 → 自动重试，attempts=2', async (t) => {
    mockFetch(t, (url, opts, n) => (n === 1 ? json({ message: 'too many' }, 429) : json({ code: 0, data: {} })));
    const ctx = newCtx();
    const body = await fuyaoGet(ctx, 'limit_up_pool', '涨停股票池', '/api/pool');
    assert.equal(body.code, 0);
    assert.equal(ctx.calls[0].attempts, 2);
    assert.equal(ctx.calls[0].ok, true);
  });

  test('业务错误 code=2003（参数/标的类）→ 不重试，抛 FuyaoError(2003)', async (t) => {
    const seen = mockFetch(t, () => json({ code: 2003, message: '标的不存在', request_id: 'req-x' }));
    const ctx = newCtx();
    await assert.rejects(fuyaoGet(ctx, 'stock_kline', '个股日K', '/api/k'), (e) => e instanceof FuyaoError && e.code === 2003);
    assert.equal(seen.length, 1);
    assert.equal(ctx.calls[0].attempts, 1);
    assert.equal(ctx.calls[0].ok, false);
    assert.equal(ctx.calls[0].code, 2003);
    assert.equal(ctx.calls[0].request_id, 'req-x');
  });

  test('请求超时（AbortSignal 触发）→ FuyaoError(5002)', async (t) => {
    mockFetch(t, (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    }));
    const ctx = newCtx();
    await assert.rejects(fuyaoGet(ctx, 'anomaly_analysis', '异动解读', '/api/slow', {}, { timeoutMs: 50, retries: 0 }), (e) => e instanceof FuyaoError && e.code === 5002);
    assert.equal(ctx.calls[0].attempts, 1);
    assert.equal(ctx.calls[0].ok, false);
  });

  test('超时属于可重试错误：第一次超时、第二次成功 → attempts=2', async (t) => {
    mockFetch(t, (url, opts, n) => (n === 1
      ? new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }))
      : json({ code: 0, data: {} })));
    const ctx = newCtx();
    await fuyaoGet(ctx, 'anomaly_analysis', '异动解读', '/api/slow', {}, { timeoutMs: 50, retries: 1 });
    assert.equal(ctx.calls[0].attempts, 2);
    assert.equal(ctx.calls[0].ok, true);
  });

  test('故障演练 simulate=fuyao:<label> → 抛 5003，且不发出任何请求', async (t) => {
    const seen = mockFetch(t, () => json({ code: 0, data: {} }));
    const ctx = newCtx(['fuyao:limit_up_pool']);
    await assert.rejects(fuyaoGet(ctx, 'limit_up_pool', '涨停股票池', '/api/pool'), (e) => e instanceof FuyaoError && e.code === 5003);
    assert.equal(seen.length, 0);
    assert.equal(ctx.calls[0].ok, false);
    assert.equal(ctx.calls[0].code, 5003);
    // 其他 label 不受影响
    await fuyaoGet(ctx, 'hot_list', '热股', '/api/hot');
    assert.equal(seen.length, 1);
  });

  test('非法 JSON 响应 → FuyaoError(5003)，不把空结果当正常数据返回', async (t) => {
    mockFetch(t, () => new Response('<html>502</html>', { status: 200 }));
    await assert.rejects(fuyaoGet(newCtx(), 'x', 'x', '/api/x', {}, { retries: 0 }), (e) => e.code === 5003);
  });

  test('未配置 FUYAO_API_KEY → FuyaoError(2001)，不发请求', async (t) => {
    const seen = mockFetch(t, () => json({ code: 0 }));
    const saved = process.env.FUYAO_API_KEY;
    delete process.env.FUYAO_API_KEY;
    try {
      await assert.rejects(fuyaoGet(newCtx(), 'x', 'x', '/api/x'), (e) => e.code === 2001);
      assert.equal(seen.length, 0);
    } finally {
      process.env.FUYAO_API_KEY = saved;
    }
  });
});
