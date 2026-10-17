import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifySentence, renderText, trimOverlap, verifyDraft, coverage } from '../lib/verify.js';
import { normalizeHypotheses } from '../lib/agent.js';
import { repairDraft } from '../lib/repair.js';
import { chgText, ppText } from '../lib/collect.js';

const sheet = {
  facts: [
    { id: 'F1', label: '上证指数收盘点位', display: '3716.28点', unit: '点' },
    { id: 'F2', label: '上证指数涨跌幅', display: '上涨0.24%', unit: '%' },
    { id: 'F3', label: '涨停家数', display: '59家', unit: '家' },
    { id: 'F4', label: '涨停原因含「低空经济」的个股数（前一交易日）', display: '0只', unit: '只' },
    { id: 'F5', label: '新华传媒连板高度', display: '11连板', unit: '板', stock: '新华传媒' },
  ],
  evidence: [{ id: 'E1', stock: '新华传媒', kind: '异动解读', text: '复牌后一字涨停' }],
};

describe('环比与渲染', () => {
  test('chgText / ppText 自带方向词，持平单独表述', () => {
    assert.equal(chgText(23, '家'), '较前一交易日增加23家');
    assert.equal(chgText(-5, '家'), '较前一交易日减少5家');
    assert.equal(chgText(0, '家'), '与前一交易日持平');
    assert.equal(ppText(-29.06), '较前一交易日下降29.1个百分点');
    assert.equal(ppText(0.01), '与前一交易日基本持平');
  });
  test('占位符前已有渲染值开头的字词时去重（前一交易日为 / ，上涨）', () => {
    assert.equal(trimOverlap('后者前一交易日为', '前一交易日2只', ''), '2只');
    assert.equal(renderText('上证指数，上涨{{F2}}', sheet, '2026-10-16'), '上证指数，上涨0.24%');
    assert.equal(renderText('上证指数收于{{F1}}', sheet, '2026-10-16'), '上证指数收于3716.28点');
  });
});

describe('搭配校验', () => {
  test('「收于」后接涨跌幅 → 阻断', () => {
    const flags = verifySentence({ text: '上证指数收于{{F2}}。', type: 'fact', refs: [] }, sheet);
    assert.ok(flags.some((f) => f.rule === 'unit_mismatch' && f.level === 'block'));
  });
  test('「收于」后接点位 → 不报', () => {
    const flags = verifySentence({ text: '上证指数{{F2}}，收于{{F1}}。', type: 'fact', refs: [] }, sheet);
    assert.equal(flags.filter((f) => f.rule === 'unit_mismatch').length, 0);
  });
});

describe('团队规则', () => {
  test('命中禁用表述：按规则级别阻断或提醒', () => {
    const custom = [{ phrase: '龙头', level: 'warn', reason: '易被理解为推荐' }, { phrase: '确定性机会', level: 'block' }];
    const a = verifySentence({ text: '新华传媒成为板块龙头，连板高度{{F5}}。', type: 'fact', refs: ['F5'] }, sheet, undefined, custom);
    assert.ok(a.some((f) => f.rule === 'custom' && f.level === 'warn'));
    const b = verifySentence({ text: '出现确定性机会。', type: 'inference', refs: ['F3'] }, sheet, undefined, custom);
    assert.ok(b.some((f) => f.rule === 'custom' && f.level === 'block'));
  });
  test('verifyDraft 把团队规则传给每一句', () => {
    const draft = { sections: [{ sentences: [{ id: 'S1', text: '确定性机会。', type: 'inference', refs: ['F3'] }] }] };
    const gate = verifyDraft(draft, sheet, [{ phrase: '确定性机会', level: 'block' }]);
    assert.equal(gate.can_submit, false);
  });
});

describe('主线判断规整', () => {
  test('不存在的编号被剔除并记为问题；无有效支持证据的"支持"降为"存疑"', () => {
    const hs = normalizeHypotheses([
      { claim: '低空经济为当日新增主线', verdict: '支持', support: ['F3', 'F4', 'F99'], against: [] },
      { claim: '出版板块整体走强', verdict: '支持', support: ['F77'], against: ['E1'] },
      { claim: '', verdict: '支持', support: ['F3'] },
    ], sheet);
    assert.equal(hs.length, 2);
    assert.deepEqual(hs[0].support, ['F3', 'F4']);
    assert.match(hs[0].problems[0], /F99/);
    assert.equal(hs[1].verdict, '存疑');
    assert.ok(hs[1].problems.some((p) => /没有有效的支持证据/.test(p)));
  });
  test('非法结论值归为"存疑"', () => {
    const [h] = normalizeHypotheses([{ claim: 'x', verdict: '肯定', support: ['F3'] }], sheet);
    assert.equal(h.verdict, '存疑');
  });
});

describe('自修复（校验器在环）', () => {
  const mkDraft = () => ({
    sections: [{
      sentences: [
        { id: 'S1', text: '上证指数收于3716点，上涨0.24%。', type: 'fact', refs: ['F1'], origin: 'ai' },
        { id: 'S2', text: '建议明日关注低空经济。', type: 'inference', refs: ['F4'], origin: 'ai' },
        { id: 'S3', text: '情绪回暖，后市有望继续上涨。', type: 'inference', refs: [], origin: 'injected' },
        { id: 'S4', text: '投顾手写的数字123。', type: 'fact', refs: [], origin: 'human' },
      ],
    }],
  });
  const withLlm = async (content, fn) => {
    const prev = globalThis.fetch;
    process.env.DEEPSEEK_API_KEY = 'unit-test-dummy-key';
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { total_tokens: 1 } }), { status: 200 }); };
    try { return await fn(() => calls); } finally { globalThis.fetch = prev; }
  };

  test('修好的句子替换原句并保留修复记录；只修 AI 句，注入句与人工句不动', async () => {
    const draft = mkDraft();
    verifyDraft(draft, sheet);
    const content = JSON.stringify({ repairs: [
      { id: 'S1', action: 'rewrite', text: '上证指数收于{{F1}}，{{F2}}。', type: 'fact', refs: ['F1', 'F2'], reason: '数字改为引用' },
      { id: 'S2', action: 'delete', reason: '属于操作建议，无法保留' },
    ] });
    await withLlm(content, async (calls) => {
      const stats = await repairDraft({ calls: [], llm: [], simulate: [] }, sheet, draft, {});
      assert.deepEqual({ a: stats.attempted, f: stats.fixed, d: stats.deleted, x: stats.failed }, { a: 2, f: 1, d: 1, x: 0 });
      assert.equal(calls(), 1);
    });
    const [s1, s2, s3, s4] = draft.sections[0].sentences;
    assert.equal(s1.text, '上证指数收于{{F1}}，{{F2}}。');
    assert.equal(s1.repair.status, 'fixed');
    assert.match(s1.repair.before.text, /3716/);
    assert.equal(s1.flags.filter((f) => f.level === 'block').length, 0);
    assert.equal(s2.deleted, true);
    assert.equal(s3.repair, undefined);
    assert.ok(s3.flags.some((f) => f.level === 'block'));
    assert.equal(s4.repair, undefined);
  });

  test('修订稿仍不合规时不采用，保留原句与原问题', async () => {
    const draft = mkDraft();
    verifyDraft(draft, sheet);
    const content = JSON.stringify({ repairs: [{ id: 'S1', action: 'rewrite', text: '上证指数收于3716.28点。', type: 'fact', refs: ['F1'] }] });
    await withLlm(content, async () => { await repairDraft({ calls: [], llm: [], simulate: [] }, sheet, draft, {}); });
    const s1 = draft.sections[0].sentences[0];
    assert.equal(s1.text, '上证指数收于3716点，上涨0.24%。');
    assert.equal(s1.repair.status, 'failed');
    assert.ok(s1.repair.remaining.some((m) => /未溯源数字/.test(m)));
  });

  test('大模型不可用时不修改任何句子', async () => {
    const draft = mkDraft();
    verifyDraft(draft, sheet);
    const stats = await repairDraft({ calls: [], llm: [], simulate: ['llm_down'] }, sheet, draft, {});
    assert.equal(stats.fixed, 0);
    assert.equal(stats.failed, 2);
    assert.equal(draft.sections[0].sentences[0].text, '上证指数收于3716点，上涨0.24%。');
  });
});

describe('关键事实覆盖提醒', () => {
  test('当天有数据但正文没引用的清单项记为 missed；当天没有的数据不计入分母', () => {
    const sh = { facts: [
      { id: 'F1', label: '上证指数涨跌幅', display: '上涨0.24%' },
      { id: 'F2', label: '涨停家数', display: '59家' },
      { id: 'F3', label: '涨停原因含「低空经济」的个股数', display: '11只' },
    ], evidence: [] };
    const draft = { sections: [{ sentences: [
      { id: 'S1', text: '上证指数{{F1}}。', type: 'fact', refs: [] },
      { id: 'S2', text: '涨停{{F2}}。', type: 'fact', refs: [], deleted: true },
    ] }] };
    const c = coverage(draft, sh);
    assert.equal(c.applicable, 3);
    assert.equal(c.covered, 1);
    assert.deepEqual(c.missed.map((m) => m.name).sort(), ['涨停家数', '第一大涨停题材'].sort());
  });
});
