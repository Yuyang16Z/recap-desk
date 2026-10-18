// server.js 接口级测试（离线）：把 server.js + lib/ 复制到临时目录启动，
// 隔离 data/runtime、不读取 .env.local，所有上游地址指向 127.0.0.1:9，确保不会访问真实接口。
import { test, before, after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FactSheet } from '../lib/collect.js';
import { templateDraft } from '../lib/pipeline.js';
import { verifyDraft } from '../lib/verify.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = 'unit0001';
let dir;
let child;
let base;
// 本地模拟的大模型接口（OpenAI 兼容）：llmMode 控制返回正常结果还是 500
let llm;
let llmMode = 'ok';

function fakeRun() {
  const sheet = new FactSheet();
  const c = { id: 'T1', path: '/api/test', request_id: 'r1' };
  const f = (label, display) => sheet.fact(c, { label, display, value: 0 });
  const b = { td: { date: '2026-10-16' }, ids: { index: { '000001.SH': { name: '上证指数', close: f('上证指数收盘点位', '3716.28点'), pct: f('上证指数涨跌幅', '上涨0.24%') } }, limit: { up: f('涨停家数', '59家'), open: f('炸板家数', '49家') }, leaders: [], themes: [], hot: [], breadth: {} } };
  sheet.gap({ section: 'limit', title: '跌停股票池', reason: '接口调用失败（code=5003）' });
  const draft = templateDraft(sheet, b);
  const gate = verifyDraft(draft, sheet);
  return { id: RUN_ID, created_at: Date.now(), status: 'draft', input: { date: '2026-10-16', audience: 'steady', simulate: [] }, audit: [], feedback: [], trading: { date: '2026-10-16' }, facts: sheet.facts, evidence: sheet.evidence, gaps: sheet.gaps, dq: sheet.dq, calls: [], draft, gate, metrics: {} };
}

before(async () => {
  llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (llmMode === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"mock down"}}'); return; }
      const content = JSON.stringify({ issues: [{ sid: 'S2', category: '隐含预测', reason: '单元测试：模拟语义层问题', suggestion: '删除判断部分' }] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { total_tokens: 1 } }));
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const llmBase = `http://127.0.0.1:${llm.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-desk-test-'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(dir, 'data/runtime/runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/runtime/runs', `${RUN_ID}.json`), JSON.stringify(fakeRun()));
  fs.mkdirSync(path.join(dir, 'data/samples'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/samples', 'sample.json'), JSON.stringify({ ...fakeRun(), id: 'sample01', audit: [{ at: 1, actor: 'AI', action: 'generate', detail: '生成草稿' }] }));
  const port = 40000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const off = 'http://127.0.0.1:9';
  child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { PATH: process.env.PATH, PORT: String(port), RUNS_PER_IP_PER_HOUR: '2', FUYAO_API_KEY: '', DEEPSEEK_API_KEY: 'unit-test-dummy-key', IFIND_MCP_TOKEN: '', FUYAO_BASE_URL: off, DEEPSEEK_BASE_URL: llmBase, IFIND_MCP_BASE: off },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server 启动超时')), 10000);
    child.stdout.on('data', (buf) => { if (String(buf).includes('已启动')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server 退出 code=${code}`)); });
  });
});
after(() => {
  child?.kill();
  llm?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* 纯文本或 NDJSON */ }
  return { status: res.status, data, type: res.headers.get('content-type') };
};
const sentences = (run) => run.draft.sections.flatMap((s) => s.sentences);

test('主链路：编辑→重新校验→提交闸门→合规退回→再提交→通过→导出', async () => {
  let r = await api('GET', `/api/runs/${RUN_ID}`);
  assert.equal(r.status, 200);
  const pendingIds = sentences(r.data).filter((s) => s.type === 'pending').map((s) => s.id);
  // 模板固定的 2 条 + 系统为"跌停股票池"缺失自动补上的 1 条锁定句
  assert.equal(pendingIds.length, 3);
  const sys = sentences(r.data).find((s) => s.origin === 'system');
  assert.ok(sys && sys.locked && /跌停股票池/.test(sys.text));
  let lockedTry = await api('PATCH', `/api/runs/${RUN_ID}/sentences/${sys.id}`, { action: 'delete' });
  assert.equal(lockedTry.status, 409, '系统缺失说明不可删除');
  lockedTry = await api('PATCH', `/api/runs/${RUN_ID}/sentences/${sys.id}`, { text: '数据完整，一切正常。' });
  assert.equal(lockedTry.status, 409, '系统缺失说明不可改写');

  // 未审核草稿导出带醒目前缀
  r = await api('GET', `/api/runs/${RUN_ID}/export`);
  assert.match(r.type, /text\/plain/);
  assert.match(r.data, /^【未审核草稿，不可对外发布】/);

  // 有待确认句 → 不能提交
  r = await api('POST', `/api/runs/${RUN_ID}/submit`);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /3 条待确认/);

  // 编辑：写入未溯源数字 + 荐股措辞 → 立即重新校验并阻断
  r = await api('PATCH', `/api/runs/${RUN_ID}/sentences/S1`, { text: '上证指数收于3716点，建议逢低布局。' });
  assert.equal(r.status, 200);
  const s1 = sentences(r.data).find((s) => s.id === 'S1');
  assert.deepEqual(s1.flags.map((x) => x.rule).sort(), ['advice', 'fact_no_source', 'untraced_number']);
  assert.equal(s1.edited, true);
  assert.equal(r.data.gate.block, 3);

  // 改回占位符写法 → 阻断解除
  r = await api('PATCH', `/api/runs/${RUN_ID}/sentences/S1`, { text: '{{DATE}}，上证指数收于{{F1}}，{{F2}}。' });
  assert.deepEqual(sentences(r.data).find((s) => s.id === 'S1').flags, []);
  assert.equal(r.data.gate.block, 0);

  // 逐条确认待确认句 → 可以提交
  for (const sid of pendingIds) r = await api('PATCH', `/api/runs/${RUN_ID}/sentences/${sid}`, { action: 'confirm_pending', note: '已人工核对' });
  assert.equal(r.data.gate.can_submit, true);
  r = await api('POST', `/api/runs/${RUN_ID}/submit`);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'in_review');

  // 审核中不可编辑
  r = await api('PATCH', `/api/runs/${RUN_ID}/sentences/S1`, { text: '改一下' });
  assert.equal(r.status, 409);

  // 退回必须填写意见
  r = await api('POST', `/api/runs/${RUN_ID}/review`, { decision: 'return' });
  assert.equal(r.status, 400);
  r = await api('POST', `/api/runs/${RUN_ID}/review`, { decision: 'return', comment: '第四节风险提示过简' });
  assert.equal(r.data.status, 'returned');

  // 退回后可再编辑、再提交
  r = await api('POST', `/api/runs/${RUN_ID}/submit`);
  assert.equal(r.status, 200);
  assert.equal(r.data.submit_count, 2);

  // 通过 → 生成定稿；导出即定稿全文
  r = await api('POST', `/api/runs/${RUN_ID}/review`, { decision: 'approve' });
  assert.equal(r.data.status, 'approved');
  const finalText = r.data.final_text;
  assert.match(finalText, /^10月16日盘后复盘/);
  assert.match(finalText, /上证指数收于3716\.28点，上涨0\.24%/);
  assert.match(finalText, /不构成任何投资建议/);
  assert.ok(!finalText.includes('{{'));
  r = await api('GET', `/api/runs/${RUN_ID}/export`);
  assert.equal(r.data, finalText);
  assert.equal((await api('GET', `/api/runs/${RUN_ID}`)).data.audit.map((a) => a.action).filter((a) => ['submit', 'return', 'approve'].includes(a)).join(','), 'submit,return,submit,approve');
});

test('生成接口限流：同一 IP 超过 RUNS_PER_IP_PER_HOUR（测试设为 2）→ 429', async () => {
  const first = await api('POST', '/api/runs', { date: '2026-10-16' });
  assert.equal(first.status, 200);
  // 未配置扶摇密钥：流中给出 error 事件，且声明未产出结论
  assert.match(first.data, /"type":"error"/);
  assert.match(first.data, /未产出任何结论/);
  assert.equal((await api('POST', '/api/runs', {})).status, 200);
  const third = await api('POST', '/api/runs', {});
  assert.equal(third.status, 429);
  assert.match(third.data.error, /每小时最多生成 2 次/);
});

test('编辑预览：只校验不保存，未溯源数字会被拦下', async () => {
  let r = await api('POST', `/api/runs/${RUN_ID}/preview`, { text: '上证指数收于3716点', type: 'fact' });
  assert.equal(r.status, 200);
  assert.ok(r.data.flags.some((f) => f.rule === 'untraced_number' && f.level === 'block'));
  r = await api('POST', `/api/runs/${RUN_ID}/preview`, { text: '上证指数{{F2}}，收于{{F1}}。', type: 'fact' });
  assert.equal(r.data.flags.filter((f) => f.level === 'block').length, 0);
  assert.match(r.data.rendered, /3716\.28点/);
  r = await api('POST', `/api/runs/${RUN_ID}/preview`, { text: 123 });
  assert.equal(r.status, 400);
  const run = (await api('GET', `/api/runs/${RUN_ID}`)).data;
  assert.ok(!sentences(run).some((s) => s.text.includes('3716点')), '预览不应写入草稿');
});

test('共享样例只读：拒绝编辑与反馈；复制后得到可编辑的独立草稿', async () => {
  let r = await api('PATCH', '/api/runs/sample01/sentences/S1', { text: '改动', actor: '投顾' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /共享的样例/);
  r = await api('POST', '/api/runs/sample01/feedback', { sid: 'S1', rating: 'up' });
  assert.equal(r.status, 409);
  r = await api('POST', '/api/runs/sample01/clone', {});
  assert.equal(r.status, 200);
  const copy = r.data;
  assert.notEqual(copy.id, 'sample01');
  assert.equal(copy.is_sample, false);
  assert.equal(copy.status, 'draft');
  assert.deepEqual(copy.audit.map((a) => a.action), ['generate', 'clone']);
  r = await api('PATCH', `/api/runs/${copy.id}/sentences/S1`, { action: 'delete', actor: '投顾' });
  assert.equal(r.status, 200);
  const sample = (await api('GET', '/api/runs/sample01')).data;
  assert.ok(!sentences(sample).find((s) => s.id === 'S1').deleted, '复制件的改动不应影响样例');
});

test('规则库校验：只有合规能增删；单字、纯数字符号、重复表述被拒绝', async () => {
  let r = await api('POST', '/api/config/rules', { phrase: '确定性机会', actor: '投顾' });
  assert.equal(r.status, 403);
  r = await api('POST', '/api/config/rules', { phrase: '涨', actor: '合规' });
  assert.equal(r.status, 400, '单字会误伤几乎所有草稿');
  r = await api('POST', '/api/config/rules', { phrase: '123%', actor: '合规' });
  assert.equal(r.status, 400, '纯数字符号不是表述');
  r = await api('POST', '/api/config/rules', { phrase: '确定性机会', level: 'warn', actor: '合规' });
  assert.equal(r.status, 200);
  const rule = r.data.rules.find((x) => x.phrase === '确定性机会');
  assert.equal(rule.level, 'warn');
  r = await api('POST', '/api/config/rules', { phrase: '确定性机会', actor: '合规' });
  assert.equal(r.status, 409);
  r = await api('DELETE', `/api/config/rules/${rule.id}?actor=${encodeURIComponent('投顾')}`);
  assert.equal(r.status, 403);
  r = await api('DELETE', `/api/config/rules/${rule.id}?actor=${encodeURIComponent('合规')}`);
  assert.ok(!r.data.rules.some((x) => x.id === rule.id));
});

test('审核通过前按最新规则复检：提交后新增的禁用表述命中 → 409，删掉规则后才能通过', async () => {
  let r = await api('POST', '/api/runs/sample01/clone', {});
  const id = r.data.id;
  for (const s of sentences(r.data).filter((x) => x.type === 'pending')) r = await api('PATCH', `/api/runs/${id}/sentences/${s.id}`, { action: 'confirm_pending' });
  r = await api('POST', `/api/runs/${id}/submit`);
  assert.equal(r.status, 200);
  r = await api('POST', '/api/config/rules', { phrase: '风险提示', actor: '合规' });
  const rule = r.data.rules.find((x) => x.phrase === '风险提示');
  r = await api('POST', `/api/runs/${id}/review`, { decision: 'approve' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /复检发现 \d+ 个阻断项/);
  assert.equal((await api('GET', `/api/runs/${id}`)).data.status, 'in_review', '复检不通过时状态不变');
  await api('DELETE', `/api/config/rules/${rule.id}?actor=${encodeURIComponent('合规')}`);
  r = await api('POST', `/api/runs/${id}/review`, { decision: 'approve' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'approved');
});

test('AI 合规复核：结果挂到句子上；返回的稿件不带"复核中"标记；模型失败时稿件不被锁住', async () => {
  let r = await api('POST', '/api/runs/sample01/clone', {});
  const id = r.data.id;
  llmMode = 'ok';
  r = await api('POST', `/api/runs/${id}/ai-review`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.ai_review_running, undefined, '响应里仍带标记会让页面一直锁定');
  assert.equal(sentences(r.data).find((s) => s.id === 'S2').ai_flags[0].category, '隐含预测');
  assert.equal(r.data.gate.warn >= 1, true, 'AI 提示只计入提醒，不阻断');
  assert.equal((await api('PATCH', `/api/runs/${id}/sentences/S2`, { action: 'dismiss_ai' })).status, 200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data/runtime/runs', `${id}.json`), 'utf8'));
  assert.equal(onDisk.ai_review_running, undefined);

  llmMode = 'fail';
  r = await api('POST', `/api/runs/${id}/ai-review`, {});
  assert.equal(r.status, 502);
  assert.match(r.data.error, /关键词规则校验仍然有效/);
  assert.equal((await api('PATCH', `/api/runs/${id}/sentences/S1`, { action: 'delete' })).status, 200, '复核失败后仍可编辑');
  llmMode = 'ok';
  r = await api('POST', '/api/runs/sample01/ai-review', {});
  assert.equal(r.status, 409, '共享样例不能发起复核');
});

test('限流按真实来源 IP 计数：Render 代理把真实 IP 追加在 X-Forwarded-For 末尾，伪造前段不能绕过', async () => {
  const post = (xff) => fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: '{}' })
    .then(async (r) => { await r.text(); return r.status; });
  assert.equal(await post('9.9.9.1, 203.0.113.7'), 200);
  assert.equal(await post('9.9.9.2, 203.0.113.7'), 200);
  assert.equal(await post('9.9.9.3, 203.0.113.7'), 429, '换了伪造的前段，仍按末段的真实 IP 计数');
  assert.equal(await post('9.9.9.3, 203.0.113.8'), 200, '不同的真实 IP 各自计数');
});
