// server.js 接口级测试（离线）：把 server.js + lib/ 复制到临时目录启动，
// 隔离 data/runtime、不读取 .env.local，所有上游地址指向 127.0.0.1:9，确保不会访问真实接口。
import { test, before, after } from 'node:test';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-desk-test-'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(dir, 'data/runtime/runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/runtime/runs', `${RUN_ID}.json`), JSON.stringify(fakeRun()));
  const port = 40000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  const off = 'http://127.0.0.1:9';
  child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { PATH: process.env.PATH, PORT: String(port), RUNS_PER_IP_PER_HOUR: '2', FUYAO_API_KEY: '', DEEPSEEK_API_KEY: '', IFIND_MCP_TOKEN: '', FUYAO_BASE_URL: off, DEEPSEEK_BASE_URL: off, IFIND_MCP_BASE: off },
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
  assert.equal(pendingIds.length, 2);

  // 未审核草稿导出带醒目前缀
  r = await api('GET', `/api/runs/${RUN_ID}/export`);
  assert.match(r.type, /text\/plain/);
  assert.match(r.data, /^【未审核草稿，不可对外发布】/);

  // 有待确认句 → 不能提交
  r = await api('POST', `/api/runs/${RUN_ID}/submit`);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /2 条待确认/);

  // 编辑：写入未溯源数字 + 荐股措辞 → 立即重新校验并阻断
  r = await api('PATCH', `/api/runs/${RUN_ID}/sentences/S1`, { text: '上证指数收于3716点，建议逢低布局。' });
  assert.equal(r.status, 200);
  const s1 = sentences(r.data).find((s) => s.id === 'S1');
  assert.deepEqual(s1.flags.map((x) => x.rule).sort(), ['advice', 'untraced_number']);
  assert.equal(s1.edited, true);
  assert.equal(r.data.gate.block, 2);

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
