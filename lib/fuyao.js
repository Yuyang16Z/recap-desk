import { msToTime } from './dates.js';

export class FuyaoError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

// 限流、上游超时、数据源不可用可重试；参数错误、鉴权失败、标的不存在不重试
const RETRYABLE = new Set([4001, 5001, 5002, 5003]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同一次生成内限制并发，避免把扶摇打到限流
function acquire(ctx) {
  ctx.inflight = ctx.inflight || 0;
  ctx.queue = ctx.queue || [];
  const max = ctx.maxConcurrency || 6;
  if (ctx.inflight < max) {
    ctx.inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => ctx.queue.push(resolve)).then(() => { ctx.inflight++; });
}
function release(ctx) {
  ctx.inflight--;
  const next = ctx.queue.shift();
  if (next) next();
}

export function publicCall(c) {
  return {
    id: c.id, label: c.label, title: c.title, path: c.path, params: c.params,
    ok: c.ok, code: c.code, error: c.error, request_id: c.request_id,
    data_ts: c.data_ts, data_time: c.data_ts ? msToTime(c.data_ts) : null,
    ms: c.ms, attempts: c.attempts, by: c.by,
  };
}

/**
 * 调用扶摇 REST 接口：统一做鉴权头、超时、指数退避重试、信封校验和调用留痕。
 * 失败一律抛出 FuyaoError，由上层决定该数据块标为"缺失"，绝不返回空结果冒充正常。
 */
export async function fuyaoGet(ctx, label, title, path, params = {}, { timeoutMs = 20000, retries = 2, by = 'system' } = {}) {
  const base = process.env.FUYAO_BASE_URL || 'https://fuyao.aicubes.cn';
  const key = process.env.FUYAO_API_KEY;
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const qs = new URLSearchParams(Object.entries(clean).map(([k, v]) => [k, String(v)])).toString();
  const url = `${base}${path}${qs ? '?' + qs : ''}`;
  const call = { id: `T${ctx.calls.length + 1}`, label, title, path, params: clean, started: Date.now(), attempts: 0, by };
  ctx.calls.push(call);
  ctx.emit?.({ type: 'tool_start', call: publicCall(call) });
  await acquire(ctx);
  try {
    if (ctx.simulate?.includes(`fuyao:${label}`)) {
      call.attempts = 1;
      throw new FuyaoError(5003, '故障演练：模拟数据源不可用');
    }
    if (!key) throw new FuyaoError(2001, '服务端未配置 FUYAO_API_KEY');
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      call.attempts = attempt + 1;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers: { 'X-api-key': key }, signal: ac.signal });
        const text = await res.text();
        if (res.status === 429) throw new FuyaoError(4001, 'HTTP 429 触发限流');
        if (!res.ok) throw new FuyaoError(5003, `HTTP ${res.status}`);
        let body;
        try { body = JSON.parse(text); } catch { throw new FuyaoError(5003, '响应不是合法 JSON'); }
        if (body.code !== 0) throw new FuyaoError(body.code, body.message || '业务错误', { request_id: body.request_id });
        call.ok = true;
        call.code = 0;
        call.request_id = body.request_id;
        call.data_ts = body.data?.timestamp ?? body.data?.date_ms ?? null;
        call.ms = Date.now() - call.started;
        ctx.emit?.({ type: 'tool_end', call: publicCall(call) });
        // 不可枚举：事实条目据此回链到具体调用（调用编号 / 端点 / request_id），不随数据序列化
        Object.defineProperty(body, '_call', { value: { id: call.id, path, request_id: body.request_id }, enumerable: false });
        return body;
      } catch (e) {
        lastErr = e.name === 'AbortError'
          ? new FuyaoError(5002, `请求超时（>${timeoutMs / 1000}s）`)
          : e instanceof FuyaoError ? e : new FuyaoError(5003, `网络错误：${e.message}`);
        if (!RETRYABLE.has(lastErr.code) || attempt === retries) break;
        await sleep(800 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  } catch (e) {
    call.ok = false;
    call.code = e.code ?? -1;
    call.error = e.message;
    call.request_id = e.meta?.request_id;
    call.ms = Date.now() - call.started;
    ctx.emit?.({ type: 'tool_end', call: publicCall(call) });
    throw e;
  } finally {
    release(ctx);
  }
}
