// pipeline.js 单元测试：大模型不可用时的模板降级稿只含事实/待确认/带依据推断，且没有未溯源数字
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { templateDraft, nextSentenceId, addSystemPendings } from '../lib/pipeline.js';
import { FactSheet, pctText } from '../lib/collect.js';
import { verifyDraft, verifySentence, renderText, computeGate } from '../lib/verify.js';

function fakeSheet({ stats = true, indices = true, breadth = true, gaps = [], dq = [] } = {}) {
  const sheet = new FactSheet();
  const call = { id: 'T1', path: '/api/test', request_id: 'r1' };
  const f = (label, display, extra = {}) => sheet.fact(call, { label, display, value: 0, ...extra });
  const base = { td: { date: '2026-10-16' }, ids: { index: {}, limit: {}, leaders: [], themes: [], hot: [], breadth: {} } };
  if (indices) {
    for (const [code, name, close, pct] of [['000001.SH', '上证指数', 3716.28, 0.24], ['399001.SZ', '深证成指', 11802.46, -0.12], ['399006.SZ', '创业板指', 2772.38, -0.39], ['000300.SH', '沪深300', 4170.61, 0.11], ['000688.SH', '科创50', 1358.65, -0.06], ['899050.BJ', '北证50', 950, -1.81]]) {
      base.ids.index[code] = { name, close: f(`${name}收盘点位`, `${close.toFixed(2)}点`), pct: f(`${name}涨跌幅`, pctText(pct)) };
    }
    base.ids.turnover = f('沪深两市成交额', '15,554亿元');
    base.ids.turnoverChg = f('两市成交额较前一交易日变化', '较前一交易日减少776亿元（−4.75%）');
  }
  if (breadth) base.ids.breadth = { up: f('上涨家数', '3301家'), down: f('下跌家数', '2127家'), flat: f('平盘家数', '138家') };
  const L = base.ids.limit;
  if (stats) {
    L.up = f('涨停家数', '59家'); L.open = f('炸板家数', '49家'); L.sealRate = f('封板率', '54.6%');
    L.maxBoard = f('最高连板高度', '11连板'); L.multi = f('连板股家数（二板及以上）', '7家'); L.promo2 = f('二板晋级率', '13%');
  } else {
    L.upPool = f('涨停池股票数', '59只');
  }
  L.down = f('跌停家数', '10家');
  for (const [name, d] of [['新华传媒', '11连板'], ['冰山冷热', '4连板']]) base.ids.leaders.push({ name, fact: f(`${name}连板高度`, d, { stock: name }) });
  for (const [tag, n] of [['低空经济', 11], ['F5G', 3]]) base.ids.themes.push({ tag, fact: f(`涨停原因含「${tag}」的个股数`, `${n}只`, { members: ['甲', '乙'] }), members: ['甲', '乙'] });
  gaps.forEach((g) => sheet.gap(g));
  dq.forEach((d) => sheet.issue(d));
  return { sheet, base };
}
const all = (draft) => draft.sections.flatMap((s) => s.sentences);
const flagRules = (draft) => all(draft).flatMap((s) => s.flags.map((x) => x.rule));

describe('templateDraft（大模型降级稿）', () => {
  test('数据齐全：四节结构，只有 fact/pending/inference，校验无阻断项', () => {
    const { sheet, base } = fakeSheet();
    const draft = templateDraft(sheet, base);
    assert.deepEqual(draft.sections.map((s) => s.heading), ['一、指数与量能', '二、涨停结构与市场情绪', '三、主线题材与归因', '四、风险提示与待确认事项']);
    for (const s of all(draft)) {
      assert.ok(['fact', 'pending', 'inference'].includes(s.type));
      assert.equal(s.origin, 'template');
    }
    const gate = verifyDraft(draft, sheet);
    assert.deepEqual(flagRules(draft), []);
    assert.equal(gate.block, 0);
    // 主线归因、风险提示两句固定为待确认，提交前必须由投顾确认
    assert.equal(gate.pending_unresolved, 2);
    assert.equal(gate.can_submit, false);
    all(draft).filter((s) => s.type === 'pending').forEach((s) => { s.pending_confirmed = true; });
    assert.equal(computeGate(draft).can_submit, true);
    // 渲染后没有残留占位符或无效引用
    for (const s of all(draft)) {
      const out = renderText(s.text, sheet, '2026-10-16');
      assert.ok(!out.includes('{{') && !out.includes('无效引用'), out);
    }
    assert.equal(renderText(draft.title, sheet, '2026-10-16'), '10月16日盘后复盘（数据底稿版）');
  });

  test('降级稿不含任何推断句（与"本稿不含推断"的说明一致）', () => {
    const { sheet, base } = fakeSheet();
    const draft = templateDraft(sheet, base);
    assert.equal(all(draft).filter((s) => s.type === 'inference').length, 0);
  });

  test('统计接口不可用 + 指数日K缺失 + 数据冲突：缺失项写成待确认句，仍无未溯源数字', () => {
    const { sheet, base } = fakeSheet({
      stats: false, indices: false, breadth: false,
      gaps: [
        { section: 'index', title: '沪深300日K线', reason: '接口调用失败：故障演练（code=5003）' },
        { section: 'index', title: '科创50日K线', reason: '接口调用失败：故障演练（code=5003）' },
        { section: 'index', title: '沪深两市成交额', reason: '日K缺失' },
        { section: 'limit', title: '涨停强度与晋级统计', reason: '接口返回的是 2026-10-15 的数据' },
        { section: 'breadth', title: '全市场涨跌家数', reason: '盘中数据' },
      ],
      dq: [{ level: 'error', code: 'stale', title: '涨停统计返回日期与所选交易日不一致' }, { level: 'info', code: 'window', title: '连板天梯窗口不含所选日' }],
    });
    const draft = templateDraft(sheet, base);
    const added = addSystemPendings(draft, sheet);
    const gate = verifyDraft(draft, sheet);
    assert.ok(!flagRules(draft).includes('untraced_number'), JSON.stringify(flagRules(draft)));
    assert.equal(gate.block, 0);
    assert.equal(draft.sections[0].sentences.length, 0, '缺失的指数数据不出现任何数字句');
    assert.match(all(draft).map((s) => s.text).join(''), /涨停池共\{\{F\d+\}\}/);
    // 5 条缺失 + 1 条 error 级核验问题由系统追加为锁定的待确认句；info 级不出句子
    assert.equal(added, 6);
    const sys = all(draft).filter((s) => s.origin === 'system');
    assert.equal(sys.length, 6);
    assert.ok(sys.every((s) => s.locked && s.type === 'pending'));
    // 系统句 6 + 模板固定待确认 2
    assert.equal(gate.pending_unresolved, 8);
  });

  test('模板稿里的题材名「F5G」应原样保留', () => {
    const { sheet, base } = fakeSheet();
    const s = templateDraft(sheet, base).sections[2].sentences[0];
    assert.match(s.text, /「F5G」相关涨停/);
  });

  test('故障演练注入的违规句被阻断（与 runPipeline 中 inject_violation 相同文本）', () => {
    const { sheet, base } = fakeSheet();
    const draft = templateDraft(sheet, base);
    const s = { id: nextSentenceId(draft), text: '情绪明显回暖，建议明日逢低布局高标股，后市有望继续上涨，参与者稳赚。', type: 'inference', refs: [], origin: 'injected' };
    draft.sections[3].sentences.push(s);
    assert.match(s.id, /^S\d+$/);
    const gate = verifyDraft(draft, sheet);
    assert.deepEqual(new Set(verifySentence(s, sheet).filter((x) => x.level === 'block').map((x) => x.rule)), new Set(['inference_no_basis', 'predict', 'advice', 'promise']));
    assert.equal(gate.block, 4);
    assert.equal(gate.can_submit, false);
  });
});
