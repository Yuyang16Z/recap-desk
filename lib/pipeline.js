import crypto from 'node:crypto';
import { resolveTradingDate, collectBase } from './collect.js';
import { publicCall } from './fuyao.js';
import { runAgent, writeDraft, normalizeDraft } from './agent.js';
import { verifyDraft, computeGate, coverage } from './verify.js';
import { repairDraft } from './repair.js';

// 大模型不可用时的降级稿：只用模板复述底稿事实，不做任何归因推断，并显式标注需人工补写
export function templateDraft(sheet, base) {
  const I = base.ids.index;
  const L = base.ids.limit;
  const B = base.ids.breadth;
  const s1 = [];
  const idx = Object.values(I).filter((x) => x.pct && x.close);
  if (idx.length) s1.push({ text: `{{DATE}}，${idx.slice(0, 3).map((x) => `${x.name}{{${x.pct}}}，收于{{${x.close}}}`).join('；')}。`, type: 'fact', refs: idx.slice(0, 3).flatMap((x) => [x.pct, x.close]) });
  if (idx.length > 3) s1.push({ text: `${idx.slice(3).map((x) => `${x.name}{{${x.pct}}}`).join('，')}。`, type: 'fact', refs: idx.slice(3).map((x) => x.pct) });
  if (base.ids.turnover) s1.push({ text: `沪深两市成交额{{${base.ids.turnover}}}，{{${base.ids.turnoverChg}}}。`, type: 'fact', refs: [base.ids.turnover, base.ids.turnoverChg] });
  if (B.up) s1.push({ text: `全市场上涨{{${B.up}}}，下跌{{${B.down}}}，平盘{{${B.flat}}}。`, type: 'fact', refs: [B.up, B.down, B.flat] });

  const s2 = [];
  if (L.up) s2.push({ text: `全市场涨停{{${L.up}}}，炸板{{${L.open}}}${L.sealRate ? `，封板率{{${L.sealRate}}}` : ''}${L.down ? `；跌停{{${L.down}}}` : ''}。`, type: 'fact', refs: [L.up, L.open, L.sealRate, L.down].filter(Boolean) });
  else if (L.upPool) s2.push({ text: `涨停池共{{${L.upPool}}}${L.down ? `，跌停{{${L.down}}}` : ''}。`, type: 'fact', refs: [L.upPool, L.down].filter(Boolean) });
  if (L.upChg) s2.push({ text: `涨停家数{{${L.upChg}}}${L.sealChg ? `，封板率{{${L.sealChg}}}` : ''}${base.ids.continued ? `；前一交易日涨停股中，当日继续涨停{{${base.ids.continued}}}` : ''}。`, type: 'fact', refs: [L.upChg, L.sealChg, base.ids.continued].filter(Boolean) });
  if (L.maxBoard) s2.push({ text: `连板高度最高为{{${L.maxBoard}}}${L.multi ? `，二板及以上连板股{{${L.multi}}}` : ''}${L.promo2 ? `，二板晋级率{{${L.promo2}}}` : ''}。`, type: 'fact', refs: [L.maxBoard, L.multi, L.promo2].filter(Boolean) });
  if (base.ids.leaders.length) s2.push({ text: `连板梯队中，${base.ids.leaders.slice(0, 4).map((l) => `${l.name}{{${l.fact}}}`).join('、')}。`, type: 'fact', refs: base.ids.leaders.slice(0, 4).map((l) => l.fact) });

  const s3 = [];
  const th = base.ids.themes.slice(0, 4);
  if (th.length) s3.push({ text: `按涨停原因标签统计，${th.map((t) => `「${t.tag}」相关涨停{{${t.fact}}}${t.prevFact ? `（{{${t.prevFact}}}）` : ''}`).join('，')}。`, type: 'fact', refs: th.flatMap((t) => [t.fact, t.prevFact].filter(Boolean)) });
  s3.push({ text: '主线归因需投资顾问结合公告与新闻人工补写（大模型撰写未执行，本稿不含推断）。', type: 'pending', refs: [] });

  const s4 = [];
  if (L.down || L.open) s4.push({ text: `风险事实：${L.down ? `当日跌停{{${L.down}}}` : ''}${L.down && L.open ? '，' : ''}${L.open ? `炸板{{${L.open}}}` : ''}。`, type: 'fact', refs: [L.down, L.open].filter(Boolean) });
  s4.push({ text: '风险提示需由投资顾问结合个股公告补充（大模型撰写未执行）。', type: 'pending', refs: [] });

  return normalizeDraft({
    title: '{{DATE}}盘后复盘（数据底稿版）',
    sections: [
      { heading: '一、指数与量能', sentences: s1 },
      { heading: '二、涨停结构与市场情绪', sentences: s2 },
      { heading: '三、主线题材与归因', sentences: s3 },
      { heading: '四、风险提示与待确认事项', sentences: s4 },
    ],
  }, 'template');
}

// 缺失与核验问题不依赖模型自觉写出：由系统追加锁定的待确认句（不可删改，只能核实后确认保留）
// 幂等：已存在的系统句不重复追加，因此也可用于补齐早期生成、缺少系统句的记录
export function addSystemPendings(draft, sheet) {
  const sec = draft.sections[draft.sections.length - 1];
  if (!sec) return 0;
  const existing = new Set(draft.sections.flatMap((s) => s.sentences).filter((s) => s.origin === 'system').map((s) => s.text));
  const items = [
    ...(sheet.gaps || []).map((g) => `「${g.title}」数据缺失或不可用（原因见数据质量面板），相关结论不予出具。`),
    ...(sheet.dq || []).filter((d) => d.level !== 'info').map((d) => `数据核验：${d.title}，涉及的数字请人工确认口径后再使用。`),
  ].filter((text) => !existing.has(text));
  for (const text of items) {
    sec.sentences.push({ id: nextSentenceId(draft), text, type: 'pending', refs: [], origin: 'system', locked: true });
  }
  return items.length;
}

// 模型有时仍会为缺失项自己写一句待确认，与系统追加的锁定句重复，投顾要多确认一次、定稿也会啰嗦。
// 按缺失／核验标题的字面重合度识别（标题 80% 以上的相邻字对出现在句中），软删除并注明原因，投顾可恢复。
// 只处理 AI 写的、没有引用数字事实的待确认句；带 {{F}} 的待确认句另有内容，不动。
const bigrams = (t) => {
  const s = String(t).replace(/[\s「」：:，,。、（）()]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
};
export function dedupePendings(draft, sheet) {
  const titles = [...(sheet.gaps || []).map((g) => g.title), ...(sheet.dq || []).filter((d) => d.level !== 'info').map((d) => d.title)];
  const grams = titles.map((t) => ({ t, g: bigrams(t) })).filter((x) => x.g.size >= 2);
  let n = 0;
  for (const sec of draft.sections) {
    for (const s of sec.sentences) {
      if (s.deleted || s.origin !== 'ai' || s.type !== 'pending') continue;
      if ((s.refs || []).some((r) => /^F\d+$/.test(r)) || /\{\{\s*F\d+/.test(s.text)) continue;
      const sg = bigrams(s.text);
      const hit = grams.find(({ g }) => [...g].filter((x) => sg.has(x)).length / g.size >= 0.8);
      if (hit) { s.deleted = true; s.dedup = hit.t; n++; }
    }
  }
  return n;
}

const blockCount = (draft) => draft.sections.flatMap((s) => s.sentences).filter((s) => !s.deleted).reduce((a, s) => a + (s.flags || []).filter((f) => f.level === 'block').length, 0);

export function nextSentenceId(draft) {
  const n = Math.max(0, ...draft.sections.flatMap((s) => s.sentences.map((x) => Number(x.id.slice(1)) || 0)));
  return `S${n + 1}`;
}

export async function runPipeline(input, emit, store, control = {}) {
  const t0 = Date.now();
  // 客户端断开后在阶段之间停止，避免继续消耗接口与大模型额度
  const checkAbort = () => { if (control.aborted) throw new Error('客户端已断开，生成已停止'); };
  const ctx = { calls: [], llm: [], simulate: input.simulate || [], emit, maxConcurrency: 6 };
  const run = { id: crypto.randomUUID().slice(0, 8), created_at: t0, status: 'generating', input, audit: [], feedback: [] };
  emit({ type: 'stage', stage: 'calendar', msg: '校验交易日（扶摇交易日历）' });
  const td = await resolveTradingDate(ctx, input.date);
  run.trading = td;
  emit({ type: 'stage', stage: 'collect', msg: `采集 ${td.date} 基础数据：指数日K、涨跌停与炸板池、涨停统计、连板天梯、热股榜、异动解读${td.snapshotIsDateClose ? '、全A快照' : ''}` });
  checkAbort();
  const { sheet, base } = await collectBase(ctx, td);
  checkAbort();
  emit({ type: 'facts', facts: sheet.facts.length, evidence: sheet.evidence.length, gaps: sheet.gaps, dq: sheet.dq });

  let agent = { used: false, steps: [] };
  emit({ type: 'stage', stage: 'agent', msg: 'Agent 判断主线，自主调用工具补充证据' });
  try {
    agent = { used: true, ...(await runAgent(ctx, sheet, base, emit)) };
  } catch (e) {
    agent = { used: false, error: e.message, steps: [] };
    emit({ type: 'warn', msg: `Agent 补充调查失败：${e.message}；改用基础数据继续` });
  }

  checkAbort();
  emit({ type: 'stage', stage: 'write', msg: '撰写复盘稿（正文数字只能引用底稿编号）' });
  let draft;
  let writer;
  const tw = Date.now();
  const team = store.config || { rules: [], preferences: [] };
  try {
    draft = await writeDraft(ctx, sheet, base, input.audience, agent, team);
    writer = { used: true, ms: Date.now() - tw };
  } catch (e) {
    draft = templateDraft(sheet, base);
    writer = { used: false, fallback: true, error: e.message };
    emit({ type: 'warn', msg: `大模型撰写失败：${e.message}；已降级为纯数据底稿（不含归因推断），请人工补写` });
  }
  const systemPendings = addSystemPendings(draft, sheet);
  const deduped = dedupePendings(draft, sheet);
  if (deduped) emit({ type: 'info', msg: `去重：${deduped} 句 AI 待确认句与系统追加的缺失说明重复，已自动删除（可恢复）` });
  if (ctx.simulate.includes('inject_violation')) {
    const sec = draft.sections[draft.sections.length - 1];
    sec.sentences.push({ id: nextSentenceId(draft), text: '情绪明显回暖，建议明日逢低布局高标股，后市有望继续上涨，参与者稳赚。', type: 'inference', refs: [], origin: 'injected' });
  }

  emit({ type: 'stage', stage: 'verify', msg: '校验：数字溯源、实体一致性、句子类型与依据、合规词表与团队规则' });
  verifyDraft(draft, sheet, team.rules);
  const countFlags = () => {
    const out = {};
    for (const sec of draft.sections) for (const s of sec.sentences) if (!s.deleted) for (const f of s.flags) out[f.rule] = (out[f.rule] || 0) + 1;
    return out;
  };
  const initialFlags = countFlags();
  const initialBlocks = blockCount(draft);
  // 校验器在环：AI 写的句子没通过校验时，带着错误原因交还模型重写一轮，修后必须重新通过校验
  let repair = { attempted: 0, fixed: 0, failed: 0, deleted: 0 };
  if (writer.used && !control.aborted) {
    try {
      repair = await repairDraft(ctx, sheet, draft, { emit, custom: team.rules });
    } catch (e) {
      repair = { ...repair, error: e.message };
      emit({ type: 'warn', msg: `自动修复出错（${e.message}），保留修复前的稿子交人工处理` });
    }
  }
  const gate = computeGate(draft);
  const finalFlags = countFlags();
  const finalBlocks = blockCount(draft);
  Object.assign(run, {
    status: 'draft', finished_at: Date.now(),
    facts: sheet.facts, evidence: sheet.evidence, gaps: sheet.gaps, dq: sheet.dq,
    entities: sheet.entities, system_pendings: systemPendings, deduped_pendings: deduped, initial_blocks: initialBlocks, final_blocks: finalBlocks,
    calls: ctx.calls.map(publicCall), agent, writer, draft, gate, initial_flags: initialFlags, final_flags: finalFlags, repair, llm: ctx.llm,
    team: { rules: team.rules.length, preferences: team.preferences.length },
  });
  run.coverage = coverage(draft, sheet);
  run.metrics = {
    gen_ms: run.finished_at - t0,
    tool_calls: ctx.calls.length,
    agent_tool_calls: ctx.calls.filter((c) => c.by === 'agent').length,
    tool_failures: ctx.calls.filter((c) => !c.ok).length,
    retries: ctx.calls.reduce((a, c) => a + Math.max(0, (c.attempts || 1) - 1), 0),
    llm_calls: ctx.llm.length,
    llm_ms: ctx.llm.reduce((a, x) => a + x.ms, 0),
    tokens: ctx.llm.reduce((a, x) => a + (x.usage?.total_tokens || 0), 0),
    facts: sheet.facts.length,
    evidence: sheet.evidence.length,
  };
  run.audit.push({ at: Date.now(), actor: 'AI', action: 'generate', detail: `生成草稿 ${gate.sentences} 句：阻断项 ${gate.block}、提醒 ${gate.warn}、待确认 ${gate.pending_unresolved}${writer.fallback ? '（大模型不可用，降级模板）' : ''}` });
  if (deduped) run.audit.push({ at: Date.now(), actor: '系统', action: 'dedupe', detail: `${deduped} 句 AI 待确认句与系统缺失说明重复，已自动删除（可恢复）` });
  if (repair.attempted) run.audit.push({ at: Date.now(), actor: 'AI', action: 'repair', detail: `自动修复 ${repair.attempted} 句：修好 ${repair.fixed}、删除 ${repair.deleted}、未修好 ${repair.failed}（未修好的保留原句交人工）` });
  store.save(run);
  return run;
}
