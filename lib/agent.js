import { fuyaoGet } from './fuyao.js';
import { DAY, dateMs, msToDate } from './dates.js';
import { attachAnomaly, pctText } from './collect.js';
import { ifindCall } from './ifind.js';

export class LlmError extends Error {}

const agentModel = () => process.env.AGENT_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const writerModel = () => process.env.WRITER_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';

export async function llmChat(ctx, messages, { tools, json = false, temperature = 0.3, maxTokens = 2500, timeoutMs = 120000, model, kind = 'chat' } = {}) {
  if (ctx.simulate?.includes('llm_down')) throw new LlmError('故障演练：模拟大模型服务不可用');
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new LlmError('服务端未配置 DEEPSEEK_API_KEY');
  const base = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const body = { model: model || agentModel(), messages, temperature, max_tokens: maxTokens };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  if (json) body.response_format = { type: 'json_object' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.choices?.[0]) throw new LlmError(`模型接口错误：HTTP ${res.status} ${j?.error?.message || ''}`.trim());
    ctx.llm.push({ kind, ms: Date.now() - t0, model: j.model, usage: j.usage });
    return j.choices[0].message;
  } catch (e) {
    if (e.name === 'AbortError') throw new LlmError(`模型响应超时（>${timeoutMs / 1000}s）`);
    throw e instanceof LlmError ? e : new LlmError(e.message);
  } finally {
    clearTimeout(timer);
  }
}

export function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 尝试截取首个 JSON 对象 */ }
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------------- Agent 工具 ----------------
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_stock_anomaly_reasons',
      description: '查询所选交易日个股的同花顺异动解读（涨停/跌停/大涨/大跌原因，含公告与新闻出处），用于给题材和个股异动找证据。',
      parameters: { type: 'object', properties: { names_or_codes: { type: 'array', items: { type: 'string' }, description: '股票简称或6位代码，最多6个' } }, required: ['names_or_codes'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_theme_members',
      description: '在当日涨停池中查找涨停原因标签包含某关键词的个股（含连板数、首次封板时间），用于确认题材是否形成板块效应。',
      parameters: { type: 'object', properties: { keyword: { type: 'string', description: '题材关键词，如 低空经济' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sector_index_moves',
      description: '按关键词匹配同花顺行业/概念指数，返回所选交易日的指数涨跌幅（由日K计算），用于判断题材是否得到板块整体走势印证。',
      parameters: { type: 'object', properties: { keyword: { type: 'string', description: '板块关键词，如 半导体、出版' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_ifind_news',
      description: '在 iFinD 财经新闻库检索所选交易日及前3天的新闻片段（第二数据源），用于给题材或个股异动补充新闻出处，并与同花顺异动解读交叉印证。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '检索语句，如“低空经济 飞行汽车”“新华传媒 重组”' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_recent_trend',
      description: '查询个股截至所选交易日近5根、近20根日K的累计涨跌幅（前复权），用于描述高位股的累计涨幅风险。',
      parameters: { type: 'object', properties: { name_or_code: { type: 'string' } }, required: ['name_or_code'] },
    },
  },
];

let catalogCache = null;
async function getCatalog(ctx) {
  if (catalogCache && Date.now() - catalogCache.at < 6 * 3600e3) return catalogCache.items;
  const [ind, con] = await Promise.all([
    fuyaoGet(ctx, 'index_catalog', '同花顺行业指数目录', '/api/a-share-index/catalog/ths-index-list', { tag: 'industry' }, { by: 'agent' }),
    fuyaoGet(ctx, 'index_catalog', '同花顺概念指数目录', '/api/a-share-index/catalog/ths-index-list', { tag: 'cn_concept' }, { by: 'agent' }),
  ]);
  const items = [
    ...(ind.data?.item || []).map((x) => ({ ...x, tag: '行业' })),
    ...(con.data?.item || []).map((x) => ({ ...x, tag: '概念' })),
  ];
  catalogCache = { at: Date.now(), items };
  return items;
}

function resolveStock(base, q) {
  const s = String(q || '').trim();
  if (!s) return null;
  if (base.names.has(s)) return { name: s, thscode: base.names.get(s) };
  const m = /^(\d{6})(?:\.(SH|SZ|BJ))?$/i.exec(s);
  if (m) {
    const suffix = m[2]?.toUpperCase() || (/^6/.test(m[1]) ? 'SH' : /^[03]/.test(m[1]) ? 'SZ' : 'BJ');
    const thscode = `${m[1]}.${suffix}`;
    const name = [...base.names.entries()].find(([, v]) => v === thscode)?.[0] || m[1];
    return { name, thscode };
  }
  for (const [n, c] of base.names) if (n.includes(s) || s.includes(n)) return { name: n, thscode: c };
  return null;
}

export async function execTool(ctx, sheet, base, name, args) {
  const D = base.td.date;
  const Dms = dateMs(D);
  if (name === 'get_stock_anomaly_reasons') {
    const lines = [];
    for (const q of (args.names_or_codes || []).slice(0, 6)) {
      const st = resolveStock(base, q);
      if (!st) { lines.push(`「${q}」：未能在当日涨跌停池/热股榜中识别该股票，未查询`); continue; }
      if (!base.anomCall) { lines.push(`${st.name}：异动解读数据源当日调用失败，没有证据可用`); continue; }
      const ids = attachAnomaly(sheet, base, st.thscode, st.name);
      if (!ids.length) { lines.push(`${st.name}：数据源当日没有该股的异动解读（不代表没有原因，只是未覆盖）`); continue; }
      for (const id of ids) {
        const e = sheet.evidence.find((x) => x.id === id);
        lines.push(`${id} ${st.name}[${e.tag}] 关键词：${e.keywords.join('、')}；摘要：${e.text.slice(0, 260)}`);
      }
    }
    return lines.join('\n') || '未提供股票';
  }
  if (name === 'get_theme_members') {
    const kw = String(args.keyword || '').trim();
    if (!kw) return '关键词为空';
    if (!base.upCall) return '涨停池当日调用失败，无法查询题材成员';
    const hits = base.up.filter((x) => (x.limit_up_reason || '').includes(kw));
    if (!hits.length) return `当日涨停池中没有涨停原因包含「${kw}」的个股`;
    // 口径与基础数据不同（包含关键词 vs 按"+"拆分后精确匹配），必须用不同的事实，不能复用同名事实
    const label = `涨停原因包含“${kw}”字样的个股数`;
    const id = sheet.findFact(label) || sheet.fact(base.upCall, {
      label, value: hits.length, display: `${hits.length}只`, unit: '只', field: 'item[].limit_up_reason 包含关键词计数',
      as_of: `${D} 收盘`, caliber: `Agent 按关键词在涨停原因原文中做包含匹配（会同时命中“人形${kw}”之类的标签），与按“+”拆分后精确匹配的题材计数口径不同`, members: hits.map((x) => x.name),
    });
    return `${id} ${label}=${hits.length}只：${hits.slice(0, 12).map((x) => `${x.name}(${x.continue_day_text || `${x.continue_day_cnt}板`}，首封${x.limit_up_time || '未知'})`).join('、')}`;
  }
  if (name === 'get_sector_index_moves') {
    const kw = String(args.keyword || '').trim();
    if (!kw) return '关键词为空';
    const cat = await getCatalog(ctx);
    const matches = cat.filter((x) => x.name.includes(kw) || (kw.length >= 2 && kw.includes(x.name))).slice(0, 3);
    if (!matches.length) return `同花顺行业/概念指数目录中没有名称包含「${kw}」的指数`;
    const out = await Promise.all(matches.map(async (m) => {
      try {
        const body = await fuyaoGet(ctx, 'sector_kline', `${m.name}指数日K`, '/api/a-share-index/prices/historical', { thscode: m.thscode, interval: '1d', start: Dms - 20 * DAY, end: Dms }, { by: 'agent' });
        const bars = body.data?.item || [];
        const bar = bars.find((b) => b.date_ms === Dms);
        const prev = bars.filter((b) => b.date_ms < Dms).pop();
        if (!bar || !prev || msToDate(prev.date_ms) !== base.td.prevDate) return `${m.name}(${m.thscode})：缺少 ${D} 或前一交易日（${base.td.prevDate}）K线，无法计算`;
        const pct = (bar.close_price / prev.close_price - 1) * 100;
        const label = `${m.name}指数涨跌幅`;
        const id = sheet.findFact(label) || sheet.fact(body._call, {
          label, value: +pct.toFixed(4), display: pctText(pct), unit: '%', field: `close_price（${D} 与 ${msToDate(prev.date_ms)}）`,
          as_of: `${D} 收盘`, caliber: `同花顺${m.tag}指数 ${m.thscode} 日K计算`,
        });
        return `${id} ${m.name}（同花顺${m.tag}指数）${pctText(pct)}`;
      } catch (e) {
        return `${m.name}：日K调用失败（${e.message}），该证据缺失`;
      }
    }));
    return out.join('\n');
  }
  if (name === 'search_ifind_news') {
    const query = String(args.query || '').trim();
    if (!query) return '检索语句为空';
    const start = msToDate(Dms - 3 * DAY);
    const items = await ifindCall(ctx, 'hexin-ifind-ds-news-mcp', 'search_news', { query, time_start: start, time_end: D, size: 4 }, { title: `iFinD 新闻检索：${query}` });
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return `iFinD 新闻库在 ${start} 至 ${D} 没有检索到与「${query}」相关的片段`;
    const lines = [];
    for (const it of list.slice(0, 4)) {
      const date = it['日期'] || '';
      const url = it.URL || it.url || '';
      if (date && date > D) continue; // 不使用所选交易日之后的信息
      const id = sheet.ev(null, {
        kind: 'iFinD 新闻', stock: '', tag: date, title: it['资讯标题'] || '',
        text: `${it['资讯标题'] || ''}：${String(it['资讯内容'] || '').replace(/\s+/g, ' ').slice(0, 500)}`,
        time: date, link: url, endpoint: 'iFinD MCP hexin-ifind-ds-news-mcp / search_news',
        source: `iFinD 新闻检索（${/baike\.|wiki/.test(url) ? '百科类页面，非新闻，慎用' : '财经新闻片段'}）`,
      });
      lines.push(`${id} [${date}] ${it['资讯标题'] || ''}：${String(it['资讯内容'] || '').replace(/\s+/g, ' ').slice(0, 220)}${/baike\.|wiki/.test(url) ? '（注意：来源为百科页面）' : ''}`);
    }
    return lines.join('\n') || '检索结果均晚于所选交易日，已全部舍弃';
  }
  if (name === 'get_stock_recent_trend') {
    const st = resolveStock(base, args.name_or_code);
    if (!st) return `「${args.name_or_code}」：未能识别该股票`;
    const body = await fuyaoGet(ctx, 'stock_kline', `${st.name}日K线`, '/api/a-share/prices/historical', { thscode: st.thscode, interval: '1d', start: Dms - 45 * DAY, end: Dms, adjust: 'forward' }, { by: 'agent' });
    const bars = (body.data?.item || []).filter((b) => b.date_ms <= Dms);
    const last = bars[bars.length - 1];
    if (!last || last.date_ms !== Dms) return `${st.name}：日K中没有 ${D} 的数据（可能停牌），无法计算`;
    const lines = [];
    for (const n of [5, 20]) {
      if (bars.length <= n) { lines.push(`${st.name}：日K不足${n + 1}根，无法计算近${n}根累计涨跌`); continue; }
      const b0 = bars[bars.length - 1 - n];
      const pct = (last.close_price / b0.close_price - 1) * 100;
      const label = `${st.name}近${n === 5 ? '五' : '二十'}根日K累计涨跌幅`;
      const id = sheet.findFact(label) || sheet.fact(body._call, {
        label, value: +pct.toFixed(4), display: `近${n}根日K${pctText(pct, 1).replace(/^(上涨|下跌)/, '累计$1')}`, unit: '%',
        field: `close_price（${D} 对比 ${msToDate(b0.date_ms)}，前复权）`, as_of: `${D} 收盘`, caliber: '前复权收盘价计算；停牌日没有K线，按K线根数计', stock: st.name,
      });
      lines.push(`${id} ${label}：${pctText(pct, 1)}`);
    }
    return lines.join('\n');
  }
  return `未知工具 ${name}`;
}

function listFacts(sheet) {
  return sheet.facts.map((f) => `${f.id}｜${f.label}｜${f.display}`).join('\n');
}
function listGaps(sheet) {
  const g = sheet.gaps.map((x) => `- 缺失：${x.title} —— ${x.reason}`);
  const d = sheet.dq.filter((x) => x.level !== 'info').map((x) => `- ${x.level === 'error' ? '错误' : '冲突/提醒'}：${x.title} —— ${x.detail}`);
  return [...g, ...d].join('\n') || '无';
}

function summarizeForAgent(sheet, base) {
  const td = base.td;
  const themes = base.ids.themes.map((t) => `${t.tag}：${t.members.length}只（${t.members.slice(0, 6).join('、')}）`).join('\n') || '无（涨停池缺失或无重复标签）';
  const leaders = base.up.filter((x) => x.continue_day_cnt >= 2).slice(0, 8).map((x) => `${x.name} ${x.continue_day_text || x.continue_day_cnt + '板'}：${x.limit_up_reason}`).join('\n') || '无';
  const upSet = new Set(base.up.map((x) => x.thscode));
  const hot = base.hot.map((x) => `第${x.rank} ${x.name}${upSet.has(x.thscode) ? '（当日涨停）' : ''}`).join('、') || '无';
  const down = base.down.slice(0, 10).map((x) => x.name).join('、') || '无';
  return `所选交易日：${td.date}（最近已收盘交易日：${td.latestClosed}）
【已取得的数字事实】
${listFacts(sheet)}
【涨停原因标签出现次数（按"+"拆分）】
${themes}
【连板个股及涨停原因】
${leaders}
【热股榜前十】${hot}
【跌停个股】${down}
【数据缺失或冲突】
${listGaps(sheet)}
异动解读覆盖股票数：${base.anomByTicker.size}`;
}

export async function runAgent(ctx, sheet, base, emit) {
  const system = `你是券商投顾团队的盘后复盘研究助理（Agent）。你已拿到所选交易日的基础数据摘要。
任务：判断当天的主线题材与关键个股，调用工具补充证据（个股异动原因、题材成员、板块指数涨跌、高位股累计涨幅），为后续撰写复盘稿做准备。
规则：
1. 只收集与核对事实，不做任何涨跌预测，不给买卖建议。
2. 优先调查：涨停原因中出现次数最多的题材（注意把同义标签合并考虑）、连板高度最高的个股、热股榜前列且涨停的个股、跌停集中的方向。
3. 主线题材至少用一次 search_ifind_news 找新闻出处，与同花顺异动解读交叉印证；两个来源说法不一致时要指出。
4. 先在心里形成"当日主线是什么"的假设，再用工具去找支持和反对的证据，而不是只找支持的证据。
5. 每轮最多调用4个工具，总共最多3轮；证据足够就停止调用。`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: summarizeForAgent(sheet, base) }];
  const steps = [];
  for (let round = 1; round <= 3; round++) {
    const msg = await llmChat(ctx, messages, { tools: TOOLS, model: agentModel(), maxTokens: 1200, kind: 'agent' });
    const calls = (msg.tool_calls || []).slice(0, 4);
    const step = { round, thought: msg.content || '', tool_calls: [] };
    steps.push(step);
    if (!calls.length) {
      if (msg.content) messages.push({ role: 'assistant', content: msg.content });
      emit?.({ type: 'agent_step', step });
      break;
    }
    const assistant = { role: 'assistant', content: msg.content || '', tool_calls: calls };
    if (msg.reasoning_content) assistant.reasoning_content = msg.reasoning_content;
    messages.push(assistant);
    const results = await Promise.all(calls.map(async (tc) => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* 参数非法时按空参数处理 */ }
      let out;
      try { out = await execTool(ctx, sheet, base, tc.function.name, args); } catch (e) { out = `工具调用失败：${e.message}（该证据缺失，不能据此下结论）`; }
      step.tool_calls.push({ name: tc.function.name, args, result: out.slice(0, 800) });
      return { role: 'tool', tool_call_id: tc.id, content: out };
    }));
    messages.push(...results);
    emit?.({ type: 'agent_step', step });
  }
  // 收尾：把调查结论结构化为"判断 + 支持证据 + 反证 + 待补"，供撰写使用，也展示给投顾核对
  const hypo = await summarizeHypotheses(ctx, sheet, messages);
  steps.push({ round: steps.length + 1, thought: hypo.summary, tool_calls: [], hypotheses: hypo.hypotheses });
  emit?.({ type: 'agent_step', step: steps[steps.length - 1] });
  return { steps, notes: hypo.summary, hypotheses: hypo.hypotheses };
}

const VERDICTS = ['支持', '部分支持', '不支持', '存疑'];

export function normalizeHypotheses(raw, sheet) {
  const ids = new Set([...sheet.facts.map((f) => f.id), ...sheet.evidence.map((e) => e.id)]);
  return (Array.isArray(raw) ? raw : []).slice(0, 4).map((h, i) => {
    const support = (Array.isArray(h.support) ? h.support : []).map(String);
    const against = (Array.isArray(h.against) ? h.against : []).map(String);
    const unknown = [...support, ...against].filter((x) => !ids.has(x));
    const problems = [];
    if (unknown.length) problems.push(`引用了底稿中不存在的编号：${unknown.join('、')}`);
    if (!support.some((x) => ids.has(x))) problems.push('没有有效的支持证据');
    // 判断里的数字也要能在所引事实或证据中找到，否则提示（模型可能自行加总或引用证据外的数字）
    const cited = [...support, ...against].map((x) => sheet.facts.find((f) => f.id === x)?.display || sheet.evidence.find((e) => e.id === x)?.text || '').join(' ');
    const stray = [...new Set((String(h.claim || '').match(/\d+(?:\.\d+)?/g) || []).filter((n) => !cited.includes(n)))];
    if (stray.length) problems.push(`判断中的数字「${stray.join('、')}」在所引证据中找不到，可能是模型自行计算或引用了证据外的信息`);
    const verdict = VERDICTS.includes(h.verdict) ? h.verdict : '存疑';
    const serious = unknown.length > 0 || !support.some((x) => ids.has(x));
    return {
      id: `H${i + 1}`,
      claim: String(h.claim || '').slice(0, 120),
      verdict: serious && verdict === '支持' ? '存疑' : verdict,
      support: support.filter((x) => ids.has(x)),
      against: against.filter((x) => ids.has(x)),
      gap: String(h.gap || '').slice(0, 120),
      problems,
    };
  }).filter((h) => h.claim);
}

async function summarizeHypotheses(ctx, sheet, messages) {
  const ask = `请停止调用工具，基于目前取得的证据，输出你对当日主线和关键异动的判断，JSON 格式：
{"hypotheses":[{"claim":"一句话判断，只描述当日已发生的情况，不含任何预测","verdict":"支持|部分支持|不支持|存疑","support":["F27","E13"],"against":["F47"],"gap":"还缺什么证据，没有则留空"}],"summary":"不超过3句的小结"}
要求：最多4条；每条至少一个 support 编号；有反面证据就写进 against；证据不足时 verdict 写"存疑"。`;
  try {
    const msg = await llmChat(ctx, [...messages, { role: 'user', content: ask }], { json: true, model: agentModel(), maxTokens: 1000, kind: 'agent' });
    const j = tryParseJson(msg.content) || {};
    return { hypotheses: normalizeHypotheses(j.hypotheses, sheet), summary: String(j.summary || '').slice(0, 400) };
  } catch (e) {
    return { hypotheses: [], summary: `（主线判断未生成：${e.message}）` };
  }
}

// ---------------- 撰写 ----------------
const AUDIENCE = {
  steady: '稳健型客户群：语气平实克制，先讲大盘与量能，再讲结构与风险，少写短线题材细节。',
  short: '短线交流群：简洁直接，重点写涨停结构、连板梯队与题材归因；同样不得给出任何操作建议。',
  inst: '机构/内部晨会简报：客观、结构化、信息密度高，突出数据口径与不确定性。',
};
export const AUDIENCE_LABEL = { steady: '稳健型客户群', short: '短线交流群', inst: '机构/内部简报' };

const WRITER_SYSTEM = `你是券商持牌投资顾问团队的复盘稿撰写助手。你根据「事实底稿」撰写一篇盘后复盘稿草稿，供投资顾问修改、再经合规审核后发布。请严格输出 JSON。

【硬性规则】
1. 数字只能引用：正文中任何数字（点位、涨跌幅、成交额、家数、连板数、比例、排名等）都必须写成 {{F编号}} 占位符，由系统按底稿原值渲染；正文其余部分不得出现任何阿拉伯数字。交易日期写成 {{DATE}}。涨跌幅类事实的渲染值已自带“上涨/下跌”字样，不要再写涨跌方向。依据编号只写进 refs，不要写进正文（正文里不要出现“E7”“F3”这类编号）。
   占位符会被替换成完整的“渲染值”（已含单位、方向和“第…名”“近…根日K”等字词），占位符前后不要重复这些字词：渲染值为“第1名”时写“热股榜排名{{F37}}”；渲染值为“近5根日K累计上涨61.1%”时写“新华传媒{{F47}}”。
   带个股名称的事实只能用在该个股身上；底稿里没有的个股数据就不要写，不要借用其他个股的编号。
2. 每句标注类型 type：
   - "fact"：只复述底稿中的事实，refs 列出引用的 F/E 编号；
   - "inference"：基于证据的归纳或推断，必须使用“或”“可能”“显示出”“一定程度上”等不确定措辞，refs 列出依据编号；
   - "pending"：底稿中缺失、冲突或需要人工确认的内容，写明缺什么、为什么暂不下结论，refs 可为空。
3. 归因只能来自 E 编号证据（涨停原因标签、异动解读）中的内容，可以概括转述，但不得编造证据里没有的新闻、政策、资金动向或机构观点。
4. 严禁：对未来走势的任何判断或暗示（如“有望”“将继续”“明日”“后市”）、买卖或仓位建议（如“关注”“布局”“低吸”“加仓”）、收益承诺、夸张煽动用语。可以陈述已发生的风险事实（如高位股炸板、跌停）作为风险提示。
5. 底稿“数据缺失或冲突”中列出的数据，不得写成正常结论，正文里也不能出现与缺失项相矛盾的“正常”表述。系统会为每一项自动追加锁定的待确认句，所以不要再为这些缺失或核验问题单独写待确认句（重复会让投顾多确认一次）；你的 pending 句只用于证据不足、需要人工判断的内容。
6. 结构固定为四节：「一、指数与量能」「二、涨停结构与市场情绪」「三、主线题材与归因」「四、风险提示与待确认事项」，每节2—5句，句子简洁。
7. 复盘要写出“与前一交易日相比的变化”：底稿里有“较前一交易日”“前一交易日”类事实时，优先用它们说明情绪升温或降温、题材是延续还是新出现。
8. 「主线题材与归因」以研究助理的主线判断为骨架：判断为“支持”的可以写成推断句；“部分支持 / 存疑”的必须写明不确定或写成 pending；不得把“不支持”的判断写成结论。

【输出 JSON 格式】
{"title":"标题，可使用 {{DATE}}","sections":[{"heading":"一、指数与量能","sentences":[{"text":"……","type":"fact","refs":["F1","F2"]}]}]}`;

function factsForWriter(sheet, base, audience, agent, team = {}) {
  const ev = sheet.evidence.map((e) => `${e.id}｜${e.stock || ''}${e.tag ? `[${e.tag}]` : ''}｜${e.text.slice(0, 320).replace(/\n+/g, ' ')}`).join('\n') || '无';
  const facts = sheet.facts.map((f) => `${f.id}｜${f.label}｜渲染值：${f.display}${f.members ? `｜成员：${f.members.slice(0, 8).join('、')}` : ''}`).join('\n');
  return `受众与风格：${AUDIENCE[audience] || AUDIENCE.steady}
交易日：{{DATE}} = ${base.td.date}

【事实底稿·数字事实（只能用编号引用）】
${facts}

【事实底稿·文本证据】
${ev}

【数据缺失或冲突】
${listGaps(sheet)}

【研究助理（Agent）的主线判断】
${hypothesesText(agent)}

【团队规则与写作偏好（来自合规与投顾的反馈，必须遵守）】
${teamText(team)}

请输出复盘稿 JSON。`;
}

function hypothesesText(agent) {
  const hs = agent?.hypotheses || [];
  if (!hs.length) return agent?.notes || '（无：Agent 未执行或未给出判断）';
  return hs.map((h) => `${h.id} ${h.claim}｜结论：${h.verdict}｜支持：${h.support.join('、') || '无'}｜反证：${h.against.join('、') || '无'}${h.gap ? `｜待补：${h.gap}` : ''}`).join('\n') + (agent.notes ? `\n小结：${agent.notes}` : '');
}

function teamText(team) {
  const rules = (team.rules || []).map((r) => `- 禁用表述「${r.phrase}」${r.reason ? `（${r.reason}）` : ''}`);
  const prefs = (team.preferences || []).map((p) => `- ${p.text || p}`);
  return [...rules, ...prefs].join('\n') || '（暂无）';
}

// 模型有时把依据编号写进正文（如"（E7、E9）""E11–E14"）：移出正文、并入 refs，避免读者看到内部编号
export function liftInlineRefs(text, refs) {
  const ids = new Set(refs);
  const RANGE = /([EF])(\d+)\s*[–—~-]\s*[EF]?(\d+)/g;
  const expand = (tok) => {
    // 同一组里可能既有区间又有单个编号，如"（E3、E5–E7）"：区间展开后，其余编号也要保留
    for (const r of tok.matchAll(RANGE)) {
      for (let i = Number(r[2]); i <= Number(r[3]) && i - Number(r[2]) < 20; i++) ids.add(`${r[1]}${i}`);
    }
    for (const m of tok.replace(RANGE, '').matchAll(/[EF]\d+/g)) ids.add(m[0]);
  };
  const LIST = String.raw`[EF]\d+(?:\s*(?:[、,，/]|[–—~-])\s*[EF]?\d+)*`;
  let out = text.replace(new RegExp(String.raw`\s*[（(]\s*(?:依据|见|证据)?[:：]?\s*${LIST}\s*[)）]`, 'g'), (m) => { expand(m); return ''; });
  // 裸编号：前后都不能紧贴字母或数字，避免把"F5G"这类题材名当成编号 F5
  out = out.replace(new RegExp(String.raw`(?<![{A-Za-z0-9])(?:依据|见|证据)?\s*${LIST}(?![}\dA-Za-z])`, 'g'), (m) => { expand(m); return ''; });
  return { text: out.replace(/\s{2,}/g, ' ').trim(), refs: [...ids] };
}

export function normalizeDraft(parsed, origin) {
  let sc = 0;
  let sn = 0;
  return {
    title: String(parsed.title || '盘后复盘').slice(0, 80),
    sections: (parsed.sections || []).slice(0, 6).map((s) => ({
      id: `C${++sc}`,
      heading: String(s.heading || `第${sc}节`),
      sentences: (s.sentences || []).slice(0, 8).map((x) => {
        const lifted = liftInlineRefs(String(x.text || '').trim(), Array.isArray(x.refs) ? x.refs.map(String).slice(0, 12) : []);
        return {
          id: `S${++sn}`,
          text: lifted.text,
          type: ['fact', 'inference', 'pending'].includes(x.type) ? x.type : 'inference',
          refs: lifted.refs,
          origin,
        };
      }).filter((x) => x.text),
    })),
  };
}

export async function writeDraft(ctx, sheet, base, audience, agent, team) {
  const messages = [{ role: 'system', content: WRITER_SYSTEM }, { role: 'user', content: factsForWriter(sheet, base, audience, agent, team) }];
  let msg = await llmChat(ctx, messages, { json: true, maxTokens: 3500, model: writerModel(), temperature: 0.4, kind: 'writer' });
  let parsed = tryParseJson(msg.content);
  if (!parsed?.sections?.length) {
    messages.push({ role: 'assistant', content: msg.content || '' }, { role: 'user', content: '上一次输出不是符合格式的 JSON，请只输出 JSON 对象，包含 title 与 sections。' });
    msg = await llmChat(ctx, messages, { json: true, maxTokens: 3500, model: writerModel(), temperature: 0.2, kind: 'writer' });
    parsed = tryParseJson(msg.content);
  }
  if (!parsed?.sections?.length) throw new LlmError('模型两次输出都不是合法的复盘稿 JSON');
  return normalizeDraft(parsed, 'ai');
}

// ---------------- AI 合规复核（语义层，补关键词规则的漏网） ----------------
export async function aiComplianceReview(ctx, rendered) {
  const system = `你是证券投资顾问业务的合规审核助手。逐句检查复盘稿，找出关键词规则容易漏掉的问题：
隐含的涨跌预测（如“行情才刚开始”“后续值得期待”）、变相买卖建议（如“可以多留意”“回调即是机会”）、收益暗示、把推断写成确定事实、对未经证实的消息进行渲染。
只输出 JSON：{"issues":[{"sid":"S1","category":"隐含预测|变相建议|收益暗示|推断当事实|渲染未证实消息|其他","reason":"……","suggestion":"改写建议"}]}；没有问题时 issues 为空数组。`;
  const msg = await llmChat(ctx, [{ role: 'system', content: system }, { role: 'user', content: rendered.map((r) => `${r.sid}[${r.type}] ${r.text}`).join('\n') }], { json: true, maxTokens: 1500, kind: 'review' });
  const j = tryParseJson(msg.content);
  return Array.isArray(j?.issues) ? j.issues : [];
}
