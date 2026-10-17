// verify.js 单元测试：合规词表、数字溯源、实体一致性、句子类型、渲染与提交闸门（纯函数，无网络）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, verifySentence, verifyDraft, renderText, trimOverlap, computeGate, entityNames } from '../lib/verify.js';

const sheet = {
  facts: [
    { id: 'F1', label: '上证指数收盘点位', display: '3716.28点', value: 3716.28 },
    { id: 'F2', label: '上证指数涨跌幅', display: '上涨0.24%', value: 0.2374 },
    { id: 'F3', label: '沪深300涨跌幅', display: '上涨0.51%', value: 0.51 },
    { id: 'F4', label: '科创50涨跌幅', display: '下跌0.32%', value: -0.32 },
    { id: 'F5', label: '新华传媒连板高度', display: '11连板', value: 11, stock: '新华传媒' },
    { id: 'F6', label: '冰山冷热连板高度', display: '4连板', value: 4, stock: '冰山冷热' },
    { id: 'F7', label: '新华传媒热股榜排名', display: '第1名', value: 1, stock: '新华传媒' },
    { id: 'F8', label: '炸板家数', display: '18家', value: 18 },
    { id: 'F9', label: '涨停原因含「F5G」的个股数', display: '3只', value: 3, members: ['甲', '乙', '丙'] },
  ],
  evidence: [{ id: 'E1', kind: '涨停原因标签', stock: '新华传媒', text: '新华传媒涨停原因标签：复牌+重组+图书发行' }],
};
const S = (text, type = 'pending', refs = [], extra = {}) => ({ text, type, refs, ...extra });
const check = (s) => verifySentence(s, sheet);
const rulesOf = (flags) => flags.map((f) => f.rule);
const levelOf = (flags, rule) => flags.find((f) => f.rule === rule)?.level;

describe('合规词表 RULES', () => {
  test('词表包含 4 类规则，hype 为 warn，其余为 block', () => {
    assert.deepEqual(Object.fromEntries(RULES.map((r) => [r.id, r.level])), { predict: 'block', advice: 'block', promise: 'block', hype: 'warn' });
  });

  test('预测类：「后市有望继续上涨」等 → block', () => {
    for (const t of ['后市有望继续上涨。', '明天必涨。', '反转在即。', '行情才刚刚开始。', '大概率延续反弹。']) {
      const flags = check(S(t));
      assert.equal(levelOf(flags, 'predict'), 'block', t);
    }
  });

  test('荐股/仓位类：「建议逢低布局」等 → block', () => {
    for (const t of ['建议逢低布局。', '可以适当加仓。', '该股值得关注。', '控制好仓位。', '建议买入高标股。']) {
      const flags = check(S(t));
      assert.equal(levelOf(flags, 'advice'), 'block', t);
    }
  });

  test('收益承诺类：「稳赚」「保本」「零风险」 → block', () => {
    for (const t of ['跟上就能稳赚。', '这类产品保本。', '零风险套利。']) {
      const flags = check(S(t));
      assert.equal(levelOf(flags, 'promise'), 'block', t);
    }
  });

  test('夸张措辞（hype）只给 warn，不阻断提交', () => {
    const flags = check(S('千载难逢，妖股疯涨。'));
    assert.equal(levelOf(flags, 'hype'), 'warn');
    assert.equal(flags.filter((f) => f.level === 'block').length, 0);
  });

  test('故障演练注入的违规句同时命中预测、荐股、收益承诺，且推断无依据', () => {
    const flags = check(S('情绪明显回暖，建议明日逢低布局高标股，后市有望继续上涨，参与者稳赚。', 'inference'));
    for (const r of ['predict', 'advice', 'promise', 'inference_no_basis']) assert.equal(levelOf(flags, r), 'block', r);
  });

  test('中性事实陈述不触发任何合规规则', () => {
    const flags = check(S('{{DATE}}，上证指数收于{{F1}}，{{F2}}。', 'fact', ['F1', 'F2']));
    assert.deepEqual(flags, []);
  });

  test('「主要涨停方向」「将涨停个股归类」等含"要涨/将涨"的中性陈述不应判为预测', () => {
    for (const t of ['当日主要涨停方向集中在出版传媒。', '将涨停个股按题材归类后，出版方向居前。', '主要跌停个股集中在前期高位股。']) {
      assert.equal(levelOf(check(S(t)), 'predict'), undefined, t);
    }
  });
});

describe('数字溯源 untraced_number', () => {
  test('占位符之外的阿拉伯数字 → block', () => {
    const flags = check(S('上证指数收于3716点。', 'fact', ['F1']));
    assert.equal(levelOf(flags, 'untraced_number'), 'block');
    assert.match(flags.find((f) => f.rule === 'untraced_number').msg, /3716点/);
  });

  test('全角数字、日期数字同样拦截（日期必须写 {{DATE}}）', () => {
    assert.equal(levelOf(check(S('成交额３７１６亿。', 'fact', ['F1'])), 'untraced_number'), 'block');
    assert.equal(levelOf(check(S('2026年10月16日市场震荡。', 'fact', ['F1'])), 'untraced_number'), 'block');
  });

  test('数字全部通过 {{F}}/{{DATE}} 占位符引用 → 不报', () => {
    assert.equal(levelOf(check(S('{{DATE}}，上证指数收于{{F1}}，{{F2}}。', 'fact', ['F1', 'F2'])), 'untraced_number'), undefined);
  });

  test('名称自带数字的指数（沪深300/科创50/中证1000/创业板50/北证50）不算未溯源数字', () => {
    assert.equal(levelOf(check(S('沪深300{{F3}}，科创50{{F4}}。', 'fact', ['F3', 'F4'])), 'untraced_number'), undefined);
    assert.equal(levelOf(check(S('中证1000、创业板50与北证50走势分化，待确认。')), 'untraced_number'), undefined);
  });

  test('底稿事实名称中带数字的实体（如题材「F5G」）也被豁免', () => {
    assert.ok(entityNames(sheet).includes('F5G'));
    assert.ok(entityNames(sheet).includes('沪深300'));
    assert.equal(levelOf(check(S('F5G相关涨停{{F9}}。', 'fact', ['F9'])), 'untraced_number'), undefined);
  });

  test('常见带数字指数（中证A500、科创100）也不应判为未溯源数字', () => {
    for (const t of ['中证A500走势偏强，待确认。', '科创100表现弱于科创50，待确认。']) {
      assert.equal(levelOf(check(S(t)), 'untraced_number'), undefined, t);
    }
  });

  test('引用底稿中不存在的编号 → unknown_ref block', () => {
    const flags = check(S('上证指数收于{{F99}}。', 'fact', ['F1']));
    assert.equal(levelOf(flags, 'unknown_ref'), 'block');
  });
});

describe('实体一致性 entity_mismatch', () => {
  test('属于「新华传媒」的事实被用在另一只股票的分句里 → block', () => {
    const flags = check(S('冰山冷热{{F5}}，高度居首。', 'fact', ['F5']));
    assert.equal(levelOf(flags, 'entity_mismatch'), 'block');
    assert.match(flags.find((f) => f.rule === 'entity_mismatch').msg, /新华传媒/);
  });

  test('事实与股票名在同一分句 → 不报', () => {
    const flags = check(S('连板梯队中，新华传媒{{F5}}，冰山冷热{{F6}}。', 'fact', ['F5', 'F6']));
    assert.equal(levelOf(flags, 'entity_mismatch'), undefined);
  });
});

describe('句子类型与依据', () => {
  test('「事实」句没有任何引用 → fact_no_source block', () => {
    assert.equal(levelOf(check(S('市场情绪明显回暖。', 'fact', [])), 'fact_no_source'), 'block');
  });

  test('「事实」句只在 refs 中给出 E 编号也算有依据', () => {
    assert.deepEqual(check(S('新华传媒复牌后涨停。', 'fact', ['E1'])), []);
  });

  test('「推断」句缺少不确定措辞 → inference_no_hedge warn（不阻断）', () => {
    const flags = check(S('出版传媒是当日主线。', 'inference', ['E1']));
    assert.equal(levelOf(flags, 'inference_no_hedge'), 'warn');
    assert.equal(flags.filter((f) => f.level === 'block').length, 0);
  });

  test('「推断」句带「或」且有依据 → 无提示', () => {
    assert.deepEqual(check(S('出版传媒或为当日主线。', 'inference', ['E1'])), []);
  });

  test('「推断」句没有依据编号 → inference_no_basis block', () => {
    assert.equal(levelOf(check(S('出版传媒或为当日主线。', 'inference', [])), 'inference_no_basis'), 'block');
  });

  test('「事实」句夹带判断性措辞 → fact_has_inference warn；重复引用 → dup_ref warn', () => {
    assert.equal(levelOf(check(S('炸板{{F8}}，显示分歧加大。', 'fact', ['F8'])), 'fact_has_inference'), 'warn');
    assert.equal(levelOf(check(S('上证指数收于{{F1}}，即{{F1}}。', 'fact', ['F1'])), 'dup_ref'), 'warn');
  });

  test('已删除的句子不再校验', () => {
    assert.deepEqual(check(S('建议买入，稳赚3倍。', 'fact', [], { deleted: true })), []);
  });
});

describe('renderText / trimOverlap', () => {
  const D = '2026-10-16';

  test('「热股榜排名第{{F7}}」+ 渲染值「第1名」→「热股榜排名第1名」，不出现「第第」', () => {
    const out = renderText('新华传媒热股榜排名第{{F7}}。', sheet, D);
    assert.equal(out, '新华传媒热股榜排名第1名。');
    assert.ok(!out.includes('第第'));
  });

  test('{{DATE}} 渲染为中文日期，F 编号渲染为底稿原值', () => {
    assert.equal(renderText('{{DATE}}，上证指数收于{{F1}}，{{F2}}。', sheet, D), '10月16日，上证指数收于3716.28点，上涨0.24%。');
  });

  test('占位符前后重复的字词被去重（上涨上涨、板板）', () => {
    assert.equal(renderText('上证指数上涨{{F2}}。', sheet, D), '上证指数上涨0.24%。');
    assert.equal(renderText('新华传媒{{F5}}板，', sheet, D), '新华传媒11连板，');
  });

  test('E 编号占位符不渲染文字；不存在的编号显式标出', () => {
    assert.equal(renderText('复牌后涨停{{E1}}。', sheet, D), '复牌后涨停。');
    assert.match(renderText('收于{{F99}}。', sheet, D), /【无效引用F99】/);
  });

  test('trimOverlap 直接调用', () => {
    assert.equal(trimOverlap('热股榜排名第', '第1名', ''), '1名');
    assert.equal(trimOverlap('新华传媒', '11连板', '板，'), '11连');
    assert.equal(trimOverlap('收于', '3716.28点', '，'), '3716.28点');
    assert.equal(trimOverlap('', '近5根日K累计上涨61.1%', '。'), '近5根日K累计上涨61.1%');
  });
});

describe('computeGate / verifyDraft', () => {
  const draft = (...sentences) => ({ sections: [{ id: 'C1', heading: 'h', sentences: sentences.map((s, i) => ({ id: `S${i + 1}`, flags: [], refs: [], ...s })) }] });

  test('有未确认的 pending 句 → can_submit=false；确认后 → true', () => {
    const d = draft({ type: 'fact', text: '{{F1}}', refs: ['F1'] }, { type: 'pending', text: '跌停数据缺失。' });
    let g = computeGate(d);
    assert.equal(g.pending_unresolved, 1);
    assert.equal(g.can_submit, false);
    d.sections[0].sentences[1].pending_confirmed = true;
    g = computeGate(d);
    assert.equal(g.pending_unresolved, 0);
    assert.equal(g.can_submit, true);
  });

  test('存在 block 级 flag → can_submit=false；warn 与未忽略的 AI 提示只计入 warn', () => {
    const d = draft({ type: 'fact', text: '{{F1}}', refs: ['F1'], flags: [{ rule: 'untraced_number', level: 'block' }] });
    assert.equal(computeGate(d).can_submit, false);
    const d2 = draft({ type: 'fact', text: '{{F1}}', refs: ['F1'], flags: [{ rule: 'hype', level: 'warn' }], ai_flags: [{ category: '隐含预测', dismissed: false }, { category: '其他', dismissed: true }] });
    const g2 = computeGate(d2);
    assert.equal(g2.warn, 2);
    assert.equal(g2.block, 0);
    assert.equal(g2.can_submit, true);
  });

  test('已删除句不计入；空稿不可提交；sourced_ratio 按有引用的句子计算', () => {
    const d = draft({ type: 'fact', text: '{{F1}}', refs: ['F1'] }, { type: 'fact', text: '无引用', flags: [{ level: 'block' }], deleted: true }, { type: 'inference', text: '或为主线', refs: [] });
    const g = computeGate(d);
    assert.equal(g.sentences, 2);
    assert.equal(g.block, 0);
    assert.equal(g.sourced_ratio, 0.5);
    assert.equal(computeGate({ sections: [] }).can_submit, false);
  });

  test('verifyDraft 逐句写入 flags 并返回闸门', () => {
    const d = draft({ type: 'fact', text: '上证指数收于3716点。', refs: ['F1'] }, { type: 'fact', text: '{{DATE}}，上证指数收于{{F1}}。', refs: ['F1'] });
    const g = verifyDraft(d, sheet);
    assert.deepEqual(rulesOf(d.sections[0].sentences[0].flags), ['untraced_number']);
    assert.deepEqual(d.sections[0].sentences[1].flags, []);
    assert.equal(g.block, 1);
    assert.equal(g.can_submit, false);
  });
});
