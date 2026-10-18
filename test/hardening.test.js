// 第四轮独立审查后补的回归测试：校验器漏报与误报、自修复输出异常、数据层日期与完整性校验、临时标记不落盘
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifySentence, verifyDraft } from '../lib/verify.js';
import { addSystemPendings, dedupePendings } from '../lib/pipeline.js';
import { repairDraft } from '../lib/repair.js';
import { collectBase } from '../lib/collect.js';
import { Store } from '../lib/store.js';
import { dateMs, DAY } from '../lib/dates.js';

const sheet = {
  facts: [
    { id: 'F1', label: '上证指数收盘点位', display: '3716.28点', unit: '点' },
    { id: 'F2', label: '上证指数涨跌幅', display: '上涨0.24%', unit: '%' },
    { id: 'F3', label: '涨停家数', display: '59家', unit: '家' },
    { id: 'F4', label: '封板率', display: '54.63%', unit: '%' },
  ],
  evidence: [{ id: 'E1', stock: '新华传媒', kind: '异动解读', text: '复牌后一字涨停' }],
};
const rules = (text, type = 'fact', refs = ['F3']) => verifySentence({ text, type, refs }, sheet).map((f) => f.rule);

describe('校验器：中文数字同样要溯源', () => {
  test('「五十九家」「三成」「两个百分点」→ 未溯源数字（阻断）', () => {
    for (const t of ['涨停家数达到五十九家。', '约三成个股收涨。', '创业板指跌幅扩大两个百分点。']) {
      assert.ok(rules(t).includes('untraced_number'), t);
    }
  });
  test('不带量词的中文数字不误报：「三大指数」「一字涨停」「十字星」', () => {
    for (const t of ['三大指数集体收跌，涨停家数为{{F3}}。', '新华传媒一字涨停，涨停家数{{F3}}。', 'K线收出十字星，涨停家数{{F3}}。']) {
      assert.ok(!rules(t).includes('untraced_number'), t);
    }
  });
});

describe('校验器：预测与建议的新句式', () => {
  test('「或将延续反弹」「预计将继续走强」「会大涨」→ 预测（阻断）', () => {
    for (const t of ['指数或将延续反弹。', '预计市场将继续走强。', '低空经济板块会大涨。']) {
      assert.ok(rules(t, 'inference', ['F2']).includes('predict'), t);
    }
  });
  test('「可重点关注」「建议重仓」→ 买卖建议（阻断）', () => {
    for (const t of ['可重点关注低空经济方向。', '建议重仓科技龙头。']) {
      assert.ok(rules(t, 'inference', ['F2']).includes('advice'), t);
    }
  });
  test('中性陈述不误报：「宣布将涨价」「主要涨停原因」「基金重仓股」「将涨停个股归类」「可见资金关注度」', () => {
    for (const t of ['公司公告宣布将涨价，涨停家数{{F3}}。', '主要涨停原因为重组，涨停家数{{F3}}。', '基金重仓股整体回落，涨停家数{{F3}}。', '将涨停个股按题材归类，涨停家数{{F3}}。', '可见资金关注度较高，涨停家数{{F3}}。']) {
      const r = rules(t);
      assert.ok(!r.includes('predict') && !r.includes('advice'), `${t} → ${r.join(',')}`);
    }
  });
  test('「封板率报{{F4}}」不是"收于/报"后接涨跌幅：不报搭配错误', () => {
    assert.ok(!rules('封板率报{{F4}}。', 'fact', ['F4']).includes('unit_mismatch'));
    assert.ok(rules('上证指数收于{{F2}}。', 'fact', ['F2']).includes('unit_mismatch'));
  });
});

describe('自修复：模型输出不规范时不崩溃、不误改', () => {
  const mkDraft = () => ({ sections: [{ sentences: [{ id: 'S1', text: '上证指数收于3716点。', type: 'fact', refs: ['F1'], origin: 'ai', flags: [{ rule: 'untraced_number', level: 'block', msg: '出现未溯源数字「3716点」' }] }] }] });
  const withLlm = async (content, fn) => {
    const prev = globalThis.fetch;
    process.env.DEEPSEEK_API_KEY = 'unit-test-dummy-key';
    globalThis.fetch = async () => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { total_tokens: 1 } }), { status: 200 });
    try { return await fn(); } finally { globalThis.fetch = prev; }
  };
  test('repairs 不是数组 → 视为没有修订，原句保留', async () => {
    const draft = mkDraft();
    const stats = await withLlm(JSON.stringify({ repairs: '无法修订' }), () => repairDraft({ calls: [], llm: [], simulate: [] }, sheet, draft, {}));
    assert.deepEqual({ f: stats.fixed, x: stats.failed }, { f: 0, x: 1 });
    assert.equal(draft.sections[0].sentences[0].text, '上证指数收于3716点。');
    assert.equal(draft.sections[0].sentences[0].repair.status, 'failed');
  });
  test('数组里夹杂 null、数字、缺 id 的条目 → 跳过它们，只采用合法且通过校验的修订', async () => {
    const draft = mkDraft();
    const content = JSON.stringify({ repairs: [null, 1, { id: 5, action: 'delete' }, { id: 'S1', action: 'rewrite', text: '上证指数收于{{F1}}。', type: 'fact', refs: ['F1'] }] });
    const stats = await withLlm(content, () => repairDraft({ calls: [], llm: [], simulate: [] }, sheet, draft, {}));
    assert.equal(stats.fixed, 1);
    assert.equal(stats.deleted, 0, '缺 id 的 delete 不应作用到任何句子');
    assert.equal(draft.sections[0].sentences[0].text, '上证指数收于{{F1}}。');
  });
  test('模型返回非 JSON 文本 → 不修改任何句子', async () => {
    const draft = mkDraft();
    const stats = await withLlm('抱歉，我无法完成。', () => repairDraft({ calls: [], llm: [], simulate: [] }, sheet, draft, {}));
    assert.equal(stats.fixed, 0);
    assert.equal(draft.sections[0].sentences[0].deleted, undefined);
  });
});

// ---------- 数据层：前一交易日K线、全A快照完整性、热股榜日期、分页截断 ----------
const D = '2026-10-16';
const Dms = dateMs(D);
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function router({ prevBarMs = Dms - DAY, snapshot = null, hotDate = D, upPages = 1 } = {}) {
  return async (url) => {
    const u = new URL(url);
    const p = u.pathname;
    let data;
    if (p === '/api/a-share-index/prices/historical') data = { item: [{ date_ms: prevBarMs, close_price: 3700, turnover: 7e11 }, { date_ms: Dms, close_price: 3716.28, turnover: 7.5e11 }] };
    else if (p === '/api/a-share/prices/snapshot') data = snapshot;
    else if (p.endsWith('/limit-up-statistics')) data = { trade_date: D, limit_up_stock_count: 2, open_stock_count: 1, touched_limit_up_stock_count: 3, seal_rate: 0.6667, exact_boards: [], page_boards: [] };
    else if (p.endsWith('/limit-up-pool')) data = { pagination: { pages: upPages, total: upPages * 2 }, item: [{ name: '新华传媒', thscode: '600825.SH', continue_day_cnt: 1, limit_up_reason: '重组', limit_up_time: '09:25', seal_money: 3e8 }, { name: '冰山冷热', thscode: '000530.SZ', continue_day_cnt: 1, limit_up_reason: '冷链', limit_up_time: '10:01', seal_money: 1e8 }] };
    else if (p.endsWith('/hot-stock-list-history')) data = { date: hotDate, item: [{ name: '新华传媒', thscode: '600825.SH', rank: 1 }] };
    else if (p === '/api/news/anomaly/analysis') data = { items: [] };
    else data = { pagination: { pages: 1, total: 0 }, item: [], total: 0 };
    return json({ code: 0, request_id: `req-${p}`, data });
  };
}
process.env.FUYAO_API_KEY = 'unit-test-dummy-key';
process.env.FUYAO_BASE_URL = 'http://fuyao.test';
const TD = { date: D, prevDate: '2026-10-15', latestClosed: D, isLatest: true, snapshotIsDateClose: false };

describe('数据层：日期与完整性校验', () => {
  test('前一根K线不是前一交易日（中间缺一天）→ 提示核验，不计算涨跌幅与成交额变化', async (t) => {
    t.mock.method(globalThis, 'fetch', router({ prevBarMs: Dms - 3 * DAY }));
    const { sheet: s, base } = await collectBase({ calls: [], simulate: [] }, TD);
    assert.ok(s.dq.some((d) => /上证指数缺少前一交易日K线/.test(d.title)));
    assert.equal(base.ids.index['000001.SH'].pct, undefined, '不能跨日计算涨跌幅');
    assert.ok(base.ids.index['000001.SH'].close, '收盘点位照常');
    assert.equal(base.ids.turnoverChg, undefined);
    assert.ok(s.gaps.some((g) => g.title === '沪深两市成交额'));
  });
  test('全A快照返回 0 只 → 记为缺失，不出具"上涨 0 家、下跌 0 家"', async (t) => {
    t.mock.method(globalThis, 'fetch', router({ snapshot: { total: 0, item: [], timestamp: Dms + 16 * 3600e3 } }));
    const { sheet: s, base } = await collectBase({ calls: [], simulate: [] }, { ...TD, snapshotIsDateClose: true });
    assert.ok(s.gaps.some((g) => g.section === 'breadth' && /样本不完整/.test(g.reason)));
    assert.equal(base.ids.breadth.up, undefined);
  });
  test('热股榜返回日期与所选交易日不符 → 不采用并提示', async (t) => {
    t.mock.method(globalThis, 'fetch', router({ hotDate: '2026-10-15' }));
    const { sheet: s, base } = await collectBase({ calls: [], simulate: [] }, TD);
    assert.ok(s.dq.some((d) => d.title === '热股榜日期不符' && d.level === 'error'));
    assert.equal(base.hot.length, 0);
  });
  test('涨停池超过 5 页 → 提示只取了前 5 页（家数以统计接口为准）', async (t) => {
    t.mock.method(globalThis, 'fetch', router({ upPages: 7 }));
    const { sheet: s } = await collectBase({ calls: [], simulate: [] }, TD);
    assert.ok(s.dq.some((d) => d.code === 'truncated' && /涨停/.test(d.title)));
  });
  test('名称里带数字的题材与个股进入实体表，避免被当成未溯源数字', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      const res = await router()(url);
      if (!new URL(url).pathname.endsWith('/limit-up-pool')) return res;
      return json({ code: 0, request_id: 'r', data: { pagination: { pages: 1, total: 1 }, item: [{ name: '新华传媒', thscode: '600825.SH', continue_day_cnt: 1, limit_up_reason: '5G+重组', limit_up_time: '09:25', seal_money: 3e8 }] } });
    });
    const { sheet: s } = await collectBase({ calls: [], simulate: [] }, TD);
    assert.ok(s.entities.includes('5G'));
    assert.ok(!s.entities.includes('重组'), '不含数字的名称无需进入实体表');
  });
});

describe('存储：进行中的临时标记不落盘', () => {
  test('ai_review_running 不写入磁盘；读到旧文件里的该标记也会清除', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-store-'));
    try {
      const store = new Store(dir, null);
      store.save({ id: 'r1', created_at: 1, status: 'draft', ai_review_running: true, draft: { sections: [] } });
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'r1.json'), 'utf8'));
      assert.equal(onDisk.ai_review_running, undefined);
      fs.writeFileSync(path.join(dir, 'runs', 'r2.json'), JSON.stringify({ id: 'r2', created_at: 2, status: 'draft', ai_review_running: true }));
      assert.equal(new Store(dir, null).get('r2').ai_review_running, undefined, '实例重启后稿件不能被永久锁住');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('系统锁定句不参与校验，避免无法提交的死锁', () => {
  test('核验标题含数字（"超过 5 页"）、团队规则命中系统文字 → 系统句不产生阻断，确认后即可提交', () => {
    const sh = { ...sheet, gaps: [{ title: 'iFinD 新闻检索：5G 通信' }], dq: [{ level: 'warn', title: '涨停股票池超过 5 页只取了前 5 页' }] };
    const draft = { sections: [{ sentences: [{ id: 'S1', text: '涨停家数为{{F3}}。', type: 'fact', refs: ['F3'], origin: 'ai' }] }] };
    assert.equal(addSystemPendings(draft, sh), 2);
    let gate = verifyDraft(draft, sh, [{ phrase: '人工确认', level: 'block' }]);
    assert.equal(gate.block, 0, JSON.stringify(draft.sections[0].sentences.map((x) => x.flags)));
    assert.equal(gate.pending_unresolved, 2);
    draft.sections[0].sentences.filter((x) => x.locked).forEach((x) => { x.pending_confirmed = true; });
    gate = verifyDraft(draft, sh, [{ phrase: '人工确认', level: 'block' }]);
    assert.equal(gate.can_submit, true);
  });
  test('同样的数字写在普通句里仍然阻断', () => {
    assert.ok(rules('涨停股票池超过 5 页。').includes('untraced_number'));
  });
});

describe('AI 待确认句与系统缺失说明去重', () => {
  test('2026-09-30 真实输出：模型自写的两句缺失说明与系统句重复 → 软删除并注明；其余待确认句不动', () => {
    const sh = { gaps: [{ title: '全市场涨跌家数' }], dq: [{ level: 'warn', title: '涨停池记录数与统计口径不一致' }, { level: 'info', title: '仅供参考的提示' }] };
    const draft = { sections: [{ sentences: [
      { id: 'S1', text: '全市场涨跌家数缺失，行情快照无法回溯历史交易日的涨跌家数，当日市场整体涨跌分布暂无法确认。', type: 'pending', refs: [], origin: 'ai' },
      { id: 'S2', text: '涨停池记录数与统计接口口径不一致，正文采用统计接口口径，具体家数口径需人工复核。', type: 'pending', refs: [], origin: 'ai' },
      { id: 'S3', text: '固态电池相关个股{{F28}}，是否属于分歧尚需资金流向数据确认。', type: 'pending', refs: ['F28'], origin: 'ai' },
      { id: 'S4', text: '业绩增长类涨停分散于多个行业，是否构成统一主线尚待行业分布数据确认。', type: 'pending', refs: [], origin: 'ai' },
      { id: 'S5', text: '全市场涨跌家数缺失，请投顾补充。', type: 'pending', refs: [], origin: 'human' },
    ] }] };
    assert.equal(dedupePendings(draft, sh), 2);
    const [s1, s2, s3, s4, s5] = draft.sections[0].sentences;
    assert.equal(s1.deleted, true);
    assert.equal(s1.dedup, '全市场涨跌家数');
    assert.equal(s2.deleted, true);
    assert.equal(s2.dedup, '涨停池记录数与统计口径不一致');
    assert.ok(!s3.deleted, '引用了数字事实的待确认句另有内容');
    assert.ok(!s4.deleted, '证据不足类待确认句不是重复');
    assert.ok(!s5.deleted, '人写的句子不自动删除');
    assert.equal(addSystemPendings(draft, sh), 2, '系统句照常追加，缺失说明不丢');
  });
});
