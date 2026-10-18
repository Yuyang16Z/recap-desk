const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ID_RE = /^[EF]\d+$/;
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);
const state = { role: '投顾', run: null, tab: 'facts', centerTab: 'draft', editing: null, inline: null, adding: null, issueIdx: -1, factFilter: '', aiBusy: null };
const TYPE = { fact: ['事实', 't-fact'], inference: ['推断', 't-inf'], pending: ['待确认', 't-pend'] };
const STATUS = { generating: '生成中', draft: '草稿', in_review: '待合规审核', approved: '已通过', returned: '已退回' };
const AUD = { steady: '稳健型客户群', short: '短线交流群', inst: '机构/内部简报' };
const SIM = { 'fuyao:limit_up_pool': '涨停池失败', 'fuyao:index_kline': '指数日K失败', stale_stats: '统计过期', llm_down: '大模型不可用', inject_violation: '注入违规句', 'fuyao:limit_up_statistics': '涨停统计失败', 'fuyao:anomaly_analysis': '异动解读失败' };
const REASONS = ['数字错误', '归因牵强', '不合规', '表达啰嗦', '遗漏重点'];
const ROLE_TIP = { 投顾: '已切换为投资顾问：可以编辑句子、确认待确认项、提交合规审核', 合规: '已切换为合规审核：可以审核通过或退回、维护规则库' };
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
const canEdit = () => state.run && !state.run.is_sample && ['draft', 'returned'].includes(state.run.status) && state.role === '投顾';
// AI 合规复核期间（本页发起，或服务端标记正在复核）暂停编辑与提交，避免改动与复核结果错位
const reviewing = () => !!state.run && (state.aiBusy === state.run.id || !!state.run.ai_review_running);
const editable = () => canEdit() && !reviewing();

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
function toast(msg, bad) {
  $$('.toast').forEach((x) => x.remove());
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
  if (!/[0-9０-９]$/.test(prev)) {
    for (let k = Math.min(4, d.length - 1); k >= 1; k--) if (prev.endsWith(d.slice(0, k))) { d = d.slice(k); break; }
  }
  for (let k = Math.min(4, d.length - 1); k >= 1; k--) if (next.startsWith(d.slice(-k))) { d = d.slice(0, d.length - k); break; }
  return d;
}
function renderRich(text, run, { showEvidence = false } = {}) {
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
        out += `<span class="chip" data-ref="${id}" title="${esc(`${id} ${f.label}`)}">${esc(d)}</span>`;
        raw += d;
      } else if (!run.evidence.find((x) => x.id === id)) out += `<span class="chip bad">无效引用${esc(id)}</span>`;
      else if (showEvidence) out += `<span class="ref" title="文本证据：发布时不显示，列在句末作为依据">${esc(id)}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}
function plain(text, run) {
  return text.replace(PH, (_, id) => (id === 'DATE' ? cnDate(run.trading.date) : run.facts.find((x) => x.id === id)?.display || ''));
}
const liveSentences = (run) => run.draft.sections.flatMap((s) => s.sentences).filter((s) => !s.deleted);
function refsOf(s) {
  return new Set([...(s.refs || []).filter((r) => ID_RE.test(r)), ...[...s.text.matchAll(PH)].map((m) => m[1]).filter((x) => x !== 'DATE')]);
}
function usageMap(run) {
  const map = new Map();
  for (const s of liveSentences(run)) for (const id of refsOf(s)) map.set(id, [...(map.get(id) || []), s.id]);
  return map;
}
function issueList(run) {
  const ss = liveSentences(run);
  return [
    ...ss.filter((s) => (s.flags || []).some((f) => f.level === 'block')).map((s) => ({ sid: s.id, kind: 'block' })),
    ...ss.filter((s) => s.type === 'pending' && !s.pending_confirmed).map((s) => ({ sid: s.id, kind: 'pending' })),
    ...ss.filter((s) => (s.flags || []).some((f) => f.level === 'warn') || (s.ai_flags || []).some((f) => !f.dismissed)).map((s) => ({ sid: s.id, kind: 'warn' })),
  ];
}

// ---------- 历史记录 ----------
async function loadRuns(openId) {
  let list = [];
  try { list = await api('/api/runs'); } catch (e) { toast(`历史记录读取失败：${e.message}`, true); }
  $('#runList').innerHTML = list.length ? list.map((r) => `
    <li data-id="${esc(r.id)}" class="${state.run?.id === r.id ? 'on' : ''}">
      <div><b>${esc(r.date || '—')}</b> <span class="st st-${esc(r.status)}">${STATUS[r.status] || esc(r.status)}</span>${r.is_sample ? ' <span class="tag">样例</span>' : ''}${r.degraded ? ' <span class="tag warn">降级</span>' : ''}</div>
      <div class="sub">${esc(AUD[r.audience] || '')} · ${fmtTime(r.created_at)}${r.gate && ['draft', 'returned'].includes(r.status) ? ` · 阻断 ${r.gate.block} · 待确认 ${r.gate.pending_unresolved}` : ''}${r.simulate?.length ? ` · 演练：${r.simulate.map((s) => SIM[s] || esc(s)).join('、')}` : ''}</div>
    </li>`).join('') : '<li class="sub">暂无记录</li>';
  $$('#runList li[data-id]').forEach((li) => li.onclick = () => openRun(li.dataset.id));
  if (openId) openRun(openId);
  else if (!state.run && list.length) openRun(list[0].id);
}
async function openRun(id) {
  try { state.run = await api(`/api/runs/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); return; }
  Object.assign(state, { editing: null, inline: null, adding: null, issueIdx: -1, centerTab: 'draft' });
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
  prog.open = true;
  prog.innerHTML = '<summary><b>生成进度</b> <span class="sub" id="progSum">进行中…</span></summary><ul class="steps"></ul>';
  $('#empty').classList.add('hidden');
  // 生成期间，下方的上一份记录变灰并标注，避免被误认为新稿
  if (state.run) { $('#runView').classList.add('stale'); $('#runView').dataset.note = '以下为上一份记录，新稿生成后自动替换'; }
  const ul = $('.steps', prog);
  const line = (html, cls = '') => { const li = document.createElement('li'); li.className = cls; li.innerHTML = html; ul.appendChild(li); ul.scrollTop = ul.scrollHeight; return li; };
  const callEls = {};
  let ended = false;
  let streaming = false;
  try {
    const res = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: $('#date').value || null, audience: $('#audience').value, simulate }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
    streaming = true;
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
        let ev;
        try { ev = JSON.parse(raw); } catch { continue; }
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
          ended = true;
          line(`✗ ${esc(ev.msg)}${ev.suggestion ? ` <button class="mini" data-sug="${esc(ev.suggestion)}">改用 ${esc(ev.suggestion)}</button>` : ''}`, 'error');
          $('#progSum').textContent = '生成中止，未产出任何结论';
          const b = $('button[data-sug]', prog);
          if (b) b.onclick = () => { $('#date').value = b.dataset.sug; startRun(); };
        } else if (ev.type === 'done') {
          ended = true;
          const m = ev.run.metrics;
          line(`<b>✓ 完成</b>：用时 ${(m.gen_ms / 1000).toFixed(1)}s，接口调用 ${m.tool_calls} 次（Agent 自主调用 ${m.agent_tool_calls} 次），大模型调用 ${m.llm_calls} 次`, 'done');
          $('#progSum').textContent = `✓ 已完成 · 用时 ${(m.gen_ms / 1000).toFixed(1)}s · 接口 ${m.tool_calls} 次（Agent ${m.agent_tool_calls}）· 点此展开生成过程`;
          prog.open = false;
          state.run = ev.run;
          Object.assign(state, { editing: null, inline: null, adding: null, issueIdx: -1, centerTab: 'draft' });
          render();
          loadRuns();
        }
      }
    }
    if (!ended) throw new Error('与服务器的连接中断，没有收到完成结果');
  } catch (e) {
    const cut = streaming && !ended;
    line(`✗ ${esc(e.message)}${cut ? '。服务端检测到断开后会停止本次生成，不会产出半成品；请稍后刷新左侧历史记录确认，或重新生成。' : ''}`, 'error');
    $('#progSum').textContent = cut ? '连接中断' : '生成失败';
    if (cut) loadRuns();
  } finally {
    btn.disabled = false;
    btn.textContent = '生成复盘底稿';
    $('#runView').classList.remove('stale');
  }
}

// ---------- 主视图 ----------
function primaryAction(run) {
  if (state.role === '投顾' && ['draft', 'returned'].includes(run.status)) {
    return `<button class="primary" data-act="submit" ${run.gate.can_submit && !reviewing() ? '' : 'disabled'}>提交合规审核</button>`;
  }
  if (state.role === '合规' && run.status === 'in_review') return '<button class="primary" data-act="approve">审核通过</button>';
  return '';
}

function render() {
  const run = state.run;
  if (!run) return;
  $('#empty').classList.add('hidden');
  const ed = editable();
  const g = run.gate || {};
  const m = run.metrics || {};
  const cov = run.coverage;
  const acts = [];
  const busy = reviewing();
  if (canEdit()) acts.push(busy ? '<button data-act="ai" class="ghost" disabled><span class="spin"></span> AI 复核中…</button>' : '<button data-act="ai" class="ghost" title="用大模型逐句做语义合规复核，补关键词规则漏掉的隐含预测与变相建议">AI 合规复核</button>');
  if (state.role === '合规' && run.status === 'in_review') acts.push('<button data-act="return" class="ghost danger">退回修改</button>');
  acts.push(primaryAction(run), '<button data-act="copy" class="ghost">复制全文</button>', '<button data-act="export" class="ghost">导出文本</button>');
  let roleHint = '';
  if (run.is_sample) roleHint = '';
  else if (run.status === 'in_review' && state.role === '投顾') roleHint = '已提交，等待合规审核：右上角切换为「合规审核」角色可继续体验审批。';
  else if (['draft', 'returned'].includes(run.status) && state.role === '合规') roleHint = '当前为草稿，需投资顾问提交后才能审核；你可以先打开「规则库」维护禁用表述。';
  else if (run.status === 'approved') roleHint = '已审核通过，定稿在页面底部，可直接复制发布。';
  const why = busy ? '<div class="gate-why busy"><span class="spin"></span> AI 正在逐句做语义合规复核（通常几秒到半分钟），期间暂停编辑与提交；完成后提示会挂在对应句子下面，由你决定是否修改。</div>' : ed && !g.can_submit ? `<div class="gate-why">还差 ${g.block ? `<a data-jump="block">${g.block} 个阻断项</a>` : ''}${g.block && g.pending_unresolved ? '、' : ''}${g.pending_unresolved ? `<a data-jump="pending">${g.pending_unresolved} 条待确认</a>` : ''}，处理完才能提交合规审核。</div>` : '';
  const hs = run.agent?.hypotheses || [];
  const hProblems = hs.filter((h) => h.problems?.length).length;
  const agentRounds = (run.agent?.steps || []).filter((s) => s.tool_calls.length).length;

  $('#runView').innerHTML = `
  <div class="card run-head" id="runHead">
    <div class="title-row">
      <h2>${esc(plain(run.draft.title, run))}</h2>
      <span class="st st-${esc(run.status)}">${STATUS[run.status] || esc(run.status)}</span>
      ${run.is_sample ? '<span class="tag">真实数据样例</span>' : ''}
    </div>
    <div class="meta">交易日 ${esc(run.trading.date)} · ${esc(AUD[run.input.audience] || '')} · 生成于 ${fmtTime(run.created_at)} · 用时 ${((m.gen_ms || 0) / 1000).toFixed(1)}s · 接口 ${m.tool_calls} 次（Agent ${m.agent_tool_calls}）· 大模型 ${m.llm_calls} 次 · 事实 ${m.facts} 条 / 证据 ${m.evidence} 条
    ${run.input.simulate?.length ? `<br><span class="tag warn">故障演练：${run.input.simulate.map((s) => SIM[s] || esc(s)).join('、')}</span>` : ''}
    ${run.repair?.attempted ? `<br><span class="tag ok">自动修复：${run.repair.attempted} 句未通过校验 → 修好 ${run.repair.fixed}、删除 ${run.repair.deleted}、未修好 ${run.repair.failed}（未修好的保留原句交人工）</span>` : ''}
    ${run.writer?.fallback ? `<br><span class="tag warn">大模型撰写失败（${esc(run.writer.error)}），已降级为纯数据底稿</span>` : ''}</div>
    <div class="gate">
      <button class="g ${g.block ? 'bad' : 'good'}" data-jump="block" title="点击定位"><b>${g.block}</b>阻断项</button>
      <button class="g ${g.pending_unresolved ? 'warnc' : 'good'}" data-jump="pending" title="点击定位"><b>${g.pending_unresolved}</b>待确认未处理</button>
      <button class="g ${g.warn ? 'warnc' : ''}" data-jump="warn" title="点击定位"><b>${g.warn}</b>提醒</button>
      <div class="g"><b>${Math.round((g.sourced_ratio || 0) * 100)}%</b>句子有依据</div>
      <button class="g ${run.gaps.length ? 'warnc' : 'good'}" data-side="dq" title="查看数据质量"><b>${run.gaps.length}</b>数据缺失</button>
      ${cov ? `<div class="g ${cov.missed.length ? 'warnc' : 'good'}" title="${esc(cov.missed.map((x) => `未提及：${x.hint}`).join('\n') || '关键事实清单全部覆盖')}"><b>${cov.covered}/${cov.applicable}</b>关键事实覆盖</div>` : ''}
      <div class="acts">${acts.join('')}</div>
    </div>
    ${run.is_sample ? '<div class="sample-bar">这是所有人共享的真实数据样例，为只读。想体验修改、确认与审批流程，请先 <button class="primary mini" data-act="clone">复制一份自己用</button></div>' : why}
    ${roleHint ? `<div class="hint">${roleHint}</div>` : ''}
    ${cov?.missed.length ? `<div class="hint">关键事实提醒（不阻断）：本稿未提及 ${cov.missed.map((x) => `「${esc(x.name)}」（${esc(x.hint)}）`).join('、')}，请确认是否有意省略。</div>` : ''}
    ${run.review ? `<div class="review ${esc(run.review.decision)}">合规意见（${fmtTime(run.review.at)}）：${run.review.decision === 'approve' ? '通过' : '退回'}${run.review.comment ? ` —— ${esc(run.review.comment)}` : ''}</div>` : ''}
  </div>
  <div class="sticky-bar" id="stickyBar">
    <span class="st st-${esc(run.status)}">${STATUS[run.status] || ''}</span>
    <span>阻断 <b class="${g.block ? 'no' : 'ok'}">${g.block}</b> · 待确认 <b>${g.pending_unresolved}</b> · 提醒 <b>${g.warn}</b></span>
    <span class="spacer"></span>
    <button class="mini" data-act="next">下一处问题 ▸</button>
    ${primaryAction(run).replace('class="primary"', 'class="primary mini"')}
  </div>
  <div class="ctabs">
    <button data-ctab="draft" class="${state.centerTab === 'draft' ? 'on' : ''}">复盘稿 <span class="cnt">${g.sentences}</span></button>
    <button data-ctab="hypo" class="${state.centerTab === 'hypo' ? 'on' : ''}">主线判断 <span class="cnt">${hs.length}</span>${hProblems ? `<span class="dot" title="${hProblems} 条判断有问题"></span>` : ''}</button>
    <button data-ctab="agent" class="${state.centerTab === 'agent' ? 'on' : ''}">Agent 调查过程 <span class="cnt">${agentRounds} 轮</span></button>
    <span class="spacer"></span>
    <button class="mini ghost" data-act="next" title="依次定位阻断项、待确认句和提醒">下一处问题 ▸</button>
  </div>
  <div id="centerBody">${state.centerTab === 'hypo' ? renderHypotheses(run) : state.centerTab === 'agent' ? renderAgent(run) : renderDraft(run, ed)}</div>`;
  bindRun(run, ed);
  renderSide();
}

function renderDraft(run, ed) {
  return `${run.draft.sections.map((sec) => `
    <div class="card section">
      <h3>${esc(sec.heading)}</h3>
      ${sec.sentences.length ? sec.sentences.map((s) => renderSentence(s, run, ed)).join('') : '<p class="hint">本节没有内容</p>'}
      ${ed ? (state.adding === sec.id ? addForm(sec) : `<button class="mini add" data-add="${esc(sec.id)}">＋ 人工补充一句</button>`) : ''}
    </div>`).join('')}
  ${run.final_text ? `<div class="card final"><h3>定稿（可直接发布）</h3><pre>${esc(run.final_text)}</pre><button data-act="copyFinal" class="primary">复制定稿</button></div>` : ''}
  <div class="card legend">
    <span class="badge t-fact">事实</span> 只复述底稿数据 · <span class="badge t-inf">推断</span> 有依据且带不确定措辞 · <span class="badge t-pend">待确认</span> 缺失/冲突需人工确认 ·
    <span class="tag sys">系统</span> 数据缺失说明，不可删改 · <span class="chip">蓝色数字</span> 由系统按原始字段渲染，点击查看来源与被哪些句子引用
  </div>`;
}

function addForm(sec) {
  return `<div class="inline-form add-form" data-sec="${esc(sec.id)}">
    <textarea id="addText" placeholder="补充一句。数字请用 {{F编号}} 引用事实底稿，推断的依据可插入 {{E编号}}（点击右侧编号即可插入），日期写 {{DATE}}"></textarea>
    <div class="row"><select id="addType">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select>
    <button class="primary mini" data-addsave="${esc(sec.id)}">添加并校验</button><button class="mini" data-addcancel>取消</button></div>
  </div>`;
}

function renderHypotheses(run) {
  const hs = run.agent?.hypotheses || [];
  if (!hs.length) return `<div class="card"><p class="hint">${run.agent?.error ? `Agent 未执行：${esc(run.agent.error)}；本稿没有主线判断。` : '本稿没有主线判断（Agent 未给出或为早期版本生成的记录）。'}</p></div>`;
  const V = { 支持: 'v-yes', 部分支持: 'v-part', 不支持: 'v-no', 存疑: 'v-q' };
  return `<div class="card hypo"><h3>主线判断依据 <span class="sub">Agent 先提出判断，再找支持和反面证据；系统核对编号真实存在，证据不足的判断降为"存疑"。撰写只能按这里的结论落笔。</span></h3>
    <div class="tbl"><table><thead><tr><th>判断</th><th>结论</th><th>支持证据</th><th>反证</th><th>待补证据</th></tr></thead><tbody>
    ${hs.map((h) => `<tr><td>${esc(h.claim)}${h.problems?.length ? `<div class="flag warn">${esc(h.problems.join('；'))}</div>` : ''}</td>
      <td><span class="verdict ${V[h.verdict] || ''}">${esc(h.verdict)}</span></td>
      <td>${h.support.map((r) => refChip(r, run)).join(' ') || '—'}</td>
      <td>${h.against.map((r) => refChip(r, run)).join(' ') || '—'}</td>
      <td>${esc(h.gap || '—')}</td></tr>`).join('')}
    </tbody></table></div>
    ${run.agent?.notes ? `<p class="hint">Agent 小结：${esc(run.agent.notes)}</p>` : ''}</div>`;
}

function renderAgent(run) {
  const a = run.agent || {};
  if (!a.used) return `<div class="card"><p class="hint">${a.error ? `Agent 未执行：${esc(a.error)}；本稿只使用基础数据。` : '本稿未使用 Agent。'}</p></div>`;
  return `<div class="card agent-box"><h3>Agent 调查过程 <span class="sub">每一轮的判断、调用的工具、参数与返回摘要</span></h3>
    ${a.steps.map((s) => `<div class="astep"><div><span class="tag agent">第${s.round}轮</span> ${esc(s.thought || '').replace(/\n/g, '<br>')}</div>
      ${s.tool_calls.map((t) => `<div class="tc"><code>${esc(t.name)}(${esc(JSON.stringify(t.args))})</code><pre>${esc(t.result)}</pre></div>`).join('')}</div>`).join('')}
  </div>`;
}

function refChip(id, run) {
  if (!ID_RE.test(id)) return '';
  const f = run.facts.find((x) => x.id === id);
  const e = run.evidence.find((x) => x.id === id);
  const tip = f ? `${f.label}：${f.display}` : e ? `${e.stock || e.kind}：${e.text.slice(0, 80)}` : id;
  return `<span class="ref" data-ref="${id}" title="${esc(tip)}">${id}${f ? ` ${esc(f.display)}` : ''}</span>`;
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
const flagHtml = (f) => `<div class="flag ${esc(f.level)}">${f.level === 'block' ? '阻断' : '提醒'}｜${esc(f.msg)}${f.fix ? `<span class="fix">建议：${esc(f.fix)}</span>` : ''}</div>`;

function renderSentence(s, run, ed) {
  const [tl, tc] = TYPE[s.type] || ['?', ''];
  if (state.editing === s.id) {
    return `<div class="sent editing" data-sid="${esc(s.id)}">
      <textarea id="editText">${esc(s.text)}</textarea>
      <div class="preview"><span class="sub">预览：</span><span id="editPreview">${renderRich(s.text, run, { showEvidence: true })}</span></div>
      <div id="editFlags">${(s.flags || []).map(flagHtml).join('')}</div>
      <div class="hint">数字请用 {{F编号}} 引用，推断的依据可插入 {{E编号}}（点击右侧编号即可插入到光标处），日期用 {{DATE}}。边写边校验；Ctrl/⌘ + Enter 保存，Esc 取消。</div>
      <div class="row"><select id="editType">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      <button class="primary mini" data-edit="save">保存并校验</button><button class="mini" data-edit="cancel">取消</button></div>
    </div>`;
  }
  const flags = s.deleted ? '' : (s.flags || []).map(flagHtml).join('');
  const ai = s.deleted ? '' : (s.ai_flags || []).filter((f) => !f.dismissed).map((f) => `<div class="flag ai">AI 复核｜${esc(f.category)}：${esc(f.reason)}${f.suggestion ? `<span class="fix">改写建议：${esc(f.suggestion)}</span>` : ''}</div>`).join('');
  const refs = (s.refs || []).filter((r) => /^E\d+$/.test(r)).map((r) => `<span class="ref" data-ref="${r}">${r}</span>`).join('');
  const fb = (run.feedback || []).filter((f) => f.sid === s.id).slice(-1)[0];
  const inline = state.inline?.sid === s.id ? inlineForm(state.inline.kind) : '';
  return `<div class="sent ${s.deleted ? 'deleted' : ''} ${(s.flags || []).some((f) => f.level === 'block') && !s.deleted ? 'has-block' : ''}" data-sid="${esc(s.id)}">
    <div class="line"><span class="badge ${tc}">${tl}</span>${s.origin === 'human' ? '<span class="tag">人工</span>' : s.origin === 'injected' ? '<span class="tag warn">注入</span>' : s.origin === 'system' ? '<span class="tag sys" title="系统根据数据缺失或核验结果自动追加，不能删除或改写；核实后点「确认保留」">系统</span>' : ''}${s.edited ? '<span class="tag">已改</span>' : ''}${s.deleted && s.dedup ? `<span class="tag" title="与系统追加的「${esc(s.dedup)}」说明重复">与系统说明重复，已自动删除</span>` : ''}
      ${repairTag(s)}<span class="txt">${renderRich(s.text, run)}</span>${refs}</div>
    ${repairDetail(s, run)}
    ${flags}${ai}
    ${s.type === 'pending' && s.pending_confirmed ? `<div class="flag ok">已人工确认保留${s.note ? `：${esc(s.note)}` : ''}</div>` : ''}
    ${inline}
    <div class="ops">
      ${ed && !s.deleted && !s.locked ? '<button class="mini" data-op="edit">编辑</button>' : ''}
      ${ed && s.type === 'pending' && !s.pending_confirmed && !s.deleted ? '<button class="mini" data-op="confirm">确认保留</button>' : ''}
      ${ed && (s.ai_flags || []).some((f) => !f.dismissed) ? '<button class="mini" data-op="dismiss">忽略 AI 提示</button>' : ''}
      ${ed && !s.locked ? `<button class="mini" data-op="${s.deleted ? 'restore' : 'delete'}">${s.deleted ? '恢复' : '删除'}</button>` : ''}
      ${!s.deleted && !run.is_sample ? `<button class="mini fb ${fb?.rating === 'up' ? 'on' : ''}" data-op="up" title="这句有用">👍</button><button class="mini fb ${fb?.rating === 'down' ? 'on' : ''}" data-op="down" title="这句有问题">👎${fb?.rating === 'down' && fb.reason ? ` ${esc(fb.reason)}` : ''}</button>` : ''}
    </div>
  </div>`;
}

function inlineForm(kind) {
  if (kind === 'confirm') {
    return `<div class="inline-form"><span class="sub">确认保留这条“待确认”说明：</span><input id="ifNote" maxlength="200" placeholder="核实备注（可选），如：已核对公司公告原文">
      <button class="primary mini" data-if="confirm">确认保留</button><button class="mini" data-if="cancel">取消</button></div>`;
  }
  return `<div class="inline-form"><span class="sub">这句的问题：</span>${REASONS.map((r) => `<button class="mini chipbtn" data-reason="${r}">${r}</button>`).join('')}
    <input id="ifOther" maxlength="40" placeholder="其他（可选）"><button class="primary mini" data-if="down">提交反馈</button><button class="mini" data-if="cancel">取消</button></div>`;
}

// ---------- 交互绑定 ----------
function bindRun(run, ed) {
  const upd = async (p, body, method = 'PATCH', keep = {}) => {
    try {
      const next = await api(`/api/runs/${run.id}${p}`, { method, body });
      // 请求期间用户已打开别的记录：只刷新列表，不把视图拉回原记录
      if (state.run?.id !== run.id) { loadRuns(); return true; }
      state.run = next;
      Object.assign(state, { editing: null, inline: null, adding: null, ...keep });
      render();
      loadRuns();
      return true;
    } catch (e) {
      toast(e.message, true);
      // 失败时（如提交被门禁拒绝）服务端可能已按最新规则重算了校验结果，重新拉取以免页面显示过期状态
      try { const cur = await api(`/api/runs/${run.id}`); if (state.run?.id === run.id) { state.run = cur; render(); } } catch { /* 保持当前视图 */ }
      return false;
    }
  };
  const root = $('#runView');
  $$('.chip[data-ref], .ref[data-ref]', root).forEach((c) => c.onclick = (e) => { e.stopPropagation(); showPop(c, c.dataset.ref); });
  $$('[data-jump]', root).forEach((b) => b.onclick = () => jumpTo(b.dataset.jump));
  $$('[data-side]', root).forEach((b) => b.onclick = () => { state.tab = b.dataset.side; renderSide(); $('.right').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $$('[data-ctab]', root).forEach((b) => b.onclick = () => { state.centerTab = b.dataset.ctab; state.editing = null; render(); });

  $$('.sent[data-sid]', root).forEach((el) => {
    const sid = el.dataset.sid;
    $$('[data-op]', el).forEach((b) => b.onclick = () => {
      const op = b.dataset.op;
      if (op === 'edit') { state.editing = sid; state.inline = null; render(); const ta = $('#editText'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
      else if (op === 'confirm' || op === 'down') { state.inline = state.inline?.sid === sid && state.inline.kind === op ? null : { sid, kind: op }; render(); $('#ifNote, #ifOther')?.focus(); }
      else if (op === 'delete' || op === 'restore') upd(`/sentences/${sid}`, { action: op, actor: state.role });
      else if (op === 'dismiss') upd(`/sentences/${sid}`, { action: 'dismiss_ai', actor: state.role });
      else if (op === 'up') upd('/feedback', { sid, rating: 'up' }, 'POST');
    });
    $$('.chipbtn', el).forEach((c) => c.onclick = () => c.classList.toggle('on'));
    $$('[data-if]', el).forEach((b) => b.onclick = () => {
      const k = b.dataset.if;
      if (k === 'cancel') { state.inline = null; render(); }
      else if (k === 'confirm') upd(`/sentences/${sid}`, { action: 'confirm_pending', note: $('#ifNote')?.value || '', actor: state.role });
      else if (k === 'down') {
        const reasons = $$('.chipbtn.on', el).map((c) => c.dataset.reason);
        const other = ($('#ifOther')?.value || '').trim();
        const reason = [...reasons, other].filter(Boolean).join('、').slice(0, 40);
        upd('/feedback', { sid, rating: 'down', reason }, 'POST');
      }
    });
  });

  // 编辑器：实时预览 + 实时校验 + 快捷键
  const ta = $('#editText');
  if (ta) {
    let timer;
    const preview = () => {
      $('#editPreview').innerHTML = renderRich(ta.value, run, { showEvidence: true });
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const r = await api(`/api/runs/${run.id}/preview`, { method: 'POST', body: { text: ta.value, type: $('#editType').value } });
          const box = $('#editFlags');
          if (box) box.innerHTML = r.flags.length ? r.flags.map(flagHtml).join('') : '<div class="flag ok">校验通过：没有发现问题</div>';
        } catch { /* 预览失败不影响编辑 */ }
      }, 350);
    };
    const save = () => upd(`/sentences/${state.editing}`, { text: ta.value, type: $('#editType').value, actor: state.role });
    ta.oninput = preview;
    $('#editType').onchange = preview;
    ta.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); state.editing = null; render(); }
    };
    $('[data-edit="save"]').onclick = save;
    $('[data-edit="cancel"]').onclick = () => { state.editing = null; render(); };
    preview();
  }

  $$('[data-add]', root).forEach((b) => b.onclick = () => { state.adding = b.dataset.add; render(); $('#addText')?.focus(); });
  $$('[data-addcancel]', root).forEach((b) => b.onclick = () => { state.adding = null; render(); });
  $$('[data-addsave]', root).forEach((b) => b.onclick = () => {
    const text = ($('#addText')?.value || '').trim();
    if (!text) { toast('请先填写要补充的句子', true); return; }
    upd('/sentences', { section_id: b.dataset.addsave, text, type: $('#addType').value, actor: state.role }, 'POST');
  });

  const act = (name) => async () => {
    if (name === 'submit') upd('/submit', { actor: state.role }, 'POST');
    else if (name === 'approve') upd('/review', { decision: 'approve' }, 'POST');
    else if (name === 'return') showReturn(run);
    else if (name === 'ai') {
      state.aiBusy = run.id;
      Object.assign(state, { editing: null, inline: null, adding: null });
      render();
      const ok = await upd('/ai-review', {}, 'POST');
      state.aiBusy = null;
      if (state.run?.id === run.id) {
        render();
        if (ok) toast(state.run.ai_review?.issues ? `AI 复核完成：发现 ${state.run.ai_review.issues} 处疑似问题，已挂在对应句子下面` : 'AI 复核完成：没有发现语义层面的疑似问题');
      }
    } else if (name === 'export') window.open(`/api/runs/${run.id}/export`, '_blank');
    else if (name === 'copy') {
      const text = await fetch(`/api/runs/${run.id}/export`).then((r) => r.text()).catch(() => '');
      if (text) navigator.clipboard.writeText(text).then(() => toast(run.final_text ? '定稿已复制' : '草稿全文已复制（带“未审核”标记）'), () => toast('复制失败，请改用“导出文本”', true));
    } else if (name === 'copyFinal') navigator.clipboard.writeText(run.final_text).then(() => toast('定稿已复制'));
    else if (name === 'next') nextIssue();
    else if (name === 'clone') {
      try {
        const copy = await api(`/api/runs/${run.id}/clone`, { method: 'POST', body: {} });
        state.run = copy;
        Object.assign(state, { editing: null, inline: null, adding: null, issueIdx: -1, centerTab: 'draft' });
        render();
        await loadRuns();
        toast('已复制为你的草稿，可以开始修改、确认和提交');
      } catch (e) { toast(e.message, true); }
    }
  };
  $$('[data-act]', root).forEach((b) => { b.onclick = act(b.dataset.act); });

  // 头部滚出视野后显示吸顶操作栏
  const head = $('#runHead');
  const bar = $('#stickyBar');
  if (window.__headObs) window.__headObs.disconnect();
  if (head && bar && 'IntersectionObserver' in window) {
    window.__headObs = new IntersectionObserver(([e]) => bar.classList.toggle('show', !e.isIntersecting), { rootMargin: '-80px 0px 0px 0px' });
    window.__headObs.observe(head);
  }
}

function flashSentence(sid) {
  const el = $(`.sent[data-sid="${sid}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
  return true;
}
function gotoSentence(sid) {
  if (state.centerTab !== 'draft') { state.centerTab = 'draft'; render(); }
  setTimeout(() => flashSentence(sid), 30);
}
function jumpTo(kind) {
  const it = issueList(state.run).find((x) => x.kind === kind);
  if (!it) { toast(kind === 'block' ? '没有阻断项' : kind === 'pending' ? '没有未处理的待确认句' : '没有提醒'); return; }
  gotoSentence(it.sid);
}
function nextIssue() {
  const list = issueList(state.run);
  if (!list.length) { toast('没有待处理的问题，可以提交了'); return; }
  state.issueIdx = (state.issueIdx + 1) % list.length;
  const it = list[state.issueIdx];
  toast(`第 ${state.issueIdx + 1}/${list.length} 处：${it.kind === 'block' ? '阻断项' : it.kind === 'pending' ? '待确认' : '提醒'}`);
  gotoSentence(it.sid);
}

// ---------- 来源卡片（点数字即看出处与被引用情况） ----------
function closePop() { $('#pop')?.remove(); }
function showPop(anchor, id) {
  closePop();
  const run = state.run;
  const f = run.facts.find((x) => x.id === id);
  const e = run.evidence.find((x) => x.id === id);
  if (!f && !e) return;
  const used = usageMap(run).get(id) || [];
  const usedHtml = used.length ? `被引用：${used.map((sid) => `<a data-goto="${esc(sid)}">${esc(sid)}</a>`).join(' ')}` : '<span class="sub">正文暂未引用</span>';
  const link = e ? safeUrl(e.link) : null;
  const body = f
    ? `<div><b>${esc(f.id)}</b> ${esc(f.label)}</div><div class="pv">${esc(f.display)}</div>
       <div class="sub">字段：${esc(f.field)}</div><div class="sub">时点：${esc(f.as_of)}</div><div class="sub">口径：${esc(f.caliber || '—')}</div>
       <div class="sub">来源：${esc(f.source || '')} <code>${esc(f.endpoint || '')}</code> · 调用 ${esc(f.call_id || '')} · request_id ${esc((f.request_id || '').slice(0, 12))}</div>
       ${f.members ? `<div class="sub">成员：${esc(f.members.slice(0, 15).join('、'))}</div>` : ''}`
    : `<div><b>${esc(e.id)}</b> ${esc(e.stock || '')} ${e.tag ? `<span class="tag">${esc(e.tag)}</span>` : ''} <span class="sub">${esc(e.kind || '')}</span></div>
       <div class="evtext">${esc(e.text)}</div><div class="sub">来源：${esc(e.source || '')}${e.time ? ` · ${esc(e.time)}` : ''}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">原文</a>` : ''}</div>`;
  const pop = document.createElement('div');
  pop.id = 'pop';
  pop.className = 'pop';
  pop.innerHTML = `${body}<div class="pop-foot">${usedHtml}${(state.editing || state.adding) && $('#editText, #addText') ? ` <button class="mini primary" data-insert="${esc(id)}">插入到编辑中</button>` : ''}<button class="mini" data-showside>在事实底稿中查看</button></div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = Math.min(420, window.innerWidth - 24);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 12))}px`;
  pop.style.top = `${r.bottom + window.scrollY + 6}px`;
  $$('[data-goto]', pop).forEach((a) => a.onclick = () => { closePop(); gotoSentence(a.dataset.goto); });
  $('[data-insert]', pop)?.addEventListener('click', () => { insertRef(id); closePop(); });
  $('[data-showside]', pop).onclick = () => { closePop(); focusRef(id); };
}
document.addEventListener('click', (e) => { if ($('#pop') && !e.target.closest('#pop')) closePop(); });

function insertRef(id) {
  const ta = $('#editText') || $('#addText');
  if (!ta) return false;
  const pos = ta.selectionStart ?? ta.value.length;
  ta.value = `${ta.value.slice(0, pos)}{{${id}}}${ta.value.slice(pos)}`;
  ta.focus();
  ta.setSelectionRange(pos + id.length + 4, pos + id.length + 4);
  ta.dispatchEvent(new Event('input'));
  return true;
}
function focusRef(id) {
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
    // 搜索框只创建一次、之后只刷新结果列表：整块重绘会打断中文输入法的拼写（composition）
    if (P.dataset.view !== 'facts' || !$('#factFilter', P)) {
      P.innerHTML = '<input id="factFilter" class="filter" placeholder="搜索编号、名称或数值，如：涨停、F12、新华传媒"><div id="factList"></div>';
      const fi = $('#factFilter', P);
      fi.value = state.factFilter;
      const update = () => { state.factFilter = fi.value; renderFactList(); };
      fi.addEventListener('input', (e) => { if (!e.isComposing) update(); });
      fi.addEventListener('compositionend', update);
    }
    P.dataset.view = 'facts';
    renderFactList();
    return;
  }
  P.dataset.view = state.tab;
  if (state.tab === 'dq') {
    const t = run.trading;
    P.innerHTML = `<div class="fact"><b>交易日校验</b><div class="sub">所选：${esc(t.date)}；最近已收盘交易日：${esc(t.latestClosed)}；生成时：${esc(t.now)}</div>
      <div class="sub">行情快照是否等于所选日收盘口径：${t.snapshotIsDateClose ? '是（全市场涨跌家数可用）' : '否（涨跌家数不出具）'}</div></div>
      <h4>数据缺失（${run.gaps.length}）</h4>${run.gaps.map((g) => `<div class="flag warn"><b>${esc(g.title)}</b>：${esc(g.reason)}</div>`).join('') || '<p class="hint">无缺失</p>'}
      <h4>交叉核验与提示（${run.dq.length}）</h4>${run.dq.map((d) => `<div class="flag ${d.level === 'error' ? 'block' : d.level === 'warn' ? 'warn' : 'ok'}"><b>${esc(d.title)}</b>：${esc(d.detail)}</div>`).join('') || '<p class="hint">涨停池与统计家数、炸板池与炸板家数、天梯与最高板等交叉核验均一致</p>'}
      ${run.coverage ? `<h4>关键事实覆盖（${run.coverage.covered}/${run.coverage.applicable}）</h4>${run.coverage.items.map((x) => `<div class="sub">${x.status === 'covered' ? '<span class="ok">✓</span>' : x.status === 'missed' ? '<span class="no">✗</span>' : '–'} ${esc(x.name)}${x.status === 'na' ? '（当日无此数据）' : ''}</div>`).join('')}` : ''}
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

function renderFactList() {
  const run = state.run;
  const box = $('#factList');
  if (!run || !box) return;
  const used = usageMap(run);
  const q = state.factFilter.trim().toLowerCase();
  const match = (x) => !q || `${x.id} ${x.label || ''} ${x.display || ''} ${x.stock || ''} ${x.tag || ''} ${x.text || ''}`.toLowerCase().includes(q);
  const facts = run.facts.filter(match);
  const evs = run.evidence.filter(match);
  const usedTag = (id) => {
    const u = used.get(id) || [];
    return u.length ? `<span class="sub">被引用 ${u.map((sid) => `<a data-goto="${esc(sid)}">${esc(sid)}</a>`).join(' ')}</span>` : '<span class="tag">正文未引用</span>';
  };
  const editingNow = (state.editing || state.adding) && $('#editText, #addText');
  box.innerHTML = `<p class="hint">${editingNow ? '正在编辑：点击编号可插入到光标处（F 为数字，E 为文本证据）。' : '点击编号可定位到引用它的句子。'}${q ? `匹配 ${facts.length} 条数字事实、${evs.length} 条文本证据。` : `共 ${run.facts.length} 条数字事实、${run.evidence.length} 条文本证据；系统计算的派生值已注明公式。`}</p>
    ${facts.map((f) => `<div class="fact" id="ref-${esc(f.id)}">
      <div><button class="idbtn" data-ins="${esc(f.id)}">${esc(f.id)}</button> <b>${esc(f.label)}</b> = <span class="chip">${esc(f.display)}</span> ${usedTag(f.id)}</div>
      <div class="sub">字段：${esc(f.field)} · 时点：${esc(f.as_of)}</div>
      <div class="sub">口径：${esc(f.caliber || '—')}</div>
      <div class="sub">来源：${esc(f.source)} <code>${esc(f.endpoint || '')}</code> · 调用 ${esc(f.call_id || '')} · request_id ${esc((f.request_id || '').slice(0, 12))}</div>
      ${f.members ? `<div class="sub">成员：${esc(f.members.slice(0, 15).join('、'))}</div>` : ''}
    </div>`).join('') || '<p class="hint">没有匹配的数字事实</p>'}
    <h4>文本证据</h4>
    ${evs.map((e) => { const link = safeUrl(e.link); return `<div class="fact" id="ref-${esc(e.id)}"><div><button class="idbtn" data-ins="${esc(e.id)}">${esc(e.id)}</button> ${esc(e.stock || '')} ${e.tag ? `<span class="tag">${esc(e.tag)}</span>` : ''} <span class="sub">${esc(e.kind)}</span> ${usedTag(e.id)}</div>
      <div class="evtext">${esc(e.text)}</div>
      <div class="sub">来源：${esc(e.source)}${e.time ? ` · ${esc(e.time)}` : ''}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">原文</a>` : ''}</div></div>`; }).join('') || '<p class="hint">没有匹配的文本证据</p>'}`;
  $$('.idbtn', box).forEach((b) => b.onclick = () => {
    const id = b.dataset.ins;
    if (insertRef(id)) return;
    const u = used.get(id) || [];
    if (u.length) gotoSentence(u[0]); else toast('正文暂未引用这一条');
  });
  $$('[data-goto]', box).forEach((a) => a.onclick = () => gotoSentence(a.dataset.goto));
}

// ---------- 弹窗 ----------
function modal(html) { $('#modalContent').innerHTML = html; $('#modal').classList.remove('hidden'); $('#modal .close').focus(); }
const closeModal = () => $('#modal').classList.add('hidden');
$('#modal .close').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#pop')) { closePop(); return; }
  if (!$('#modal').classList.contains('hidden')) closeModal();
});

function showReturn(run) {
  modal(`<h2>退回修改</h2>
  <p class="hint">写清需要投顾修改的地方。退回后草稿回到可编辑状态，投顾修改后可以再次提交。</p>
  <textarea id="retComment" class="ret" maxlength="300" placeholder="退回意见（必填），如：第三节“板块龙头”表述易被理解为推荐，请改为中性描述"></textarea>
  <label class="ret-rule"><input type="checkbox" id="retRuleOn"> 同时把问题表述加入规则库（之后所有草稿都会校验、生成时会主动避开）</label>
  <div class="row form"><input id="retPhrase" maxlength="30" placeholder="问题表述，如：板块龙头" disabled><select id="retLevel" disabled><option value="block">阻断</option><option value="warn">提醒</option></select></div>
  <div class="row"><button class="primary" id="retOk">确认退回</button><button id="retCancel">取消</button></div>`);
  $('#retRuleOn').onchange = (e) => { $('#retPhrase').disabled = !e.target.checked; $('#retLevel').disabled = !e.target.checked; if (e.target.checked) $('#retPhrase').focus(); };
  $('#retCancel').onclick = closeModal;
  $('#retComment').focus();
  $('#retOk').onclick = async () => {
    const comment = $('#retComment').value.trim();
    if (!comment) { toast('请填写退回意见', true); $('#retComment').focus(); return; }
    try {
      if ($('#retRuleOn').checked && $('#retPhrase').value.trim()) {
        await api('/api/config/rules', { method: 'POST', body: { phrase: $('#retPhrase').value.trim(), level: $('#retLevel').value, reason: `合规退回：${comment.slice(0, 40)}`, actor: '合规' } })
          .catch((err) => { if (!/已在规则库/.test(err.message)) throw err; });
      }
      await api(`/api/runs/${run.id}/review`, { method: 'POST', body: { decision: 'return', comment } });
      // 退回后草稿回到可编辑状态；重新拉取一次，让刚加入规则库的表述立即参与校验
      state.run = await api(`/api/runs/${run.id}`);
      closeModal();
      Object.assign(state, { editing: null, inline: null, adding: null });
      render();
      loadRuns();
      toast('已退回，投顾修改后可再次提交');
    } catch (err) { toast(err.message, true); }
  };
}

async function showMetrics() {
  let m;
  try { m = await api('/api/metrics'); } catch (e) { toast(e.message, true); return; }
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
    ${card(esc(Object.entries(m.initial_flags).map(([k, v]) => `${k}:${v}`).join(' ')) || '0', '生成时拦截的问题', '按规则统计：未溯源数字、预测、荐股、收益承诺等')}
    ${card(m.repair ? `${m.repair.fixed}/${m.repair.attempted}` : '—', 'AI 自修复（修好/尝试）', m.repair ? `阻断项：自修复前 ${m.blocks_before_repair} → 自修复后 ${m.blocks_after_repair}；删除 ${m.repair.deleted} 句；修不好的保留原句交人工` : '')}
  </div>
  <h4>人机协作</h4><div class="mgrid">
    ${card(`${m.submitted}/${m.approved}`, '已提交/已通过', '提交前必须清零阻断项')}
    ${card(m.first_pass_approval == null ? '—' : pct(m.first_pass_approval), '合规一次通过率', '通过且从未被退回 ÷ 通过数')}
    ${card(pct(m.edit_rate), 'AI 句子修改率', `已提交稿件中被人修改的 AI 句子比例；删除率 ${pct(m.delete_rate)}，人工新增 ${m.human_added} 句`)}
    ${card(`${m.feedback_up}/${m.feedback_down}`, '逐句反馈 👍/👎', esc(Object.entries(m.feedback_down_reasons).map(([k, v]) => `${k}×${v}`).join('，')) || '暂无差评原因')}
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
  ['搭配错误', '阻断', '"收于／报"后面只能接点位，不能接涨跌幅'],
  ['事实或推断没有依据编号', '阻断', '每句都要回到底稿'],
  ['夸张或煽动性措辞', '提醒', '如"暴涨""妖股""千载难逢"'],
  ['推断缺少不确定措辞 / 事实句夹带判断', '提醒', '避免把推断读成结论'],
];
async function showRules() {
  let cfg;
  try { cfg = await api('/api/config'); } catch (e) { toast(e.message, true); return; }
  const isComp = state.role === '合规';
  const fmt = (ms) => (ms ? new Date(ms).toLocaleDateString('zh-CN') : '');
  modal(`<h2>规则库与写作偏好</h2>
  <p class="hint">反馈闭环：合规把退回原因沉淀为禁用表述，投顾把反复修改的写法沉淀为写作偏好。新增后立即作用于所有草稿的校验（打开草稿时按最新规则重算），并写进之后每次生成的撰写提示词，从源头减少同类问题。</p>
  <h4>内置合规规则（代码维护）</h4>
  <div class="tbl"><table><tbody>${BUILTIN.map(([n, l, d]) => `<tr><td>${esc(n)}</td><td><span class="badge ${l === '阻断' ? 'lv-block' : 'lv-warn'}">${l}</span></td><td class="sub">${esc(d)}</td></tr>`).join('')}</tbody></table></div>
  <h4>团队禁用表述（${cfg.rules.length}）</h4>
  <div class="tbl"><table><tbody>${cfg.rules.map((r) => `<tr><td>「${esc(r.phrase)}」</td><td><span class="badge ${r.level === 'warn' ? 'lv-warn' : 'lv-block'}">${r.level === 'warn' ? '提醒' : '阻断'}</span></td><td class="sub">${esc(r.reason || '')} · ${esc(r.created_by || '')} ${fmt(r.created_at)}</td><td>${isComp ? `<button class="mini" data-del-rule="${esc(r.id)}">删除</button>` : ''}</td></tr>`).join('') || '<tr><td class="sub">暂无</td></tr>'}</tbody></table></div>
  ${isComp ? '<div class="row form"><input id="rPhrase" maxlength="30" placeholder="禁用表述，如：确定性机会"><select id="rLevel"><option value="block">阻断</option><option value="warn">提醒</option></select><input id="rReason" maxlength="80" placeholder="原因（可选）"><button class="primary mini" id="rAdd">加入规则库</button></div><p class="hint">共享演示环境：如果规则库被改乱，可以 <button class="mini" id="rReset">恢复默认规则与偏好</button></p>' : '<p class="hint">切换为「合规审核」角色后可以新增或删除禁用表述。</p>'}
  <h4>写作偏好（${cfg.preferences.length}）</h4>
  <div class="tbl"><table><tbody>${cfg.preferences.map((p) => `<tr><td>${esc(p.text)}</td><td class="sub">${esc(p.created_by || '')} ${fmt(p.created_at)}</td><td><button class="mini" data-del-pref="${esc(p.id)}">删除</button></td></tr>`).join('') || '<tr><td class="sub">暂无</td></tr>'}</tbody></table></div>
  <div class="row form"><input id="pText" maxlength="80" placeholder="写作偏好，如：成交额变化放在第一节开头"><button class="primary mini" id="pAdd">添加偏好</button></div>`);
  const after = async () => { if (state.run) { try { state.run = await api(`/api/runs/${state.run.id}`); render(); } catch { /* 记录可能已被清空 */ } } showRules(); };
  const doAct = async (fn) => { try { await fn(); await after(); } catch (e) { toast(e.message, true); } };
  if ($('#rAdd')) $('#rAdd').onclick = () => doAct(() => api('/api/config/rules', { method: 'POST', body: { phrase: $('#rPhrase').value, level: $('#rLevel').value, reason: $('#rReason').value, actor: state.role } }));
  // 恢复默认会清掉所有人新增的规则与偏好：第一次点击只变成确认态
  if ($('#rReset')) $('#rReset').onclick = (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed) doAct(() => api('/api/config/reset', { method: 'POST', body: { actor: state.role } }));
    else { b.dataset.armed = '1'; b.textContent = '确认恢复？再点一次'; b.classList.add('danger'); }
  };
  $$('[data-del-rule]').forEach((b) => b.onclick = () => doAct(() => api(`/api/config/rules/${encodeURIComponent(b.dataset.delRule)}?actor=${encodeURIComponent(state.role)}`, { method: 'DELETE' })));
  $('#pAdd').onclick = () => doAct(() => api('/api/config/preferences', { method: 'POST', body: { text: $('#pText').value, actor: state.role } }));
  $$('[data-del-pref]').forEach((b) => b.onclick = () => doAct(() => api(`/api/config/preferences/${encodeURIComponent(b.dataset.delPref)}`, { method: 'DELETE' })));
}

function showAbout() {
  modal(`<h2>产品说明</h2>
  <p><b>给谁用：</b>券商/投顾机构的持牌投资顾问（每个交易日收盘后要给客户群写复盘），以及审核这些内容的合规岗。</p>
  <p><b>解决什么：</b>人工复盘要在多个页面间收集指数、涨跌停、连板、题材、异动原因，再手写、自查数字、送合规，耗时且容易出现抄错数字、口径不清、无依据归因和“明日看涨”式违规表述。</p>
  <p><b>AI 做什么：</b>① Agent 根据当天盘面判断主线，自主决定查哪些个股异动原因、哪些板块指数和新闻，把结论写成"判断 + 支持证据 + 反证 + 待补"；② 把十几类结构化数据和文本证据组织成可读的复盘稿，写出与前一交易日的变化，并区分事实、推断、待确认；③ 自修复：没通过校验的句子带着错误原因重写一轮，重新通过校验才采用；④ 语义层合规复核，补关键词规则漏掉的隐含预测和变相建议。</p>
  <p><b>反馈闭环：</b>合规把退回原因沉淀进「规则库」（退回时可一步加入），投顾把常改的写法沉淀为写作偏好；新增后立即作用于所有草稿的校验，并写进之后每次生成的提示词。</p>
  <p><b>不让 AI 做什么：</b>不让它生成数字（数字由系统按原始字段渲染）、不让它决定是否发布（需投顾提交 + 合规通过）、不让它在数据缺失时“补全”：缺失或核验异常由系统自动写成带「系统」标记的待确认句，不能删改，核实后确认保留才能提交。</p>
  <p><b>不做什么（非目标）：</b>不预测涨跌、不推荐个股、不面向散户直接输出、不替代合规审核。</p>
  <p><b>快速上手：</b>点门禁面板里的数字可直接定位问题句；「下一处问题」依次跳转；点正文蓝色数字可看来源和被引用情况；编辑时边写边校验，Ctrl/⌘ + Enter 保存。</p>
  <p class="hint">完整的问题定义、指标口径、失败条件与验证计划见代码仓库 README。</p>`);
}

// ---------- 初始化 ----------
$$('.role button').forEach((b) => b.onclick = () => {
  if (state.role === b.dataset.role) return;
  state.role = b.dataset.role;
  $$('.role button').forEach((x) => x.classList.toggle('on', x === b));
  Object.assign(state, { editing: null, inline: null, adding: null });
  toast(ROLE_TIP[state.role]);
  render();
});
$$('.tabs button').forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; renderSide(); });
$('#btnRun').onclick = startRun;
const syncHeader = () => document.documentElement.style.setProperty('--hdr', `${$('.top').offsetHeight}px`);
window.addEventListener('resize', syncHeader);
syncHeader();
$('#btnMetrics').onclick = showMetrics;
$('#btnAbout').onclick = showAbout;
$('#btnRules').onclick = showRules;
$('#btnEval').onclick = showEval;
(async () => {
  try {
    const td = await api('/api/trading-date');
    $('#date').value = td.latestClosed;
    $('#date').max = td.latestClosed;
    if (td.calendar?.first) $('#date').min = td.calendar.first;
    $('#dateHint').textContent = `最近已收盘交易日 ${td.latestClosed}；当前 ${td.now}。可选 ${td.calendar?.first || '近一年'} 以来的任一交易日。`;
  } catch (e) {
    $('#dateHint').textContent = `交易日历读取失败：${e.message}（生成时会再次校验）`;
  }
  loadRuns();
})();
