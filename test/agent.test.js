// agent.js 单元测试：normalizeDraft（经由它测试未导出的 liftInlineRefs）与 LLM 调用的降级路径（mock fetch）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDraft, writeDraft, aiComplianceReview, llmChat, LlmError } from '../lib/agent.js';

process.env.DEEPSEEK_API_KEY = 'unit-test-dummy-key';
process.env.DEEPSEEK_BASE_URL = 'http://llm.test';

const one = (text, refs = [], type = 'fact') => normalizeDraft({ title: 't', sections: [{ heading: 'h', sentences: [{ text, type, refs }] }] }, 'ai').sections[0].sentences[0];
const sorted = (a) => [...a].sort();

describe('normalizeDraft / liftInlineRefs', () => {
  test('括号内的依据编号「（E7、E9）」移出正文并入 refs', () => {
    const s = one('新华传媒复牌后连续涨停（E7、E9）。', ['F5']);
    assert.equal(s.text, '新华传媒复牌后连续涨停。');
    assert.deepEqual(sorted(s.refs), ['E7', 'E9', 'F5']);
  });

  test('半角括号与「依据：」前缀同样处理', () => {
    const s = one('出版方向或为主线(依据：E3)。', [], 'inference');
    assert.equal(s.text, '出版方向或为主线。');
    assert.deepEqual(s.refs, ['E3']);
  });

  test('范围写法「E11–E14」展开为 E11..E14 并从正文删除', () => {
    const s = one('异动解读E11–E14均提及重组预期，或为主要催化。', [], 'inference');
    assert.ok(!/E\d/.test(s.text), s.text);
    assert.equal(s.text, '异动解读均提及重组预期，或为主要催化。');
    assert.deepEqual(sorted(s.refs), ['E11', 'E12', 'E13', 'E14']);
    assert.deepEqual(sorted(one('见E2-E4。').refs), ['E2', 'E3', 'E4']);
  });

  test('{{F3}} 占位符保持不动，不会被当作内联编号删除', () => {
    const s = one('上证指数收于{{F3}}，{{F4}}（F3、F4）。');
    assert.equal(s.text, '上证指数收于{{F3}}，{{F4}}。');
    assert.deepEqual(sorted(s.refs), ['F3', 'F4']);
    const s2 = one('{{F12}}，{{E1}}。');
    assert.equal(s2.text, '{{F12}}，{{E1}}。');
    assert.deepEqual(s2.refs, []);
  });

  test('结构规整：非法 type 归为 inference、空句剔除、编号连续、refs 转字符串', () => {
    const d = normalizeDraft({
      sections: [
        { heading: '一', sentences: [{ text: ' 甲 ', type: 'opinion', refs: [3] }, { text: '   ', type: 'fact' }] },
        { sentences: [{ text: '乙', type: 'pending' }] },
      ],
    }, 'ai');
    assert.equal(d.title, '盘后复盘');
    assert.deepEqual(d.sections.map((s) => s.id), ['C1', 'C2']);
    assert.equal(d.sections[1].heading, '第2节');
    const [a] = d.sections[0].sentences;
    assert.equal(d.sections[0].sentences.length, 1);
    assert.equal(a.text, '甲');
    assert.equal(a.type, 'inference');
    assert.deepEqual(a.refs, ['3']);
    assert.equal(a.origin, 'ai');
    assert.equal(d.sections[1].sentences[0].type, 'pending');
  });

  test('混合列表「（E3、E5–E7）」应保留 E3 并展开 E5..E7', () => {
    const s = one('多家公司公告重组（E3、E5–E7）。');
    assert.equal(s.text, '多家公司公告重组。');
    assert.deepEqual(sorted(s.refs), ['E3', 'E5', 'E6', 'E7']);
  });

  test('题材名「F5G」不应被当作内联编号 F5 删掉', () => {
    const s = one('F5G概念相关涨停{{F9}}。', ['F9']);
    assert.equal(s.text, 'F5G概念相关涨停{{F9}}。');
    assert.deepEqual(s.refs, ['F9']);
  });
});

describe('LLM 调用与降级路径（mock fetch）', () => {
  const chat = (content, status = 200) => new Response(JSON.stringify(status === 200
    ? { model: 'deepseek-chat', usage: { total_tokens: 42 }, choices: [{ message: { role: 'assistant', content } }] }
    : { error: { message: 'server busy' } }), { status, headers: { 'content-type': 'application/json' } });
  const sheet = { facts: [{ id: 'F1', label: '上证指数收盘点位', display: '3716.28点' }], evidence: [{ id: 'E1', stock: '新华传媒', text: '涨停原因：复牌+重组' }], gaps: [], dq: [] };
  const base = { td: { date: '2026-10-16' } };

  test('simulate=llm_down → 直接抛 LlmError，不发请求', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => chat('{}'));
    await assert.rejects(llmChat({ simulate: ['llm_down'], llm: [] }, []), (e) => e instanceof LlmError && /故障演练/.test(e.message));
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  test('HTTP 500 → LlmError（由 pipeline 捕获后降级为模板稿）', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => chat(null, 500));
    await assert.rejects(llmChat({ simulate: [], llm: [] }, []), (e) => e instanceof LlmError && /HTTP 500/.test(e.message));
  });

  test('writeDraft：模型两次都不输出合法 JSON → 重试一次后抛 LlmError', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => chat('这不是 JSON'));
    const ctx = { simulate: [], llm: [] };
    await assert.rejects(writeDraft(ctx, sheet, base, 'steady', ''), (e) => e instanceof LlmError && /两次/.test(e.message));
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.equal(ctx.llm.length, 2);
  });

  test('writeDraft：合法 JSON → 经 normalizeDraft 规整（内联编号被移入 refs）', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => chat(JSON.stringify({ title: '{{DATE}}复盘', sections: [{ heading: '一、指数与量能', sentences: [{ text: '上证指数收于{{F1}}（F1）。', type: 'fact', refs: [] }] }] })));
    const d = await writeDraft({ simulate: [], llm: [] }, sheet, base, 'steady', '');
    assert.equal(d.sections[0].sentences[0].text, '上证指数收于{{F1}}。');
    assert.deepEqual(d.sections[0].sentences[0].refs, ['F1']);
    assert.equal(d.sections[0].sentences[0].origin, 'ai');
  });

  test('aiComplianceReview：解析 issues；返回非法内容时得到空数组', async (t) => {
    const issues = [{ sid: 'S3', category: '隐含预测', reason: '「后续值得期待」暗示上涨', suggestion: '删除' }];
    const m = t.mock.method(globalThis, 'fetch', async () => chat(JSON.stringify({ issues })));
    assert.deepEqual(await aiComplianceReview({ simulate: [], llm: [] }, [{ sid: 'S3', type: 'inference', text: '后续值得期待。' }]), issues);
    m.mock.mockImplementation(async () => chat('oops'));
    assert.deepEqual(await aiComplianceReview({ simulate: [], llm: [] }, []), []);
  });
});
