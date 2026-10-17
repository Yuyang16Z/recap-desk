import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadEnv } from './lib/env.js';
import { Store } from './lib/store.js';
import { runPipeline, nextSentenceId } from './lib/pipeline.js';
import { resolveTradingDate, UserError } from './lib/collect.js';
import { verifySentence, computeGate, renderText, entityNames } from './lib/verify.js';
import { aiComplianceReview } from './lib/agent.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(ROOT);

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(ROOT, 'public')));
const store = new Store(path.join(ROOT, 'data/runtime'), path.join(ROOT, 'data/samples'));

// 演示成本控制：单 IP 每小时 8 次生成、全局同时最多 2 个生成任务
const hits = new Map();
let active = 0;
const PER_IP = Number(process.env.RUNS_PER_IP_PER_HOUR || 8);
const MAX_ACTIVE = 2;
function allow(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= PER_IP) return false;
  arr.push(now);
  hits.set(ip, arr);
  return true;
}
const SIMULATIONS = ['fuyao:limit_up_pool', 'fuyao:index_kline', 'fuyao:limit_up_statistics', 'fuyao:anomaly_analysis', 'llm_down', 'stale_stats', 'inject_violation'];
const EDITABLE = new Set(['draft', 'returned']);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, fuyao: !!process.env.FUYAO_API_KEY, llm: !!process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', runs: store.runs.size });
});

app.get('/api/trading-date', async (req, res) => {
  try {
    const td = await resolveTradingDate({ calls: [], llm: [] });
    res.json({ ok: true, ...td });
  } catch (e) {
    res.status(502).json({ ok: false, error: `交易日历获取失败：${e.message}` });
  }
});

app.post('/api/runs', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (active >= MAX_ACTIVE) return res.status(429).json({ error: '当前有其他生成任务在进行，请稍后再试（可先查看左侧历史记录或样例）' });
  if (!allow(ip)) return res.status(429).json({ error: `为控制演示成本，每个 IP 每小时最多生成 ${PER_IP} 次；可先查看历史记录或样例` });
  const { date, audience = 'steady', simulate = [] } = req.body || {};
  const input = {
    date: date || null,
    audience: ['steady', 'short', 'inst'].includes(audience) ? audience : 'steady',
    simulate: (Array.isArray(simulate) ? simulate : []).filter((s) => SIMULATIONS.includes(s)),
  };
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const emit = (ev) => { try { res.write(`${JSON.stringify(ev)}\n`); } catch { /* 客户端已断开 */ } };
  active++;
  const keepAlive = setInterval(() => emit({ type: 'ping' }), 10000);
  try {
    const run = await runPipeline(input, emit, store);
    emit({ type: 'done', run });
  } catch (e) {
    const isUser = e instanceof UserError;
    if (!isUser) store.recordFailure({ input, error: e.message, code: e.code });
    emit({ type: 'error', msg: isUser ? e.message : `生成中止：${e.message}${e.code ? `（code=${e.code}）` : ''}。未产出任何结论。`, suggestion: e.extra?.suggestion });
  } finally {
    clearInterval(keepAlive);
    active--;
    res.end();
  }
});

app.get('/api/runs', (req, res) => res.json(store.list()));

function getRun(req, res) {
  const run = store.get(req.params.id);
  if (!run) res.status(404).json({ error: '记录不存在（免费实例重启后运行时记录会清空，样例记录除外）' });
  return run;
}
app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  // 可编辑的草稿按当前规则重算校验结果，避免规则升级后页面显示过期的门禁状态
  if (EDITABLE.has(run.status) && run.draft) {
    const names = entityNames(run);
    for (const sec of run.draft.sections) for (const s of sec.sentences) s.flags = verifySentence(s, run, names);
    run.gate = computeGate(run.draft);
  }
  res.json(run);
});

function findSentence(run, sid) {
  for (const sec of run.draft.sections) {
    const s = sec.sentences.find((x) => x.id === sid);
    if (s) return s;
  }
  return null;
}
function guardEditable(run, res) {
  if (EDITABLE.has(run.status)) return true;
  res.status(409).json({ error: `当前状态（${statusLabel(run.status)}）不可编辑；被合规退回后才能继续修改` });
  return false;
}
const statusLabel = (s) => ({ draft: '草稿', in_review: '待合规审核', approved: '已通过', returned: '已退回' }[s] || s);

app.patch('/api/runs/:id/sentences/:sid', (req, res) => {
  const run = getRun(req, res);
  if (!run || !guardEditable(run, res)) return;
  const s = findSentence(run, req.params.sid);
  if (!s) return res.status(404).json({ error: '句子不存在' });
  const { text, type, action, note, actor = '投顾' } = req.body || {};
  const before = s.text;
  if (action === 'delete') s.deleted = true;
  else if (action === 'restore') s.deleted = false;
  else if (action === 'confirm_pending') { s.pending_confirmed = true; s.note = String(note || '').slice(0, 200); }
  else if (action === 'dismiss_ai') (s.ai_flags || []).forEach((f) => { f.dismissed = true; });
  else {
    if (typeof text === 'string') {
      if (s.original_text === undefined) s.original_text = s.text;
      s.text = text.trim().slice(0, 500);
      s.edited = s.text !== s.original_text;
    }
    if (['fact', 'inference', 'pending'].includes(type) && type !== s.type) { s.type = type; s.pending_confirmed = false; }
    s.ai_flags = [];
  }
  s.flags = verifySentence(s, run, entityNames(run));
  run.gate = computeGate(run.draft);
  run.audit.push({ at: Date.now(), actor, action: action || 'edit', sid: s.id, detail: action ? `${s.id} ${action}${note ? `：${note}` : ''}` : `${s.id} 修改：「${before.slice(0, 30)}」→「${s.text.slice(0, 30)}」` });
  store.save(run);
  res.json(run);
});

app.post('/api/runs/:id/sentences', (req, res) => {
  const run = getRun(req, res);
  if (!run || !guardEditable(run, res)) return;
  const { section_id, text = '', type = 'fact', actor = '投顾' } = req.body || {};
  const sec = run.draft.sections.find((x) => x.id === section_id);
  if (!sec || !text.trim()) return res.status(400).json({ error: '需要指定章节和句子内容' });
  const s = { id: nextSentenceId(run.draft), text: text.trim().slice(0, 500), type: ['fact', 'inference', 'pending'].includes(type) ? type : 'fact', refs: [], origin: 'human' };
  s.flags = verifySentence(s, run, entityNames(run));
  sec.sentences.push(s);
  run.gate = computeGate(run.draft);
  run.audit.push({ at: Date.now(), actor, action: 'add', sid: s.id, detail: `${s.id} 新增：「${s.text.slice(0, 30)}」` });
  store.save(run);
  res.json(run);
});

app.post('/api/runs/:id/feedback', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  const { sid, rating, reason = '' } = req.body || {};
  if (!['up', 'down'].includes(rating)) return res.status(400).json({ error: 'rating 只能是 up / down' });
  run.feedback.push({ at: Date.now(), sid, rating, reason: String(reason).slice(0, 40) });
  run.audit.push({ at: Date.now(), actor: '投顾', action: 'feedback', sid, detail: `${sid} ${rating === 'up' ? '有用' : '无用'}${reason ? `：${reason}` : ''}` });
  store.save(run);
  res.json(run);
});

app.post('/api/runs/:id/ai-review', async (req, res) => {
  const run = getRun(req, res);
  if (!run || !guardEditable(run, res)) return;
  const ctx = { calls: [], llm: [], simulate: [] };
  const rendered = run.draft.sections.flatMap((sec) => sec.sentences.filter((s) => !s.deleted).map((s) => ({ sid: s.id, type: s.type, text: renderText(s.text, run, run.trading.date) })));
  try {
    const issues = await aiComplianceReview(ctx, rendered);
    for (const sec of run.draft.sections) {
      for (const s of sec.sentences) s.ai_flags = issues.filter((i) => i.sid === s.id).map((i) => ({ category: i.category, reason: i.reason, suggestion: i.suggestion, dismissed: false }));
    }
    run.ai_review = { at: Date.now(), issues: issues.length, ms: ctx.llm[0]?.ms };
    run.gate = computeGate(run.draft);
    run.audit.push({ at: Date.now(), actor: 'AI', action: 'ai_review', detail: `AI 合规复核：发现 ${issues.length} 处疑似问题（仅提示，由人决定是否修改）` });
    store.save(run);
    res.json(run);
  } catch (e) {
    res.status(502).json({ error: `AI 合规复核失败：${e.message}；关键词规则校验仍然有效` });
  }
});

app.post('/api/runs/:id/submit', (req, res) => {
  const run = getRun(req, res);
  if (!run || !guardEditable(run, res)) return;
  const names = entityNames(run);
  for (const sec of run.draft.sections) for (const s of sec.sentences) s.flags = verifySentence(s, run, names);
  run.gate = computeGate(run.draft);
  if (!run.gate.can_submit) {
    // 按最新规则重算的结果要落盘：规则升级后，存量草稿在提交时会暴露新的阻断项
    run.audit.push({ at: Date.now(), actor: '系统', action: 'submit_blocked', detail: `提交被门禁拒绝：阻断项 ${run.gate.block}、待确认 ${run.gate.pending_unresolved}` });
    store.save(run);
    return res.status(409).json({ error: `还有 ${run.gate.block} 个阻断项、${run.gate.pending_unresolved} 条待确认句未处理，不能提交合规审核` });
  }
  run.status = 'in_review';
  run.submitted_at = Date.now();
  run.submit_count = (run.submit_count || 0) + 1;
  run.audit.push({ at: Date.now(), actor: '投顾', action: 'submit', detail: `第 ${run.submit_count} 次提交合规审核` });
  store.save(run);
  res.json(run);
});

function buildFinal(run) {
  const date = run.trading.date;
  const out = [renderText(run.draft.title, run, date), ''];
  for (const sec of run.draft.sections) {
    const ss = sec.sentences.filter((s) => !s.deleted);
    if (!ss.length) continue;
    out.push(sec.heading, ss.map((s) => renderText(s.text, run, date)).join(''), '');
  }
  out.push(`数据来源：同花顺金融数据（扶摇 API），数据时点为 ${date} 收盘；各数字的字段与口径见事实底稿。`);
  out.push('风险提示：以上内容为盘后公开数据整理与分析，不构成任何投资建议或收益承诺。市场有风险，投资需谨慎。');
  return out.join('\n');
}

app.post('/api/runs/:id/review', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  if (run.status !== 'in_review') return res.status(409).json({ error: `只有「待合规审核」状态可以审核，当前为「${statusLabel(run.status)}」` });
  const { decision, comment = '' } = req.body || {};
  if (decision === 'approve') {
    run.status = 'approved';
    run.approved_at = Date.now();
    run.final_text = buildFinal(run);
  } else if (decision === 'return') {
    if (!String(comment).trim()) return res.status(400).json({ error: '退回需要填写审核意见' });
    run.status = 'returned';
    run.returns = (run.returns || 0) + 1;
  } else {
    return res.status(400).json({ error: 'decision 只能是 approve / return' });
  }
  run.review = { decision, comment: String(comment).slice(0, 300), at: Date.now() };
  run.audit.push({ at: Date.now(), actor: '合规', action: decision, detail: decision === 'approve' ? '审核通过，生成定稿' : `退回：${comment}` });
  store.save(run);
  res.json(run);
});

app.get('/api/runs/:id/export', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  const text = run.final_text || `【未审核草稿，不可对外发布】\n${buildFinal(run)}`;
  res.type('text/plain; charset=utf-8').send(text);
});

app.get('/api/metrics', (req, res) => {
  const runs = [...store.runs.values()].filter((r) => r.draft);
  const n = runs.length || 1;
  const avg = (f) => +(runs.reduce((a, r) => a + (f(r) || 0), 0) / n).toFixed(2);
  const reviewed = runs.filter((r) => r.submit_count);
  const approved = runs.filter((r) => r.status === 'approved');
  let aiSentences = 0; let edited = 0; let deleted = 0; let added = 0;
  for (const r of reviewed) {
    for (const sec of r.draft.sections) {
      for (const s of sec.sentences) {
        if (s.origin === 'human') { added++; continue; }
        aiSentences++;
        if (s.deleted) deleted++;
        else if (s.edited) edited++;
      }
    }
  }
  const flags = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.initial_flags || {})) flags[k] = (flags[k] || 0) + v;
  const fb = runs.flatMap((r) => r.feedback || []);
  const reasons = {};
  fb.filter((f) => f.rating === 'down').forEach((f) => { reasons[f.reason || '未填写'] = (reasons[f.reason || '未填写'] || 0) + 1; });
  const calls = runs.reduce((a, r) => a + (r.metrics?.tool_calls || 0), 0);
  const failed = runs.reduce((a, r) => a + (r.metrics?.tool_failures || 0), 0);
  res.json({
    runs: runs.length,
    samples: runs.filter((r) => r.is_sample).length,
    aborted: store.failures.length,
    avg_gen_seconds: +(avg((r) => r.metrics?.gen_ms) / 1000).toFixed(1),
    avg_tool_calls: avg((r) => r.metrics?.tool_calls),
    avg_agent_tool_calls: avg((r) => r.metrics?.agent_tool_calls),
    tool_failure_rate: calls ? +(failed / calls).toFixed(3) : 0,
    llm_fallback_runs: runs.filter((r) => r.writer?.fallback).length,
    avg_facts: avg((r) => r.metrics?.facts),
    avg_sourced_ratio: avg((r) => r.gate?.sourced_ratio),
    initial_flags: flags,
    submitted: reviewed.length,
    approved: approved.length,
    first_pass_approval: approved.length ? +(approved.filter((r) => !r.returns).length / approved.length).toFixed(2) : null,
    ai_sentences_in_submitted: aiSentences,
    edit_rate: aiSentences ? +(edited / aiSentences).toFixed(3) : null,
    delete_rate: aiSentences ? +(deleted / aiSentences).toFixed(3) : null,
    human_added: added,
    feedback_up: fb.filter((f) => f.rating === 'up').length,
    feedback_down: fb.filter((f) => f.rating === 'down').length,
    feedback_down_reasons: reasons,
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`复盘稿工作台已启动：http://localhost:${port}`));
