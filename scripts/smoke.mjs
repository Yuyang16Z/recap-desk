// 冒烟脚本：不启动 HTTP 服务，直接跑一次完整生成并打印摘要（用于本地联调与测试记录）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.js';
import { runPipeline } from '../lib/pipeline.js';
import { renderText } from '../lib/verify.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const input = { date: args.date || null, audience: args.audience || 'steady', simulate: args.simulate ? args.simulate.split(',') : [] };
const fs0 = await import('node:fs');
let config = { rules: [], preferences: [] };
try { config = JSON.parse(fs0.readFileSync(path.join(ROOT, 'data/config.default.json'), 'utf8')); } catch { /* 无默认配置 */ }
const store = { save() {}, config };
const t0 = Date.now();
try {
  const run = await runPipeline(input, (ev) => {
    if (ev.type === 'stage' || ev.type === 'warn') console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${ev.type}: ${ev.msg}`);
    if (ev.type === 'agent_step') console.log(`  agent round ${ev.step.round}: ${ev.step.tool_calls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join('; ')} ${ev.step.thought ? '| ' + ev.step.thought.slice(0, 160) : ''}`);
  }, store);
  console.log('\nmetrics', JSON.stringify(run.metrics), '\ngate', JSON.stringify(run.gate), '\nrepair', JSON.stringify(run.repair), '\ninitial_flags', JSON.stringify(run.initial_flags), '\nfinal_flags', JSON.stringify(run.final_flags), '\ngaps', JSON.stringify(run.gaps), '\ndq', JSON.stringify(run.dq));
  for (const h of run.agent?.hypotheses || []) console.log(`  ${h.id}[${h.verdict}] ${h.claim} | 支持 ${h.support.join(',')} | 反证 ${h.against.join(',') || '-'} | 待补 ${h.gap || '-'}${h.problems.length ? ' | 问题 ' + h.problems.join(';') : ''}`);
  console.log('\n' + renderText(run.draft.title, run, run.trading.date));
  for (const sec of run.draft.sections) {
    console.log(`\n${sec.heading}`);
    for (const s of sec.sentences) console.log(`  ${s.id}[${s.type}]${s.deleted ? '[已删]' : ''}${s.repair ? `[修复:${s.repair.status}]` : ''} ${renderText(s.text, run, run.trading.date)}  refs=${s.refs.join(',')}${s.flags.length ? '  FLAGS=' + s.flags.map((f) => f.level + ':' + f.msg).join(' / ') : ''}${s.repair ? `\n      修复前：${renderText(s.repair.before.text, run, run.trading.date)}｜问题：${s.repair.before.problems.join('；')}` : ''}`);
  }
  if (args.out) { const fs = await import('node:fs'); fs.writeFileSync(args.out, JSON.stringify(run)); console.log('\nsaved', args.out); }
} catch (e) {
  console.log('ERROR', e.constructor.name, e.message, JSON.stringify(e.extra || {}));
}
