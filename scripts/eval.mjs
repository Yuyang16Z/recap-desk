// 多日评测：对最近 N 个已收盘交易日各跑一次完整生成（真实接口 + 大模型），
// 再用"大模型不可用"的模板稿作对照，统计护栏是否生效、AI 相对模板的增量，输出 JSON 与 Markdown 报告。
// 用法：node scripts/eval.mjs --days=8 --audience=steady
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.js';
import { runPipeline } from '../lib/pipeline.js';
import { resolveTradingDate } from '../lib/collect.js';
import { fuyaoGet } from '../lib/fuyao.js';
import { dash } from '../lib/dates.js';
import { CHECKLIST, coverage } from '../lib/verify.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const DAYS = Number(args.days || 8);
const AUDIENCE = args.audience || 'steady';
let config = { rules: [], preferences: [] };
try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/config.default.json'), 'utf8')); } catch { /* 无默认配置 */ }
const store = { save() {}, config };

const REPAIRABLE = ['untraced_number', 'entity_mismatch', 'unit_mismatch', 'unknown_ref', 'fact_no_source', 'inference_no_basis', 'predict', 'advice', 'promise', 'custom'];
const sum = (o, keys) => keys.reduce((a, k) => a + (o?.[k] || 0), 0);
const live = (run) => run.draft.sections.flatMap((s) => s.sentences).filter((s) => !s.deleted);

const coverageOf = (run) => coverage(run.draft, run);

function summarize(run) {
  const ss = live(run);
  const types = { fact: 0, inference: 0, pending: 0 };
  ss.forEach((s) => { types[s.type] = (types[s.type] || 0) + 1; });
  const evidencedInference = ss.filter((s) => s.type === 'inference' && (s.refs || []).some((r) => r.startsWith('E'))).length;
  const hs = run.agent?.hypotheses || [];
  return {
    date: run.trading.date,
    degraded: !!run.writer?.fallback,
    gen_s: +(run.metrics.gen_ms / 1000).toFixed(1),
    tool_calls: run.metrics.tool_calls,
    agent_tool_calls: run.metrics.agent_tool_calls,
    tool_failures: run.metrics.tool_failures,
    llm_calls: run.metrics.llm_calls,
    tokens: run.metrics.tokens,
    facts: run.metrics.facts,
    evidence: run.metrics.evidence,
    gaps: run.gaps.length,
    dq: run.dq.filter((d) => d.level !== 'info').length,
    sentences: ss.length,
    types,
    evidenced_inference: evidencedInference,
    sourced_ratio: run.gate.sourced_ratio,
    blocks_before: sum(run.initial_flags, REPAIRABLE),
    flags_before: run.initial_flags,
    repair: run.repair,
    blocks_after: run.gate.block,
    warns_after: run.gate.warn,
    pending: run.gate.pending_unresolved,
    coverage: coverageOf(run),
    hypotheses: hs.length,
    verdicts: hs.reduce((a, h) => ({ ...a, [h.verdict]: (a[h.verdict] || 0) + 1 }), {}),
    hypothesis_problems: hs.filter((h) => h.problems?.length).length,
    title: run.draft.title,
  };
}

const ctx = { calls: [], llm: [] };
const td = await resolveTradingDate(ctx, null);
const cal = await fuyaoGet(ctx, 'trading_calendar', 'A股交易日历', '/api/a-share/calendar/trading-days');
const dates = (cal.data?.item || []).map((x) => dash(x.date)).filter((d) => d <= td.latestClosed).sort().slice(-DAYS).reverse();
console.log(`评测日期（${dates.length} 个交易日）：${dates.join('、')}`);

const results = [];
for (const date of dates) {
  const row = { date };
  for (const [key, simulate] of [['ai', []], ['template', ['llm_down']]]) {
    const t0 = Date.now();
    try {
      const run = await runPipeline({ date, audience: AUDIENCE, simulate }, () => {}, store);
      row[key] = summarize(run);
      console.log(`${date} ${key}: ${((Date.now() - t0) / 1000).toFixed(1)}s 句子${row[key].sentences} 阻断前${row[key].blocks_before}→后${row[key].blocks_after} 覆盖${row[key].coverage.ratio} 带证据归因${row[key].evidenced_inference}`);
    } catch (e) {
      row[key] = { error: e.message };
      console.log(`${date} ${key}: 失败 ${e.message}`);
    }
  }
  results.push(row);
}

const ok = results.filter((r) => r.ai && !r.ai.error);
const okT = results.filter((r) => r.template && !r.template.error);
const avg = (arr, f) => (arr.length ? +(arr.reduce((a, r) => a + (f(r) || 0), 0) / arr.length).toFixed(2) : null);
const totalRepair = (k) => ok.reduce((a, r) => a + (r.ai.repair?.[k] || 0), 0);
const flagTotals = {};
ok.forEach((r) => Object.entries(r.ai.flags_before || {}).forEach(([k, v]) => { flagTotals[k] = (flagTotals[k] || 0) + v; }));
const verdictTotals = {};
ok.forEach((r) => Object.entries(r.ai.verdicts || {}).forEach(([k, v]) => { verdictTotals[k] = (verdictTotals[k] || 0) + v; }));
const aggregate = {
  runs: results.length,
  ai_success: ok.filter((r) => !r.ai.degraded).length,
  avg_gen_s: avg(ok, (r) => r.ai.gen_s),
  max_gen_s: ok.length ? Math.max(...ok.map((r) => r.ai.gen_s)) : null,
  avg_tool_calls: avg(ok, (r) => r.ai.tool_calls),
  avg_agent_tool_calls: avg(ok, (r) => r.ai.agent_tool_calls),
  tool_failures: ok.reduce((a, r) => a + r.ai.tool_failures, 0),
  avg_tokens: avg(ok, (r) => r.ai.tokens),
  blocks_before: ok.reduce((a, r) => a + r.ai.blocks_before, 0),
  blocks_after: ok.reduce((a, r) => a + r.ai.blocks_after, 0),
  repair: { attempted: totalRepair('attempted'), fixed: totalRepair('fixed'), deleted: totalRepair('deleted'), failed: totalRepair('failed') },
  flags_before: flagTotals,
  drafts_with_zero_blocks_after: ok.filter((r) => r.ai.blocks_after === 0).length,
  avg_pending: avg(ok, (r) => r.ai.pending),
  avg_sourced_ratio: avg(ok, (r) => r.ai.sourced_ratio),
  ai_coverage: avg(ok, (r) => r.ai.coverage.ratio),
  template_coverage: avg(okT, (r) => r.template.coverage.ratio),
  ai_evidenced_inference: avg(ok, (r) => r.ai.evidenced_inference),
  template_evidenced_inference: avg(okT, (r) => r.template.evidenced_inference),
  ai_sentences: avg(ok, (r) => r.ai.sentences),
  template_sentences: avg(okT, (r) => r.template.sentences),
  hypotheses: avg(ok, (r) => r.ai.hypotheses),
  verdicts: verdictTotals,
  hypothesis_problems: ok.reduce((a, r) => a + r.ai.hypothesis_problems, 0),
};
const out = { generated_at: new Date().toISOString(), audience: AUDIENCE, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', checklist: CHECKLIST.map(([n]) => n), dates, aggregate, results };
fs.mkdirSync(path.join(ROOT, 'data/eval'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/eval/latest.json'), JSON.stringify(out, null, 2));
console.log('\n汇总', JSON.stringify(aggregate, null, 2));
console.log('已写入 data/eval/latest.json');

// ---------- Markdown 报告 ----------
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const fl = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('，') || '无';
const md = `# 多日评测报告

> 由 \`node scripts/eval.mjs --days=${DAYS} --audience=${AUDIENCE}\` 自动生成于 ${out.generated_at}（UTC）；原始数据见 \`data/eval/latest.json\`，在线页面右上角「评测报告」展示同一份结果。

## 方法
- 样本：最近 ${dates.length} 个已收盘交易日（${dates[dates.length - 1]} 至 ${dates[0]}），每天用真实扶摇 / iFinD 接口和 ${out.model} 完整生成一次，受众为「${AUDIENCE}」，团队规则用仓库默认配置。
- 对照组：同一交易日以“大模型不可用”（\`llm_down\`）方式生成的模板稿，只复述数据、不做推断。
- 关键事实清单：${out.checklist.join('、')}。正文引用了对应事实即算覆盖；当天没有该数据时不计入分母。
- “阻断项”只统计会阻止提交的规则（未溯源数字、张冠李戴、搭配错误、无依据、预测、荐股、收益承诺、团队规则），提醒类不计。
- 局限：只有 ${dates.length} 个交易日、单一受众、单次运行，大模型输出有随机性；不评估文字质量的主观好坏，也不能替代第 7 节的真人对照实验。

## 汇总
| 指标 | 结果 |
|---|---|
| AI 生成成功（未降级） | ${aggregate.ai_success}/${aggregate.runs} |
| 平均 / 最长生成用时 | ${aggregate.avg_gen_s}s / ${aggregate.max_gen_s}s |
| 平均接口调用（其中 Agent 自主） | ${aggregate.avg_tool_calls}（${aggregate.avg_agent_tool_calls}） |
| 接口失败次数 | ${aggregate.tool_failures} |
| 平均 token | ${aggregate.avg_tokens} |
| 生成时拦截（修复前，含提醒类） | ${fl(aggregate.flags_before)} |
| 阻断项：自修复前 → 后 | ${aggregate.blocks_before} → ${aggregate.blocks_after} |
| 自修复：尝试 / 修好 / 删除 / 未修好 | ${aggregate.repair.attempted} / ${aggregate.repair.fixed} / ${aggregate.repair.deleted} / ${aggregate.repair.failed} |
| 修复后零阻断的草稿 | ${aggregate.drafts_with_zero_blocks_after}/${aggregate.runs} |
| 平均待确认句 | ${aggregate.avg_pending} |
| 句子有依据比例 | ${pct(aggregate.avg_sourced_ratio)} |
| 关键事实覆盖率：AI / 模板 | ${pct(aggregate.ai_coverage)} / ${pct(aggregate.template_coverage)} |
| 带证据的归因句（每篇）：AI / 模板 | ${aggregate.ai_evidenced_inference} / ${aggregate.template_evidenced_inference} |
| 句数（每篇）：AI / 模板 | ${aggregate.ai_sentences} / ${aggregate.template_sentences} |
| 主线判断（每篇）与结论分布 | ${aggregate.hypotheses} 条；${Object.entries(aggregate.verdicts).map(([k, v]) => `${k} ${v}`).join('、')}；有问题的判断 ${aggregate.hypothesis_problems} 条 |

## 逐日明细
| 交易日 | 用时 | 调用（Agent） | 拦截（修复前） | 阻断 前→后 | 自修复 修好/尝试 | 待确认 | 覆盖率 AI/模板 | 带证据归因 AI/模板 | 缺失项 |
|---|---|---|---|---|---|---|---|---|---|
${results.map((r) => {
    if (!r.ai || r.ai.error) return `| ${r.date} | 失败：${r.ai?.error || ''} |||||||||`;
    const a = r.ai;
    const t = r.template && !r.template.error ? r.template : null;
    return `| ${r.date} | ${a.gen_s}s | ${a.tool_calls}（${a.agent_tool_calls}） | ${fl(a.flags_before)} | ${a.blocks_before}→${a.blocks_after} | ${a.repair?.fixed || 0}/${a.repair?.attempted || 0} | ${a.pending} | ${pct(a.coverage.ratio)}/${t ? pct(t.coverage.ratio) : '—'} | ${a.evidenced_inference}/${t ? t.evidenced_inference : '—'} | ${a.gaps} |`;
  }).join('\n')}

历史交易日没有收盘口径的全市场涨跌家数（快照接口只提供最新行情），因此缺失项至少为 1，相关句子写成待确认句。
`;
fs.writeFileSync(path.join(ROOT, 'docs/EVAL.md'), md);
console.log('已写入 docs/EVAL.md');
