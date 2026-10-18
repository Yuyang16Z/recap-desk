import { publicCall } from './fuyao.js';

// iFinD MCP（Streamable HTTP）极简客户端：initialize → notifications/initialized → tools/call
// 会话按 server 缓存 20 分钟；调用同样记入 ctx.calls，和扶摇调用一起出现在"工具调用"面板
const sessions = new Map();

function headers(sid) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: process.env.IFIND_MCP_TOKEN };
  if (sid) h['Mcp-Session-Id'] = sid;
  return h;
}

async function rpc(url, body, sid, signal) {
  const res = await fetch(url, { method: 'POST', headers: headers(sid), body: JSON.stringify(body), signal });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let json = null;
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) if (line.startsWith('data:')) { try { json = JSON.parse(line.slice(5)); } catch { /* 忽略心跳行 */ } }
  } else if (text) {
    json = JSON.parse(text);
  }
  return { json, sid: res.headers.get('mcp-session-id') };
}

async function session(url, signal) {
  const cached = sessions.get(url);
  if (cached && Date.now() - cached.at < 20 * 60e3) return cached.sid;
  const init = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'recap-desk', version: '0.1.0' } } }, null, signal);
  if (init.sid) await fetch(url, { method: 'POST', headers: headers(init.sid), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal });
  sessions.set(url, { sid: init.sid, at: Date.now() });
  return init.sid;
}

export async function ifindCall(ctx, server, tool, args, { title, timeoutMs = 25000 } = {}) {
  const url = `${process.env.IFIND_MCP_BASE || 'https://api-mcp.51ifind.com:8643/ds-mcp-servers'}/${server}`;
  const call = { id: `T${ctx.calls.length + 1}`, label: `ifind_${tool}`, title: title || `iFinD ${tool}`, path: `iFinD MCP ${server} / ${tool}`, params: args, started: Date.now(), attempts: 1, by: 'agent' };
  ctx.calls.push(call);
  ctx.emit?.({ type: 'tool_start', call: publicCall(call) });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    if (ctx.simulate?.includes('ifind_down')) throw new Error('故障演练：模拟 iFinD 不可用');
    if (!process.env.IFIND_MCP_TOKEN) throw new Error('服务端未配置 IFIND_MCP_TOKEN');
    const callTool = async () => rpc(url, { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } }, await session(url, ac.signal), ac.signal);
    let out;
    try {
      out = await callTool();
      if (!out.json?.result && out.json?.error) throw new Error(out.json.error.message || 'JSON-RPC 错误');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 会话在服务端过期（MCP 规范返回 404）或调用出错：丢弃缓存会话，重建后再试一次
      sessions.delete(url);
      call.attempts = 2;
      out = await callTool();
    }
    const result = out.json?.result;
    if (!result || result.isError) throw new Error(out.json?.error?.message || result?.content?.[0]?.text?.slice(0, 120) || '返回为空');
    const text = result.content?.map((c) => c.text || '').join('\n') || '';
    let payload = text;
    try {
      const outer = JSON.parse(text);
      if (outer.code !== undefined && outer.code !== 1 && outer.code !== 0) throw new Error(outer.msg || `code=${outer.code}`);
      payload = outer.data?.data ?? outer.data ?? outer;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* 保留原文 */ } }
    } catch (e) {
      if (e.message && !/JSON/.test(e.message)) throw e;
    }
    call.ok = true;
    call.code = 0;
    call.ms = Date.now() - call.started;
    ctx.emit?.({ type: 'tool_end', call: publicCall(call) });
    return payload;
  } catch (e) {
    call.ok = false;
    call.code = -1;
    call.error = e.name === 'AbortError' ? `请求超时（>${timeoutMs / 1000}s）` : e.message;
    call.ms = Date.now() - call.started;
    ctx.emit?.({ type: 'tool_end', call: publicCall(call) });
    throw new Error(call.error);
  } finally {
    clearTimeout(timer);
  }
}
