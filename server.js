import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadEnv } from './lib/env.js';
import { Store } from './lib/store.js';
import { runPipeline, nextSentenceId, addSystemPendings } from './lib/pipeline.js';
import { resolveTradingDate, UserError } from './lib/collect.js';
import { verifySentence, computeGate, renderText, entityNames, coverage } from './lib/verify.js';
import { aiComplianceReview } from './lib/agent.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(ROOT);

const app = express();
// Render 前面有一层反向代理：只信任最近一跳，req.ip 取代理补上的真实客户端地址，伪造的 X-Forwarded-For 前缀无效
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(ROOT, 'public')));
const DEFAULT_CONFIG = path.join(ROOT, 'data/config.default.json');
const store = new Store(path.join(ROOT, 'data/runtime'), path.join(ROOT, 'data/samples'));

// ---------- 限流：生成、写入、复制、规则库分别计数，定期清理过期记录 ----------
function makeLimiter(limit, windowMs) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }, 10 * 60e3);
  timer.unref?.();
  return {
    take(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= limit) return false;
      arr.push(now);
      hits.set(key, arr);
      return true;
    },
    refund(key) { hits.get(key)?.pop(); },
  };
}
const PER_IP = Number(process.env.RUNS_PER_IP_PER_HOUR || 8);
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_RUNS || 3);
const runLimiter = makeLimiter(PER_IP, 3600e3);
const writeLimiter = makeLimiter(240, 10 * 60e3);
const cloneLimiter = makeLimiter(20, 3600e3);
const configLimiter = makeLimiter(30, 3600e3);
const reviewLimiter = makeLimiter(20, 3600e3);
let active = 0;
const ipOf = (req) => req.ip || req.socket.remoteAddress || 'unknown';
function limited(limiter, msg) {
  return (req, res, next) => (limiter.take(ipOf(req)) ? next() : res.status(429).json({ error: msg }));
}
const writeGuard = limited(writeLimiter, '操作过于频繁，请稍后再试');

const SIMULATIONS = ['fuyao:limit_up_pool', 'fuyao:index_kline', 'fuyao:limit_up_statistics', 'fuyao:anomaly_analysis', 'llm_down', 'stale_stats', 'inject_violation'];
const EDITABLE = new Set(['draft', 'returned']);
const REVERIFY = new Set(['draft', 'returned', 'in_review']);
const rules = () => store.config?.rules || [];
const actorOf = (a) => (a === '合规' ? '合规' : '投顾');
const statusLabel = (s) => ({ draft: '草稿', in_review: '待合规审核', approved: '已通过', returned: '已退回' }[s] || s);
const ID_REF = /\{\{\s*([FE]\d+)\s*\}\}/g;

function logAudit(run, actor, action, detail, sid) {
  run.audit.push({ at: Date.now(), actor, action, ...(sid ? { sid } : {}), detail: String(detail || '').slice(0, 200) });
}
function reverify(run) {
  addSystemPendings(run.draft, run); // 缺失与核验问题必须有对应的待确认句（早期记录在此补齐）
  const names = entityNames(run);
  for (const sec of run.draft.sections) for (const s of sec.sentences) s.flags = verifySentence(s, run, names, rules());
  run.gate = computeGate(run.draft);
  run.coverage = coverage(run.draft, run);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, fuyao: !!process.env.FUYAO_API_KEY, llm: !!process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', runs: store.runs.size });
});

// 每次打开页面都会请求交易日：缓存 60 秒，避免频繁刷新消耗扶摇额度
let tdCache = { at: 0, td: null };
app.get('/api/trading-date', async (req, res) => {
  try {
    if (!tdCache.td || Date.now() - tdCache.at > 60e3) tdCache = { at: Date.now(), td: await resolveTradingDate({ calls: [], llm: [] }) };
    res.json({ ok: true, ...tdCache.td });
  } catch (e) {
    res.status(502).json({ ok: false, error: `交易日历获取失败：${e.message}` });
  }
});

app.post('/api/runs', async (req, res) => {
  const ip = ipOf(req);
  if (active >= MAX_ACTIVE) return res.status(429).json({ error: '当前有其他生成任务在进行，请稍后再试（可先查看左侧历史记录或样例）' });
  if (!runLimiter.take(ip)) return res.status(429).json({ error: `为控制演示成本，每个 IP 每小时最多生成 ${PER_IP} 次；可先查看历史记录或样例` });
  const { date, audience = 'steady', simulate = [] } = req.body || {};
  const input = {
    date: typeof date === 'string' && date ? date.slice(0, 10) : null,
    audience: ['steady', 'short', 'inst'].includes(audience) ? audience : 'steady',
    simulate: (Array.isArray(simulate) ? simulate : []).filter((s) => SIMULATIONS.includes(s)),
  };
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const emit = (ev) => { try { res.write(`${JSON.stringify(ev)}\n`); } catch { /* 客户端已断开 */ } };
  // 客户端断开后通知流水线在下一个阶段停下，不再继续消耗接口与大模型额度
  const control = { aborted: false };
  res.on('close', () => { if (!res.writableEnded) control.aborted = true; });
  active++;
  const keepAlive = setInterval(() => emit({ type: 'ping' }), 10000);
  try {
    const run = await runPipeline(input, emit, store, control);
    emit({ type: 'done', run });
  } catch (e) {
    const isUser = e instanceof UserError;
    if (isUser) runLimiter.refund(ip); // 日期不合法等用户输入问题不占用生成额度
    else store.recordFailure({ input, error: e.message, code: e.code });
    emit({ type: 'error', msg: isUser ? e.message : `生成中止：${e.message}${e.code ? `（code=${e.code}）` : ''}。未产出任何结论。`, suggestion: e.extra?.suggestion });
  } finally {
    clearInterval(keepAlive);
    active--;
    res.end();
  }
});

app.get('/api/runs', (req, res) => res.json(store.list()));

// ---------- 团队规则库与写作偏好：反馈闭环 ----------
// 合规新增的禁用表述立即参与所有草稿校验（读取草稿时按最新规则重算），并写入之后每次生成的撰写提示词
const MAX_RULES = 30;
const MAX_PREFS = 15;
app.get('/api/config', (req, res) => res.json(store.config));
app.post('/api/config/rules', limited(configLimiter, '规则库修改过于频繁，请稍后再试'), (req, res) => {
  const { phrase = '', level = 'block', reason = '', actor } = req.body || {};
  if (actor !== '合规') return res.status(403).json({ error: '只有合规审核角色可以新增团队规则' });
  const p = String(phrase).trim();
  if (p.length < 2 || p.length > 30 || !/[一-龥A-Za-z]/.test(p)) return res.status(400).json({ error: '禁用表述需为 2–30 个字，且包含文字（避免单字或纯符号误伤所有草稿）' });
  if (store.config.rules.some((r) => r.phrase === p)) return res.status(409).json({ error: `「${p}」已在规则库中` });
  if (store.config.rules.length >= MAX_RULES) return res.status(409).json({ error: `规则库最多 ${MAX_RULES} 条，请先清理不再需要的规则` });
  store.config.rules.push({ id: `R${crypto.randomUUID().slice(0, 8)}`, phrase: p, level: level === 'warn' ? 'warn' : 'block', reason: String(reason).slice(0, 80), created_by: '合规', created_at: Date.now() });
  store.saveConfig();
  res.json(store.config);
});
app.delete('/api/config/rules/:id', limited(configLimiter, '规则库修改过于频繁，请稍后再试'), (req, res) => {
  if (req.query.actor !== '合规') return res.status(403).json({ error: '只有合规审核角色可以删除团队规则' });
  store.config.rules = store.config.rules.filter((r) => r.id !== req.params.id);
  store.saveConfig();
  res.json(store.config);
});
app.post('/api/config/preferences', limited(configLimiter, '写作偏好修改过于频繁，请稍后再试'), (req, res) => {
  const { text = '', actor } = req.body || {};
  const t = String(text).trim();
  if (t.length < 2 || t.length > 80) return res.status(400).json({ error: '写作偏好需为 2–80 个字' });
  if (store.config.preferences.length >= MAX_PREFS) return res.status(409).json({ error: `写作偏好最多 ${MAX_PREFS} 条（会写进每次生成的提示词），请先清理` });
  store.config.preferences.push({ id: `P${crypto.randomUUID().slice(0, 8)}`, text: t, created_by: actorOf(actor), created_at: Date.now() });
  store.saveConfig();
  res.json(store.config);
});
app.delete('/api/config/preferences/:id', limited(configLimiter, '写作偏好修改过于频繁，请稍后再试'), (req, res) => {
  store.config.preferences = store.config.preferences.filter((p) => p.id !== req.params.id);
  store.saveConfig();
  res.json(store.config);
});
app.post('/api/config/reset', limited(configLimiter, '规则库修改过于频繁，请稍后再试'), (req, res) => {
  if (req.body?.actor !== '合规') return res.status(403).json({ error: '只有合规审核角色可以恢复默认规则' });
  try { store.config = JSON.parse(fs.readFileSync(DEFAULT_CONFIG, 'utf8')); } catch { store.config = { rules: [], preferences: [] }; }
  store.saveConfig();
  res.json(store.config);
});

function getRun(req, res) {
  const run = store.get(req.params.id);
  if (!run) res.status(404).json({ error: '记录不存在（免费实例重启后运行时记录会清空，样例记录除外）' });
  return run;
}
app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  // 未定稿的记录按当前规则重算校验结果，避免规则更新后页面（包括合规审核视图）显示过期的门禁状态
  if (REVERIFY.has(run.status) && run.draft) reverify(run);
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
  if (run.is_sample) {
    res.status(409).json({ error: '这是所有人共享的样例，为只读；请先点「复制一份自己用」再修改' });
    return false;
  }
  if (run.ai_review_running) {
    res.status(409).json({ error: 'AI 合规复核进行中，请稍候再操作' });
    return false;
  }
  if (EDITABLE.has(run.status)) return true;
  res.status(409).json({ error: `当前状态（${statusLabel(run.status)}）不可编辑；被合规退回后才能继续修改` });
  return false;
}

app.patch('/api/runs/:id/sentences/:sid', writeGuard, (req, res) => {
  const run = getRun(req, res);
  if (!run || !guardEditable(run, res)) return;
  const s = findSentence(run, req.params.sid);
  if (!s) return res.status(404).json({ error: '句子不存在' });
  const { text, type, action, note } = req.body || {};
  const actor = actorOf(req.body?.actor);
  if (action !== undefined && !['delete', 'restore', 'confirm_pending', 'dismiss_ai'].includes(action)) return res.status(400).json({ error: `不支持的操作：${String(action).slice(0, 20)}` });
  if (text !== undefined && typeof text !== 'string') return res.status(400).json({ error: 'text 必须是字符串' });
  // 系统追加的缺失说明不可删改，只能核实后确认保留：保证"缺失数据不写成正常结论"不依赖人或模型自觉
  if (s.locked && (action === 'delete' || (!action && (text !== undefined || type !== undefined)))) {
    return res.status(409).json({ error: '这是系统根据数据缺失自动生成的说明，不能删除或改写；核实后可以「确认保留」' });
  }
  const before = s.text;
  if (action === 'delete') s.deleted = true;
  else if (action === 'restore') s.deleted = false;
  else if (action === 'confirm_pending') { s.pending_confirmed = true; s.note = String(note || '').slice(0, 200); }
  else if (action === 'dismiss_ai') (s.ai_flags || []).forEach((f) => { f.dismissed = true; });
  else {
    if (typeof text === 'string') {
      const next = text.trim().slice(0, 500);
      if (next !== s.text) {
        if (s.original_text === undefined) s.original_text = s.text;
        s.text = next;
        s.edited = s.text !== s.original_text;
        s.pending_confirmed = false; // 内容变了，之前的确认不再有效
        // 依据编号按新文字重算：数字事实以正文里的 {{F}} 为准，文本证据保留原有引用
        const placeholders = [...next.matchAll(ID_REF)].map((m) => m[1]);
        s.refs = [...new Set([...placeholders, ...(s.refs || []).filter((r) => /^E\d+$/.test(r))])];
      }
    }
    if (['fact', 'inference', 'pending'].includes(type) && type !== s.type) { s.type = type; s.pending_confirmed = false; }
    s.ai_flags = [];
  }
  s.flags = verifySentence(s, run, entityNames(run), rules());
  run.gate = computeGate(run.draft);
  run.coverage = coverage(run.draft, run);
  logAudit(run, actor, action || 'edit', action ? `${s.id} ${action}${note ? `：${String(note).slice(0, 100)}` : ''}` : `${s.id} 修改：「${before.slice(0, 30)}」→「${s.text.slice(0, 30)}」`, s.id);
  store.save(run);
  res.json(run);
});

// 共享样例只读：复制一份独立草稿供评审体验修改与审批，不重新调用任何接口
app.post('/api/runs/:id/clone', limited(cloneLimiter, '复制过于频繁，每个 IP 每小时最多复制 20 次'), (req, res) => {
  const src = getRun(req, res);
  if (!src) return;
  const run = JSON.parse(JSON.stringify(src));
  run.id = crypto.randomUUID().slice(0, 8);
  run.created_at = Date.now();
  run.is_sample = false;
  run.cloned_from = src.id;
  run.status = 'draft';
  for (const k of ['review', 'final_text', 'submitted_at', 'approved_at', 'submit_count', 'returns', 'ai_review_running']) delete run[k];
  run.feedback = [];
  run.audit = (src.audit || []).filter((a) => ['generate', 'repair'].includes(a.action));
  logAudit(run, '系统', 'clone', `从样例 ${src.id} 复制，数据与校验结果保持一致，未重新调用接口`);
  reverify(run);
  store.save(run);
  res.json(run);
});

// 编辑时的实时校验：只计算，不保存，供前端边写边看问题
app.post('/api/runs/:id/preview', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  const { text = '', type = 'fact' } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text 必须是字符串' });
  const t = text.slice(0, 500);
  const s = { text: t, type: ['fact', 'inference', 'pending'].includes(type) ? type : 'fact', refs: [...t.matchAll(ID_REF)].map((m) => m[1]) };
  res.json({ flags: verifySentence(s, run, entityNames(run), rules()), rendered: renderText(s.text, run, run.trading.date) });
});

app.post('/api/runs/:id/sentences', writeGuard, (req, res) => {
  const run = getRun(req, res);
  if (!run || !guardEditable(run, res)) return;
  const { section_id, text = '', type = 'fact' } = req.body || {};
  const sec = run.draft.sections.find((x) => x.id === section_id);
  if (!sec || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: '需要指定章节和句子内容' });
  const t = text.trim().slice(0, 500);
  const s = { id: nextSentenceId(run.draft), text: t, type: ['fact', 'inference', 'pending'].includes(type) ? type : 'fact', refs: [...new Set([...t.matchAll(ID_REF)].map((m) => m[1]))], origin: 'human' };
  s.flags = verifySentence(s, run, entityNames(run), rules());
  sec.sentences.push(s);
  run.gate = computeGate(run.draft);
  run.coverage = coverage(run.draft, run);
  logAudit(run, actorOf(req.body?.actor), 'add', `${s.id} 新增：「${s.text.slice(0, 30)}」`, s.id);
  store.save(run);
  res.json(run);
});

app.post('/api/runs/:id/feedback', writeGuard, (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  if (run.is_sample) return res.status(409).json({ error: '这是所有人共享的样例，为只读；请先点「复制一份自己用」再反馈' });
  const { sid, rating, reason = '' } = req.body || {};
  if (!['up', 'down'].includes(rating)) return res.status(400).json({ error: 'rating 只能是 up / down' });
  if (!findSentence(run, sid)) return res.status(404).json({ error: '句子不存在' });
  const r = String(reason).slice(0, 40);
  run.feedback.push({ at: Date.now(), sid, rating, reason: r });
  logAudit(run, '投顾', 'feedback', `${sid} ${rating === 'up' ? '有用' : '无用'}${r ? `：${r}` : ''}`, sid);
  store.save(run);
  res.json(run);
});

app.post('/api/runs/:id/ai-review', limited(reviewLimiter, 'AI 合规复核过于频繁，每个 IP 每小时最多 20 次'), async (req, res) => {
  const run = getRun(req, res);
  if (!run || !guardEditable(run, res)) return;
  const ctx = { calls: [], llm: [], simulate: [] };
  const live = run.draft.sections.flatMap((sec) => sec.sentences.filter((s) => !s.deleted));
  const snapshot = new Map(live.map((s) => [s.id, s.text]));
  const rendered = live.map((s) => ({ sid: s.id, type: s.type, text: renderText(s.text, run, run.trading.date) }));
  run.ai_review_running = true;
  let issues;
  try {
    issues = await aiComplianceReview(ctx, rendered);
  } catch (e) {
    return res.status(502).json({ error: `AI 合规复核失败：${e.message}；关键词规则校验仍然有效` });
  } finally {
    // 先清除标记再响应：否则返回给前端的稿件仍带"复核中"标记，页面会一直锁定
    delete run.ai_review_running;
  }
  // 等待模型期间若稿件状态或句子文字已变，只把结果挂到文字未变的句子上
  if (!EDITABLE.has(run.status)) return res.status(409).json({ error: '复核期间稿件状态已变化，结果未写入' });
  let applied = 0;
  for (const sec of run.draft.sections) {
    for (const s of sec.sentences) {
      if (!snapshot.has(s.id) || snapshot.get(s.id) !== s.text) continue;
      s.ai_flags = issues.filter((i) => i && i.sid === s.id).map((i) => ({ category: String(i.category || '其他').slice(0, 20), reason: String(i.reason || '').slice(0, 200), suggestion: String(i.suggestion || '').slice(0, 200), dismissed: false }));
      applied += s.ai_flags.length;
    }
  }
  run.ai_review = { at: Date.now(), issues: applied, ms: ctx.llm[0]?.ms };
  run.gate = computeGate(run.draft);
  logAudit(run, 'AI', 'ai_review', `AI 合规复核：发现 ${applied} 处疑似问题（仅提示，由人决定是否修改）`);
  store.save(run);
  res.json(run);
});

app.post('/api/runs/:id/submit', writeGuard, (req, res) => {
  const run = getRun(req, res);
  if (!run || !guardEditable(run, res)) return;
  reverify(run);
  if (!run.gate.can_submit) {
    // 按最新规则重算的结果要落盘：规则升级后，存量草稿在提交时会暴露新的阻断项
    logAudit(run, '系统', 'submit_blocked', `提交被门禁拒绝：阻断项 ${run.gate.block}、待确认 ${run.gate.pending_unresolved}`);
    store.save(run);
    return res.status(409).json({ error: `还有 ${run.gate.block} 个阻断项、${run.gate.pending_unresolved} 条待确认句未处理，不能提交合规审核` });
  }
  run.status = 'in_review';
  run.submitted_at = Date.now();
  run.submit_count = (run.submit_count || 0) + 1;
  logAudit(run, '投顾', 'submit', `第 ${run.submit_count} 次提交合规审核`);
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

app.post('/api/runs/:id/review', writeGuard, (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  if (run.status !== 'in_review') return res.status(409).json({ error: `只有「待合规审核」状态可以审核，当前为「${statusLabel(run.status)}」` });
  const { decision, comment = '' } = req.body || {};
  const c = String(comment).trim().slice(0, 300);
  if (decision === 'approve') {
    // 审核通过前按最新规则复检：提交之后新增的团队规则同样有效
    reverify(run);
    if (run.gate.block || run.gate.pending_unresolved) {
      store.save(run);
      return res.status(409).json({ error: `按最新规则复检发现 ${run.gate.block} 个阻断项、${run.gate.pending_unresolved} 条待确认句，请退回修改` });
    }
    run.status = 'approved';
    run.approved_at = Date.now();
    run.final_text = buildFinal(run);
  } else if (decision === 'return') {
    if (!c) return res.status(400).json({ error: '退回需要填写审核意见' });
    run.status = 'returned';
    run.returns = (run.returns || 0) + 1;
  } else {
    return res.status(400).json({ error: 'decision 只能是 approve / return' });
  }
  run.review = { decision, comment: c, at: Date.now() };
  logAudit(run, '合规', decision, decision === 'approve' ? '审核通过，生成定稿' : `退回：${c}`);
  store.save(run);
  res.json(run);
});

app.get('/api/runs/:id/export', (req, res) => {
  const run = getRun(req, res);
  if (!run) return;
  const text = run.final_text || `【未审核草稿，不可对外发布】\n${buildFinal(run)}`;
  res.type('text/plain; charset=utf-8').send(text);
});

// 多日离线评测结果（scripts/eval.mjs 生成，随仓库发布）
app.get('/api/eval', (req, res) => {
  try {
    res.type('application/json').send(fs.readFileSync(path.join(ROOT, 'data/eval/latest.json'), 'utf8'));
  } catch {
    res.status(404).json({ error: '还没有评测结果：运行 node scripts/eval.mjs 生成' });
  }
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
        if (s.origin === 'system') continue;
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
  const repairs = runs.filter((r) => r.repair);
  const sumRepair = (k) => repairs.reduce((a, r) => a + (r.repair[k] || 0), 0);
  // 阻断数按级别统计（initial_blocks / final_blocks）；早期记录没有这两个字段时按规则名回退
  const legacy = (fl) => Object.entries(fl || {}).filter(([k]) => ['untraced_number', 'entity_mismatch', 'unit_mismatch', 'unknown_ref', 'fact_no_source', 'inference_no_basis', 'predict', 'advice', 'promise'].includes(k)).reduce((a, [, v]) => a + v, 0);
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
    repair: { runs: repairs.length, attempted: sumRepair('attempted'), fixed: sumRepair('fixed'), deleted: sumRepair('deleted'), failed: sumRepair('failed') },
    blocks_before_repair: repairs.reduce((a, r) => a + (r.initial_blocks ?? legacy(r.initial_flags)), 0),
    blocks_after_repair: repairs.reduce((a, r) => a + (r.final_blocks ?? legacy(r.final_flags)), 0),
    team_rules: store.config.rules.length,
    team_preferences: store.config.preferences.length,
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

// 统一错误出口：返回 JSON，不把堆栈和服务器路径暴露给客户端
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const bad = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
  res.status(bad ? (err.status || 400) : 500).json({ error: err.type === 'entity.too.large' ? '请求体过大' : bad ? '请求体不是合法 JSON' : '服务器内部错误' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`复盘稿工作台已启动：http://localhost:${port}`));
