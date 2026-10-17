const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { role: '投顾', run: null, tab: 'facts', editing: null, focusRef: null };
const TYPE = { fact: ['事实', 't-fact'], inference: ['推断', 't-inf'], pending: ['待确认', 't-pend'] };
const STATUS = { generating: '生成中', draft: '草稿', in_review: '待合规审核', approved: '已通过', returned: '已退回' };
const AUD = { steady: '稳健型客户群', short: '短线交流群', inst: '机构/内部简报' };
const SIM = { 'fuyao:limit_up_pool': '涨停池失败', 'fuyao:index_kline': '指数日K失败', stale_stats: '统计过期', llm_down: '大模型不可用', inject_violation: '注入违规句', 'fuyao:limit_up_statistics': '涨停统计失败', 'fuyao:anomaly_analysis': '异动解读失败' };
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = `toast ${bad ? 'bad' : ''}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// ---------- 文本渲染：占位符 → 可点击的事实芯片 ----------
const PH = /\{\{\s*(F\d+|E\d+|DATE)\s*\}\}/g;
function cnDate(d) { const [, m, dd] = d.split('-').map(Number); return `${m}月${dd}日`; }
// 与服务端 verify.js 的 trimOverlap 保持一致：去掉占位符前后与渲染值重叠的字词
function trimOverlap(prev, display, next) {
  let d = display;
  let trimmed = false;
  for (let k = Math.min(4, d.length - 1); k >= 1; k--) if (prev.endsWith(d.slice(0, k))) { d = d.slice(k); trimmed = true; break; }
  if (!trimmed) {
    const tail = prev.slice(-8);
    for (let k = Math.min(6, d.length - 1); k >= 2; k--) if (tail.includes(d.slice(0, k))) { d = d.slice(k); break; }
  }
  for (let k = Math.min(4, d.length - 1); k >= 1; k--) if (next.startsWith(d.slice(-k))) { d = d.slice(0, d.length - k); break; }
  return d;
}
function renderRich(text, run) {
  let out = '';
  let raw = '';
  let last = 0;
  for (const m of text.matchAll(PH)) {
    const before = text.slice(last, m.index);
    out += esc(before);
    raw += before;
    const id = m[1];
    if (id === 'DATE') { out += esc(cnDate(run.trading.date)); raw += cnDate(run.trading.date); }
    else {
      const f = run.facts.find((x) => x.id === id);
      if (f) {
        const d = trimOverlap(raw, f.display, text.slice(m.index + m[0].length));
        out += `<span class="chip" data-ref="${id}" title="${esc(`${id} ${f.label}｜${f.caliber || ''}`)}">${esc(d)}</span>`;
        raw += d;
      } else if (!run.evidence.find((x) => x.id === id)) out += `<span class="chip bad">无效引用${id}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}
function plain(text, run) {
  return text.replace(PH, (_, id) => (id === 'DATE' ? cnDate(run.trading.date) : run.facts.find((x) => x.id === id)?.display || ''));
}

// ---------- 历史记录 ----------
async function loadRuns(openId) {
  const list = await api('/api/runs');
  $('#runList').innerHTML = list.length ? list.map((r) => `
    <li data-id="${r.id}" class="${state.run?.id === r.id ? 'on' : ''}">
      <div><b>${esc(r.date || '—')}</b> <span class="st st-${r.status}">${STATUS[r.status] || r.status}</span>${r.is_sample ? ' <span class="tag">样例</span>' : ''}${r.degraded ? ' <span class="tag warn">降级</span>' : ''}</div>
      <div class="sub">${esc(AUD[r.audience] || '')} · ${fmtTime(r.created_at)}${r.simulate?.length ? ` · 演练：${r.simulate.map((s) => SIM[s] || s).join('、')}` : ''}</div>
    </li>`).join('') : '<li class="sub">暂无记录</li>';
  $$('#runList li[data-id]').forEach((li) => li.onclick = () => openRun(li.dataset.id));
  if (openId) openRun(openId);
  else if (!state.run && list.length) openRun(list[0].id);
}
async function openRun(id) {
  state.run = await api(`/api/runs/${id}`);
  state.editing = null;
  $('#progress').classList.add('hidden');
  render();
  $$('#runList li').forEach((li) => li.classList.toggle('on', li.dataset.id === id));
}

// ---------- 生成（NDJSON 流式进度） ----------
async function startRun() {
  const btn = $('#btnRun');
  btn.disabled = true;
  btn.textContent = '生成中…';
  const simulate = $$('.sim input:checked').map((x) => x.value);
  const prog = $('#progress');
  prog.classList.remove('hidden');
  prog.innerHTML = '<h3>生成进度</h3><ul class="steps"></ul>';
  $('#empty').classList.add('hidden');
  const ul = $('.steps', prog);
  const line = (html, cls = '') => { const li = document.createElement('li'); li.className = cls; li.innerHTML = html; ul.appendChild(li); li.scrollIntoView({ block: 'nearest' }); return li; };
  const callEls = {};
  try {
    const res = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: $('#date').value || null, audience: $('#audience').value, simulate }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        const ev = JSON.parse(raw);
        if (ev.type === 'stage') line(`<b>▸ ${esc(ev.msg)}</b>`, 'stage');
        else if (ev.type === 'tool_start') callEls[ev.call.id] = line(`<span class="spin"></span> ${ev.call.by === 'agent' ? '<span class="tag agent">Agent</span> ' : ''}${esc(ev.call.title)} <code>${esc(ev.call.path)}</code>`, 'call');
        else if (ev.type === 'tool_end') {
          const el = callEls[ev.call.id];
          if (el) el.innerHTML = `${ev.call.ok ? '<span class="ok">✓</span>' : '<span class="no">✗</span>'} ${ev.call.by === 'agent' ? '<span class="tag agent">Agent</span> ' : ''}${esc(ev.call.title)} · ${ev.call.ms}ms${ev.call.attempts > 1 ? ` · 重试${ev.call.attempts - 1}次` : ''}${ev.call.ok ? '' : ` · <span class="no">${esc(ev.call.error)}</span>`}`;
        } else if (ev.type === 'facts') line(`事实底稿：${ev.facts} 条数字事实、${ev.evidence} 条文本证据；缺失 ${ev.gaps.length} 项、数据核验提示 ${ev.dq.length} 项`, 'info');
        else if (ev.type === 'agent_step') {
          const s = ev.step;
          if (s.tool_calls.length) line(`<span class="tag agent">Agent 第${s.round}轮</span> ${esc(s.thought || '')} → ${s.tool_calls.map((t) => `<code>${esc(t.name)}(${esc(JSON.stringify(t.args))})</code>`).join(' ')}`, 'agent');
          else if (s.thought) line(`<span class="tag agent">Agent 小结</span> ${esc(s.thought).replace(/\n/g, '<br>')}`, 'agent');
        } else if (ev.type === 'warn') line(`⚠ ${esc(ev.msg)}`, 'warn');
        else if (ev.type === 'info') line(`ℹ ${esc(ev.msg)}`, 'info');
        else if (ev.type === 'error') {
          line(`✗ ${esc(ev.msg)}${ev.suggestion ? ` <button class="mini" data-sug="${esc(ev.suggestion)}">改用 ${esc(ev.suggestion)}</button>` : ''}`, 'error');
          const b = $('button[data-sug]', prog);
          if (b) b.onclick = () => { $('#date').value = b.dataset.sug; startRun(); };
        } else if (ev.type === 'done') {
          state.run = ev.run;
          line(`<b>✓ 完成</b>：用时 ${(ev.run.metrics.gen_ms / 1000).toFixed(1)}s，接口调用 ${ev.run.metrics.tool_calls} 次（Agent 自主调用 ${ev.run.metrics.agent_tool_calls} 次），大模型调用 ${ev.run.metrics.llm_calls} 次`, 'done');
          render();
          loadRuns();
        }
      }
    }
  } catch (e) {
    line(`✗ ${esc(e.message)}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '生成复盘底稿';
  }
}

// ---------- 主视图 ----------
function render() {
  const run = state.run;
  if (!run) return;
  $('#empty').classList.add('hidden');
  const editable = ['draft', 'returned'].includes(run.status) && state.role === '投顾';
  const g = run.gate || {};
  const m = run.metrics || {};
  const actions = [];
  if (state.role === '投顾' && ['draft', 'returned'].includes(run.status)) {
    actions.push('<button id="aAi" class="ghost">AI 合规复核</button>');
    actions.push(`<button id="aSubmit" class="primary" ${g.can_submit ? '' : 'disabled'} title="${g.can_submit ? '' : '需先清零阻断项并处理全部待确认句'}">提交合规审核</button>`);
  }
  if (state.role === '合规' && run.status === 'in_review') {
    actions.push('<button id="aReturn" class="ghost danger">退回修改</button>', '<button id="aApprove" class="primary">审核通过</button>');
  }
  actions.push('<button id="aExport" class="ghost">导出文本</button>');
  const roleHint = run.status === 'in_review' && state.role === '投顾' ? '<div class="hint">已提交，等待合规审核：右上角切换为「合规审核」角色可继续体验审批。</div>'
    : ['draft', 'returned'].includes(run.status) && state.role === '合规' ? '<div class="hint">当前为草稿，需投资顾问提交后才能审核。</div>' : '';

  $('#runView').innerHTML = `
  <div class="card run-head">
    <div class="title-row">
      <h2>${esc(plain(run.draft.title, run))}</h2>
      <span class="st st-${run.status}">${STATUS[run.status]}</span>
      ${run.is_sample ? '<span class="tag">真实数据样例</span>' : ''}
    </div>
    <div class="meta">交易日 ${esc(run.trading.date)} · ${esc(AUD[run.input.audience])} · 生成于 ${fmtTime(run.created_at)} · 用时 ${(m.gen_ms / 1000).toFixed(1)}s · 接口 ${m.tool_calls} 次（Agent ${m.agent_tool_calls}）· 大模型 ${m.llm_calls} 次 · 事实 ${m.facts} 条 / 证据 ${m.evidence} 条
    ${run.input.simulate?.length ? `<br><span class="tag warn">故障演练：${run.input.simulate.map((s) => SIM[s] || s).join('、')}</span>` : ''}
    ${run.repair?.attempted ? `<br><span class="tag ok">自动修复：${run.repair.attempted} 句未通过校验 → 修好 ${run.repair.fixed}、删除 ${run.repair.deleted}、未修好 ${run.repair.failed}（未修好的保留原句交人工）</span>` : ''}
    ${run.writer?.fallback ? `<br><span class="tag warn">大模型撰写失败（${esc(run.writer.error)}），已降级为纯数据底稿</span>` : ''}</div>
    <div class="gate">
      <div class="g ${g.block ? 'bad' : 'good'}"><b>${g.block}</b>阻断项</div>
      <div class="g ${g.pending_unresolved ? 'warnc' : 'good'}"><b>${g.pending_unresolved}</b>待确认未处理</div>
      <div class="g ${g.warn ? 'warnc' : ''}"><b>${g.warn}</b>提醒</div>
      <div class="g"><b>${Math.round((g.sourced_ratio || 0) * 100)}%</b>句子有依据</div>
      <div class="g ${run.gaps.length ? 'warnc' : 'good'}"><b>${run.gaps.length}</b>数据缺失</div>
      ${run.coverage ? `<div class="g ${run.coverage.missed.length ? 'warnc' : 'good'}" title="${esc(run.coverage.missed.map((m) => `未提及：${m.hint}`).join('\n') || '关键事实清单全部覆盖')}"><b>${run.coverage.covered}/${run.coverage.applicable}</b>关键事实覆盖</div>` : ''}
      <div class="acts">${actions.join('')}</div>
    </div>
    ${roleHint}
    ${run.coverage?.missed.length ? `<div class="hint">关键事实提醒（不阻断）：本稿未提及 ${run.coverage.missed.map((m) => `「${esc(m.name)}」（${esc(m.hint)}）`).join('、')}，请确认是否有意省略。</div>` : ''}
    ${run.review ? `<div class="review ${run.review.decision}">合规意见（${fmtTime(run.review.at)}）：${run.review.decision === 'approve' ? '通过' : '退回'}${run.review.comment ? ` —— ${esc(run.review.comment)}` : ''}</div>` : ''}
  </div>
  ${renderHypotheses(run)}
  ${renderAgent(run)}
  ${run.draft.sections.map((sec) => `
    <div class="card section">
      <h3>${esc(sec.heading)}</h3>
      ${sec.sentences.map((s) => renderSentence(s, run, editable)).join('')}
      ${editable ? `<button class="mini add" data-sec="${sec.id}">＋ 人工补充一句</button>` : ''}
    </div>`).join('')}
  ${run.final_text ? `<div class="card final"><h3>定稿（可直接发布）</h3><pre>${esc(run.final_text)}</pre><button id="aCopy" class="primary">复制定稿</button></div>` : ''}
  <div class="card legend">
    <span class="badge t-fact">事实</span> 只复述底稿数据 · <span class="badge t-inf">推断</span> 有依据且带不确定措辞 · <span class="badge t-pend">待确认</span> 缺失/冲突需人工确认 ·
    <span class="chip">蓝色数字</span> 由系统按原始字段渲染，点击查看来源
  </div>`;
  bindRun(run, editable);
  renderSide();
}

function refChip(id, run) {
  const f = run.facts.find((x) => x.id === id);
  const e = run.evidence.find((x) => x.id === id);
  const tip = f ? `${f.label}：${f.display}` : e ? `${e.stock || e.kind}：${e.text.slice(0, 80)}` : id;
  return `<span class="ref" data-ref="${id}" title="${esc(tip)}">${id}${f ? ` ${esc(f.display)}` : ''}</span>`;
}

function renderHypotheses(run) {
  const hs = run.agent?.hypotheses || [];
  if (!hs.length) return '';
  const V = { 支持: 'v-yes', 部分支持: 'v-part', 不支持: 'v-no', 存疑: 'v-q' };
  return `<div class="card hypo"><h3>主线判断依据 <span class="sub">Agent 先提出判断、再找支持和反面证据；系统核对编号真实存在，证据不足的判断降为"存疑"。撰写只能按这里的结论落笔。</span></h3>
    <div class="tbl"><table><thead><tr><th>判断</th><th>结论</th><th>支持证据</th><th>反证</th><th>待补证据</th></tr></thead><tbody>
    ${hs.map((h) => `<tr><td>${esc(h.claim)}${h.problems?.length ? `<div class="flag warn">${esc(h.problems.join('；'))}</div>` : ''}</td>
      <td><span class="verdict ${V[h.verdict] || ''}">${esc(h.verdict)}</span></td>
      <td>${h.support.map((r) => refChip(r, run)).join(' ') || '—'}</td>
      <td>${h.against.map((r) => refChip(r, run)).join(' ') || '—'}</td>
      <td>${esc(h.gap || '—')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function renderAgent(run) {
  const a = run.agent || {};
  if (!a.used) return `<div class="card agent-box"><h3>Agent 调查过程</h3><p class="hint">${a.error ? `Agent 未执行：${esc(a.error)}；本稿只使用基础数据。` : '本稿未使用 Agent。'}</p></div>`;
  return `<details class="card agent-box"><summary><b>Agent 调查过程</b>（${a.steps.filter((s) => s.tool_calls.length).length} 轮工具调用，点击展开）</summary>
    ${a.steps.map((s) => `<div class="astep"><div><span class="tag agent">第${s.round}轮</span> ${esc(s.thought || '').replace(/\n/g, '<br>')}</div>
      ${s.tool_calls.map((t) => `<div class="tc"><code>${esc(t.name)}(${esc(JSON.stringify(t.args))})</code><pre>${esc(t.result)}</pre></div>`).join('')}</div>`).join('')}
  </details>`;
}

function renderSentence(s, run, editable) {
  const [tl, tc] = TYPE[s.type] || ['?', ''];
  const flags = (s.flags || []).map((f) => `<div class="flag ${f.level}">${f.level === 'block' ? '阻断' : '提醒'}｜${esc(f.msg)}${f.fix ? `<span class="fix">建议：${esc(f.fix)}</span>` : ''}</div>`).join('');
  const ai = (s.ai_flags || []).filter((f) => !f.dismissed).map((f) => `<div class="flag ai">AI 复核｜${esc(f.category)}：${esc(f.reason)}${f.suggestion ? `<span class="fix">改写建议：${esc(f.suggestion)}</span>` : ''}</div>`).join('');
  const refs = (s.refs || []).filter((r) => /^E/.test(r)).map((r) => `<span class="ref" data-ref="${r}">${r}</span>`).join('');
  const fb = run.feedback.filter((f) => f.sid === s.id).slice(-1)[0];
  if (state.editing === s.id) {
    return `<div class="sent editing" data-sid="${s.id}">
      <textarea id="editText">${esc(s.text)}</textarea>
      <div class="hint">数字请用 {{F编号}} 引用（点击右侧事实底稿的编号可插入），日期用 {{DATE}}。保存后自动重新校验。</div>
      <div class="row"><select id="editType">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      <button class="primary mini" id="saveEdit">保存并校验</button><button class="mini" id="cancelEdit">取消</button></div>
    </div>`;
  }
  return `<div class="sent ${s.deleted ? 'deleted' : ''} ${s.flags?.some((f) => f.level === 'block') ? 'has-block' : ''}" data-sid="${s.id}">
    <div class="line"><span class="badge ${tc}">${tl}</span>${s.origin === 'human' ? '<span class="tag">人工</span>' : s.origin === 'injected' ? '<span class="tag warn">注入</span>' : ''}${s.edited ? '<span class="tag">已改</span>' : ''}
      ${repairTag(s)}<span class="txt">${renderRich(s.text, run)}</span>${refs}</div>
    ${repairDetail(s, run)}
    ${s.deleted ? '' : flags + ai}
    ${s.type === 'pending' && s.pending_confirmed ? `<div class="flag ok">已人工确认保留${s.note ? `：${esc(s.note)}` : ''}</div>` : ''}
    <div class="ops">
      ${editable && !s.deleted ? `<button class="mini" data-op="edit">编辑</button>` : ''}
      ${editable && s.type === 'pending' && !s.pending_confirmed && !s.deleted ? `<button class="mini" data-op="confirm">确认保留</button>` : ''}
      ${editable && (s.ai_flags || []).some((f) => !f.dismissed) ? `<button class="mini" data-op="dismiss">忽略 AI 提示</button>` : ''}
      ${editable ? `<button class="mini" data-op="${s.deleted ? 'restore' : 'delete'}">${s.deleted ? '恢复' : '删除'}</button>` : ''}
      ${!s.deleted ? `<button class="mini fb ${fb?.rating === 'up' ? 'on' : ''}" data-op="up" title="这句有用">👍</button><button class="mini fb ${fb?.rating === 'down' ? 'on' : ''}" data-op="down" title="这句有问题">👎${fb?.rating === 'down' && fb.reason ? ` ${esc(fb.reason)}` : ''}</button>` : ''}
    </div>
  </div>`;
}

function repairTag(s) {
  const r = s.repair;
  if (!r) return '';
  if (r.status === 'fixed') return '<span class="tag ok">AI 已自修复</span>';
  if (r.status === 'deleted') return '<span class="tag warn">AI 已删除</span>';
  return '<span class="tag warn">自修复未通过</span>';
}
function repairDetail(s, run) {
  const r = s.repair;
  if (!r) return '';
  return `<details class="repair"><summary>查看自修复记录</summary>
    <div>修复前：${esc(plain(r.before.text, run))}</div>
    <div>当时的问题：${esc((r.before.problems || []).join('；'))}</div>
    ${r.reason ? `<div>模型说明：${esc(r.reason)}</div>` : ''}
    ${r.status === 'failed' && r.attempt ? `<div>修订稿（未采用）：${esc(plain(r.attempt, run))}</div><div>修订后仍存在：${esc((r.remaining || []).join('；'))}</div>` : ''}
  </details>`;
}

function bindRun(run, editable) {
  const upd = async (p, body, method = 'PATCH') => {
    try {
      state.run = await api(`/api/runs/${run.id}${p}`, { method, body });
      state.editing = null;
      render();
      loadRuns();
    } catch (e) {
      toast(e.message, true);
      // 失败时（如提交被门禁拒绝）服务端可能已按最新规则重算了校验结果，重新拉取以免页面显示过期状态
      try { state.run = await api(`/api/runs/${run.id}`); state.editing = null; render(); } catch { /* 保持当前视图 */ }
    }
  };
  $$('.chip[data-ref], .ref[data-ref]').forEach((c) => c.onclick = () => focusRef(c.dataset.ref));
  $$('.sent[data-sid]').forEach((el) => {
    const sid = el.dataset.sid;
    $$('[data-op]', el).forEach((b) => b.onclick = async () => {
      const op = b.dataset.op;
      if (op === 'edit') { state.editing = sid; render(); $('#editText')?.focus(); }
      else if (op === 'delete' || op === 'restore') upd(`/sentences/${sid}`, { action: op, actor: state.role });
      else if (op === 'confirm') { const note = prompt('确认保留这条"待确认"说明？可填写核实备注（可留空）：', ''); if (note !== null) upd(`/sentences/${sid}`, { action: 'confirm_pending', note, actor: state.role }); }
      else if (op === 'dismiss') upd(`/sentences/${sid}`, { action: 'dismiss_ai', actor: state.role });
      else if (op === 'up') upd('/feedback', { sid, rating: 'up' }, 'POST');
      else if (op === 'down') { const reason = prompt('哪里有问题？（例：数字错误 / 归因牵强 / 不合规 / 表达啰嗦 / 遗漏重点）', '归因牵强'); if (reason !== null) upd('/feedback', { sid, rating: 'down', reason }, 'POST'); }
    });
  });
  if ($('#saveEdit')) {
    $('#saveEdit').onclick = () => upd(`/sentences/${state.editing}`, { text: $('#editText').value, type: $('#editType').value, actor: state.role });
    $('#cancelEdit').onclick = () => { state.editing = null; render(); };
  }
  $$('button.add').forEach((b) => b.onclick = () => {
    const text = prompt('补充一句（数字请用 {{F编号}} 引用事实底稿）：', '');
    if (text) upd('/sentences', { section_id: b.dataset.sec, text, type: 'fact', actor: state.role }, 'POST');
  });
  if ($('#aSubmit')) $('#aSubmit').onclick = () => upd('/submit', { actor: state.role }, 'POST');
  if ($('#aAi')) $('#aAi').onclick = async () => { $('#aAi').disabled = true; $('#aAi').textContent = 'AI 复核中…'; await upd('/ai-review', {}, 'POST'); };
  if ($('#aApprove')) $('#aApprove').onclick = () => upd('/review', { decision: 'approve' }, 'POST');
  if ($('#aReturn')) $('#aReturn').onclick = () => { const c = prompt('退回意见（必填）：', ''); if (c) upd('/review', { decision: 'return', comment: c }, 'POST'); };
  if ($('#aExport')) $('#aExport').onclick = () => window.open(`/api/runs/${run.id}/export`, '_blank');
  if ($('#aCopy')) $('#aCopy').onclick = () => navigator.clipboard.writeText(run.final_text).then(() => toast('定稿已复制'));
}

function focusRef(id) {
  state.focusRef = id;
  if (state.editing && /^F/.test(id)) {
    const ta = $('#editText');
    const pos = ta.selectionStart ?? ta.value.length;
    ta.value = `${ta.value.slice(0, pos)}{{${id}}}${ta.value.slice(pos)}`;
    ta.focus();
  }
  state.tab = 'facts';
  renderSide();
  const el = document.getElementById(`ref-${id}`);
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
}

// ---------- 右侧面板 ----------
function renderSide() {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  const run = state.run;
  const P = $('#sidePanel');
  if (!run) return;
  if (state.tab === 'facts') {
    P.innerHTML = `<p class="hint">点击编号可插入到正在编辑的句子。所有数字事实均来自下列接口字段，系统计算的派生值已注明公式。</p>
      ${run.facts.map((f) => `<div class="fact" id="ref-${f.id}">
        <div><button class="idbtn" data-ins="${f.id}">${f.id}</button> <b>${esc(f.label)}</b> = <span class="chip">${esc(f.display)}</span></div>
        <div class="sub">字段：${esc(f.field)} · 时点：${esc(f.as_of)}</div>
        <div class="sub">口径：${esc(f.caliber || '—')}</div>
        <div class="sub">来源：${esc(f.source)} <code>${esc(f.endpoint || '')}</code> · 调用 ${esc(f.call_id || '')} · request_id ${esc((f.request_id || '').slice(0, 12))}</div>
        ${f.members ? `<div class="sub">成员：${esc(f.members.slice(0, 15).join('、'))}</div>` : ''}
      </div>`).join('')}
      <h4>文本证据</h4>
      ${run.evidence.map((e) => `<div class="fact" id="ref-${e.id}"><div><b>${e.id}</b> ${esc(e.stock || '')} ${e.tag ? `<span class="tag">${esc(e.tag)}</span>` : ''} <span class="sub">${esc(e.kind)}</span></div>
        <div class="evtext">${esc(e.text)}</div>
        <div class="sub">来源：${esc(e.source)}${e.time ? ` · ${esc(e.time)}` : ''}${e.link ? ` · <a href="${esc(e.link)}" target="_blank" rel="noopener">原文</a>` : ''}</div></div>`).join('') || '<p class="hint">无</p>'}`;
    $$('.idbtn', P).forEach((b) => b.onclick = () => focusRef(b.dataset.ins));
  } else if (state.tab === 'dq') {
    const t = run.trading;
    P.innerHTML = `<div class="fact"><b>交易日校验</b><div class="sub">所选：${esc(t.date)}；最近已收盘交易日：${esc(t.latestClosed)}；生成时：${esc(t.now)}</div>
      <div class="sub">行情快照是否等于所选日收盘口径：${t.snapshotIsDateClose ? '是（全市场涨跌家数可用）' : '否（涨跌家数不出具）'}</div></div>
      <h4>数据缺失（${run.gaps.length}）</h4>${run.gaps.map((g) => `<div class="flag warn"><b>${esc(g.title)}</b>：${esc(g.reason)}</div>`).join('') || '<p class="hint">无缺失</p>'}
      <h4>交叉核验与提示（${run.dq.length}）</h4>${run.dq.map((d) => `<div class="flag ${d.level === 'error' ? 'block' : d.level === 'warn' ? 'warn' : 'ok'}"><b>${esc(d.title)}</b>：${esc(d.detail)}</div>`).join('') || '<p class="hint">涨停池与统计家数、炸板池与炸板家数、天梯与最高板等交叉核验均一致</p>'}
      <p class="hint">规则：任何数据缺失、冲突、过期都不会被写成"正常"结论，只会以"待确认"句出现，并且必须人工确认后才能提交。</p>`;
  } else if (state.tab === 'calls') {
    P.innerHTML = `<p class="hint">共 ${run.calls.length} 次接口调用；带 Agent 标记的是大模型自主发起的。</p>${run.calls.map((c) => `<div class="fact">
      <div>${c.ok ? '<span class="ok">✓</span>' : '<span class="no">✗</span>'} <b>${esc(c.id)}</b> ${c.by === 'agent' ? '<span class="tag agent">Agent</span>' : ''} ${esc(c.title)} · ${c.ms}ms${c.attempts > 1 ? ` · 重试${c.attempts - 1}次` : ''}</div>
      <div class="sub"><code>${esc(c.path)}</code> ${esc(JSON.stringify(c.params))}</div>
      <div class="sub">${c.ok ? `request_id ${esc(c.request_id || '')} · 数据时间 ${esc(c.data_time || '—')}` : `<span class="no">失败 code=${esc(c.code)}：${esc(c.error)}</span>`}</div></div>`).join('')}
      <h4>大模型调用</h4>${(run.llm || []).map((l) => `<div class="sub">${esc(l.kind)} · ${esc(l.model)} · ${l.ms}ms · ${l.usage?.total_tokens || '?'} tokens</div>`).join('') || '<p class="hint">无</p>'}`;
  } else {
    P.innerHTML = `<h4>审计日志</h4>${run.audit.slice().reverse().map((a) => `<div class="fact"><div><b>${esc(a.actor)}</b> · ${esc(a.action)} · <span class="sub">${fmtTime(a.at)}</span></div><div class="sub">${esc(a.detail || '')}</div></div>`).join('')}
      <h4>逐句反馈（${run.feedback.length}）</h4>${run.feedback.map((f) => `<div class="sub">${esc(f.sid)} ${f.rating === 'up' ? '👍' : '👎'} ${esc(f.reason || '')} · ${fmtTime(f.at)}</div>`).join('') || '<p class="hint">还没有反馈</p>'}`;
  }
}

// ---------- 弹窗：指标 / 说明 ----------
function modal(html) { $('#modalContent').innerHTML = html; $('#modal').classList.remove('hidden'); }
$('#modal .close').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };

async function showMetrics() {
  const m = await api('/api/metrics');
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const card = (v, k, d) => `<div class="mcard"><b>${v}</b><span>${k}</span><small>${d}</small></div>`;
  modal(`<h2>价值指标（基于本实例的全部生成记录）</h2>
  <p class="hint">样本 ${m.runs} 份（含样例 ${m.samples} 份），另有 ${m.aborted} 次生成因上游失败被中止且未产出结论。演示环境样本量很小，这些数字只说明“怎么量”，不代表线上效果。</p>
  <h4>效率</h4><div class="mgrid">
    ${card(`${m.avg_gen_seconds}s`, '平均生成用时', '点击生成到草稿就绪；人工撰写的耗时基线尚未实测，验证方法见 README 第 7 节')}
    ${card(m.avg_tool_calls, '平均接口调用', `其中 Agent 自主调用 ${m.avg_agent_tool_calls} 次`)}
    ${card(pct(m.tool_failure_rate), '接口失败率', '失败后对应数据块标为缺失，不静默补齐')}
  </div>
  <h4>可信度</h4><div class="mgrid">
    ${card(pct(m.avg_sourced_ratio), '句子有依据比例', '引用了至少一个底稿编号的句子 ÷ 总句数')}
    ${card(m.avg_facts, '平均事实条数', '每条都能回到接口字段、时点与口径')}
    ${card(Object.entries(m.initial_flags).map(([k, v]) => `${k}:${v}`).join(' ') || '0', '生成时拦截的问题', '按规则统计：未溯源数字、预测、荐股、收益承诺等')}
    ${card(m.repair ? `${m.repair.fixed}/${m.repair.attempted}` : '—', 'AI 自修复（修好/尝试）', m.repair ? `阻断项：自修复前 ${m.blocks_before_repair} → 自修复后 ${m.blocks_after_repair}；删除 ${m.repair.deleted} 句；修不好的保留原句交人工` : '')}
  </div>
  <h4>人机协作</h4><div class="mgrid">
    ${card(`${m.submitted}/${m.approved}`, '已提交/已通过', '提交前必须清零阻断项')}
    ${card(m.first_pass_approval == null ? '—' : pct(m.first_pass_approval), '合规一次通过率', '通过且从未被退回 ÷ 通过数')}
    ${card(pct(m.edit_rate), 'AI 句子修改率', `已提交稿件中被人修改的 AI 句子比例；删除率 ${pct(m.delete_rate)}，人工新增 ${m.human_added} 句`)}
    ${card(`${m.feedback_up}/${m.feedback_down}`, '逐句反馈 👍/👎', Object.entries(m.feedback_down_reasons).map(([k, v]) => `${k}×${v}`).join('，') || '暂无差评原因')}
    ${card(m.llm_fallback_runs, '降级次数', '大模型不可用时改出纯数据底稿')}
    ${card(`${m.team_rules}/${m.team_preferences}`, '团队规则 / 写作偏好', '来自合规退回与投顾反馈，立即作用于校验和后续生成')}
  </div>`);
}
async function showEval() {
  let e;
  try { e = await api('/api/eval'); } catch (err) { modal(`<h2>评测报告</h2><p class="hint">${esc(err.message)}</p>`); return; }
  const a = e.aggregate;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const card = (v, k, d) => `<div class="mcard"><b>${v}</b><span>${k}</span><small>${d}</small></div>`;
  const flags = Object.entries(a.flags_before || {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}×${v}`).join('，') || '无';
  const verdicts = Object.entries(a.verdicts || {}).map(([k, v]) => `${k}${v}`).join('、') || '—';
  const rows = e.results.map((r) => {
    if (!r.ai || r.ai.error) return `<tr><td>${esc(r.date)}</td><td colspan="8" class="no">失败：${esc(r.ai?.error || '')}</td></tr>`;
    const x = r.ai;
    const t = r.template && !r.template.error ? r.template : null;
    return `<tr><td>${esc(r.date)}</td><td>${x.gen_s}s</td><td>${x.tool_calls}（${x.agent_tool_calls}）</td><td>${x.blocks_before} → ${x.blocks_after}</td>
      <td>${x.repair?.fixed || 0}/${x.repair?.attempted || 0}</td><td>${x.pending}</td><td>${pct(x.coverage.ratio)}${t ? ` <span class="sub">模板 ${pct(t.coverage.ratio)}</span>` : ''}</td>
      <td>${x.evidenced_inference}${t ? ` <span class="sub">模板 ${t.evidenced_inference}</span>` : ''}</td><td>${x.gaps}</td></tr>`;
  }).join('');
  modal(`<h2>评测报告：最近 ${e.dates.length} 个交易日</h2>
  <p class="hint">离线脚本 <code>scripts/eval.mjs</code> 生成于 ${esc(new Date(e.generated_at).toLocaleString('zh-CN', { hour12: false }))}。每个交易日用真实接口完整生成一次（受众：${esc(AUD[e.audience] || e.audience)}，模型：${esc(e.model)}），再用“大模型不可用”的模板稿作对照。只有 ${e.dates.length} 个交易日，结论只代表这一小段行情。</p>
  <h4>护栏是否生效</h4><div class="mgrid">
    ${card(`${a.blocks_before} → ${a.blocks_after}`, '阻断项：自修复前 → 后', `生成时拦截：${esc(flags)}`)}
    ${card(`${a.repair.fixed}/${a.repair.attempted}`, 'AI 自修复（修好/尝试）', `另删除 ${a.repair.deleted} 句；修不好的 ${a.repair.failed} 句保留原句交人工`)}
    ${card(`${a.drafts_with_zero_blocks_after}/${a.runs}`, '修复后零阻断的草稿', '剩余工作只是确认“待确认”句')}
    ${card(a.avg_pending, '平均待确认句', '数据缺失、冲突或证据不足时，系统要求人工确认')}
  </div>
  <h4>AI 相对模板稿的增量</h4><div class="mgrid">
    ${card(`${pct(a.ai_coverage)} / ${pct(a.template_coverage)}`, '关键事实覆盖率（AI / 模板）', `清单：${esc(e.checklist.join('、'))}`)}
    ${card(`${a.ai_evidenced_inference} / ${a.template_evidenced_inference}`, '带证据的归因句（AI / 模板）', '推断句且引用了异动解读、新闻等文本证据')}
    ${card(a.hypotheses, '平均主线判断条数', `结论分布：${esc(verdicts)}；引用问题 ${a.hypothesis_problems} 条`)}
    ${card(pct(a.avg_sourced_ratio), '句子有依据比例', '引用了至少一个底稿编号的句子占比')}
  </div>
  <h4>成本与稳定性</h4><div class="mgrid">
    ${card(`${a.avg_gen_s}s`, '平均生成用时', `最长 ${a.max_gen_s}s`)}
    ${card(a.avg_tool_calls, '平均接口调用', `其中 Agent 自主 ${a.avg_agent_tool_calls} 次；失败 ${a.tool_failures} 次`)}
    ${card(a.avg_tokens, '平均 token', '每篇含 Agent、撰写、自修复的全部调用')}
    ${card(`${a.ai_success}/${a.runs}`, 'AI 生成成功', '未降级为模板稿的次数')}
  </div>
  <h4>逐日明细</h4>
  <div class="tbl"><table class="eval"><thead><tr><th>交易日</th><th>用时</th><th>调用（Agent）</th><th>阻断 前→后</th><th>自修复</th><th>待确认</th><th>覆盖率</th><th>带证据归因</th><th>缺失项</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="hint">历史交易日没有收盘口径的全市场涨跌家数（快照接口只给最新行情），所以“缺失项”至少为 1，对应句子写成待确认。</p>`);
}

const BUILTIN = [
  ['确定性预测或未来走势判断', '阻断', '如"有望""明日""后市""目标价"'],
  ['买卖或仓位建议', '阻断', '如"建议关注""逢低布局""加仓"'],
  ['收益承诺或保本暗示', '阻断', '如"稳赚""保本""无风险"'],
  ['未溯源数字', '阻断', '正文数字必须写成 {{F编号}}，由系统渲染'],
  ['张冠李戴', '阻断', '个股事实只能用在该个股身上'],
  ['事实或推断没有依据编号', '阻断', '每句都要回到底稿'],
  ['夸张或煽动性措辞', '提醒', '如"暴涨""妖股""千载难逢"'],
  ['推断缺少不确定措辞 / 事实句夹带判断', '提醒', '避免把推断读成结论'],
];
async function showRules() {
  const cfg = await api('/api/config');
  const isComp = state.role === '合规';
  const fmt = (ms) => (ms ? new Date(ms).toLocaleDateString('zh-CN') : '');
  modal(`<h2>规则库与写作偏好</h2>
  <p class="hint">反馈闭环：合规把退回原因沉淀为禁用表述，投顾把反复修改的写法沉淀为写作偏好。新增后立即作用于所有草稿的校验（打开草稿时按最新规则重算），并写进之后每次生成的撰写提示词，从源头减少同类问题。</p>
  <h4>内置合规规则（代码维护）</h4>
  <div class="tbl"><table><tbody>${BUILTIN.map(([n, l, d]) => `<tr><td>${esc(n)}</td><td><span class="badge ${l === '阻断' ? 'lv-block' : 'lv-warn'}">${l}</span></td><td class="sub">${esc(d)}</td></tr>`).join('')}</tbody></table></div>
  <h4>团队禁用表述（${cfg.rules.length}）</h4>
  <div class="tbl"><table><tbody>${cfg.rules.map((r) => `<tr><td>「${esc(r.phrase)}」</td><td><span class="badge ${r.level === 'warn' ? 'lv-warn' : 'lv-block'}">${r.level === 'warn' ? '提醒' : '阻断'}</span></td><td class="sub">${esc(r.reason || '')} · ${esc(r.created_by || '')} ${fmt(r.created_at)}</td><td>${isComp ? `<button class="mini" data-del-rule="${r.id}">删除</button>` : ''}</td></tr>`).join('') || '<tr><td class="sub">暂无</td></tr>'}</tbody></table></div>
  ${isComp ? `<div class="row form"><input id="rPhrase" placeholder="禁用表述，如：确定性机会"><select id="rLevel"><option value="block">阻断</option><option value="warn">提醒</option></select><input id="rReason" placeholder="原因（可选）"><button class="primary mini" id="rAdd">加入规则库</button></div>` : '<p class="hint">切换为「合规审核」角色后可以新增或删除禁用表述。</p>'}
  <h4>写作偏好（${cfg.preferences.length}）</h4>
  <div class="tbl"><table><tbody>${cfg.preferences.map((p) => `<tr><td>${esc(p.text)}</td><td class="sub">${esc(p.created_by || '')} ${fmt(p.created_at)}</td><td><button class="mini" data-del-pref="${p.id}">删除</button></td></tr>`).join('') || '<tr><td class="sub">暂无</td></tr>'}</tbody></table></div>
  <div class="row form"><input id="pText" placeholder="写作偏好，如：成交额变化放在第一节开头"><button class="primary mini" id="pAdd">添加偏好</button></div>`);
  const after = async () => { if (state.run) { try { state.run = await api(`/api/runs/${state.run.id}`); render(); } catch { /* 记录可能已被清空 */ } } showRules(); };
  const run = async (fn) => { try { await fn(); await after(); } catch (e) { toast(e.message, true); } };
  if ($('#rAdd')) $('#rAdd').onclick = () => run(() => api('/api/config/rules', { method: 'POST', body: { phrase: $('#rPhrase').value, level: $('#rLevel').value, reason: $('#rReason').value, actor: state.role } }));
  $$('[data-del-rule]').forEach((b) => b.onclick = () => run(() => api(`/api/config/rules/${b.dataset.delRule}?actor=${encodeURIComponent(state.role)}`, { method: 'DELETE' })));
  $('#pAdd').onclick = () => run(() => api('/api/config/preferences', { method: 'POST', body: { text: $('#pText').value, actor: state.role } }));
  $$('[data-del-pref]').forEach((b) => b.onclick = () => run(() => api(`/api/config/preferences/${b.dataset.delPref}`, { method: 'DELETE' })));
}

function showAbout() {
  modal(`<h2>产品说明</h2>
  <p><b>给谁用：</b>券商/投顾机构的持牌投资顾问（每个交易日收盘后要给客户群写复盘），以及审核这些内容的合规岗。</p>
  <p><b>解决什么：</b>人工复盘要在多个页面间收集指数、涨跌停、连板、题材、异动原因，再手写、自查数字、送合规，耗时且容易出现抄错数字、口径不清、无依据归因和“明日看涨”式违规表述。</p>
  <p><b>AI 做什么：</b>① Agent 根据当天盘面判断主线，自主决定查哪些个股异动原因、哪些板块指数和新闻，把结论写成"判断 + 支持证据 + 反证 + 待补"；② 把十几类结构化数据和文本证据组织成可读的复盘稿，写出与前一交易日的变化，并区分事实、推断、待确认；③ 自修复：没通过校验的句子带着错误原因重写一轮，重新通过校验才采用；④ 语义层合规复核，补关键词规则漏掉的隐含预测和变相建议。</p>
  <p><b>反馈闭环：</b>合规把退回原因沉淀进「规则库」，投顾把常改的写法沉淀为写作偏好；新增后立即作用于所有草稿的校验，并写进之后每次生成的提示词。</p>
  <p><b>不让 AI 做什么：</b>不让它生成数字（数字由系统按原始字段渲染）、不让它决定是否发布（需投顾提交 + 合规通过）、不让它在数据缺失时“补全”。</p>
  <p><b>不做什么（非目标）：</b>不预测涨跌、不推荐个股、不面向散户直接输出、不替代合规审核。</p>
  <p><b>数据：</b>同花顺金融数据（扶摇 API）：交易日历、指数日K、涨跌停/炸板池、涨停统计、连板天梯、历史热股榜、日期范围异动解读、全A快照、同花顺行业/概念指数；iFinD MCP：财经新闻检索（第二数据源，与异动解读交叉印证）。</p>
  <p class="hint">完整的问题定义、指标口径、失败条件与验证计划见代码仓库 README。</p>`);
}

// ---------- 初始化 ----------
$$('.role button').forEach((b) => b.onclick = () => {
  state.role = b.dataset.role;
  $$('.role button').forEach((x) => x.classList.toggle('on', x === b));
  state.editing = null;
  render();
});
$$('.tabs button').forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; renderSide(); });
$('#btnRun').onclick = startRun;
$('#btnMetrics').onclick = showMetrics;
$('#btnAbout').onclick = showAbout;
$('#btnRules').onclick = showRules;
$('#btnEval').onclick = showEval;
(async () => {
  try {
    const td = await api('/api/trading-date');
    $('#date').value = td.latestClosed;
    $('#date').max = td.latestClosed;
    $('#dateHint').textContent = `最近已收盘交易日 ${td.latestClosed}；当前 ${td.now}。可选近一年内任一交易日。`;
  } catch (e) {
    $('#dateHint').textContent = `交易日历读取失败：${e.message}（生成时会再次校验）`;
  }
  loadRuns();
})();
