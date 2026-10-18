import { llmChat, tryParseJson, liftInlineRefs } from './agent.js';
import { verifySentence, entityNames } from './verify.js';

// 校验器发现的这些问题，交还模型按错误原因重写一次；夸张措辞等"提醒"级问题留给人判断
const REPAIRABLE = new Set(['untraced_number', 'entity_mismatch', 'unit_mismatch', 'unknown_ref', 'fact_no_source', 'inference_no_basis', 'predict', 'advice', 'promise', 'custom']);

const SYSTEM = `你是复盘稿的修订助手。下面的句子没有通过系统校验，请按"问题"逐句修订，输出 JSON。
规则与撰写时相同：
1. 数字只能写成 {{F编号}}，渲染值已含单位和方向，占位符前后不要重复这些字词；底稿里没有的数字就删掉相应表述。日期也算数字：交易日写 {{DATE}}，其他日期（如“10月15日晚”）改成“前一交易日晚间”这类相对说法，修订稿里不能再出现原来的数字。
2. 带个股名称的事实只能用于该个股；不要借用其他个股的编号。
3. 不得出现预测、买卖或仓位建议、收益承诺。
4. 推断句要有依据编号，并使用"或""可能""显示出"等不确定措辞；没有依据时改写成 pending 句说明缺什么。
5. 不得引入原句没有的新观点或新数据。一句话无法在规则内保留时，action 设为 "delete"。
输出格式：{"repairs":[{"id":"S7","action":"rewrite","text":"……","type":"fact|inference|pending","refs":["F1"],"reason":"一句话说明改了什么"}]}`;

/**
 * 校验器在环（verifier-in-the-loop）：只修 AI 写的句子，修后必须重新通过校验才替换原句；
 * 修不好就保留原句与问题标记交给人工，所以自修复不会让稿子变差。
 */
export async function repairDraft(ctx, sheet, draft, { emit, custom = [] } = {}) {
  const targets = [];
  for (const sec of draft.sections) {
    for (const s of sec.sentences) {
      if (s.deleted || s.origin !== 'ai') continue;
      const blocks = (s.flags || []).filter((f) => f.level === 'block' && REPAIRABLE.has(f.rule));
      if (blocks.length) targets.push({ s, blocks });
    }
  }
  const stats = { attempted: targets.length, fixed: 0, failed: 0, deleted: 0 };
  if (!targets.length) return stats;
  emit?.({ type: 'stage', stage: 'repair', msg: `自动修复：${targets.length} 句未通过校验，连同错误原因交还模型重写一轮，修后重新校验` });

  const facts = sheet.facts.map((f) => `${f.id}｜${f.label}｜渲染值：${f.display}${f.stock ? `｜个股：${f.stock}` : ''}`).join('\n');
  const evidence = sheet.evidence.map((e) => `${e.id}｜${e.stock || ''}｜${e.text.slice(0, 160).replace(/\n+/g, ' ')}`).join('\n') || '无';
  const items = targets.map(({ s, blocks }) => `${s.id}［${s.type}］${s.text}\n  依据：${(s.refs || []).join('、') || '无'}\n  问题：${blocks.map((b) => b.msg).join('；')}`).join('\n');
  let repairs = [];
  try {
    const msg = await llmChat(ctx, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `【事实底稿】\n${facts}\n\n【文本证据】\n${evidence}\n\n【待修订句子】\n${items}` },
    ], { json: true, maxTokens: 2000, temperature: 0.2, kind: 'repair' });
    const parsed = tryParseJson(msg.content)?.repairs;
    repairs = Array.isArray(parsed) ? parsed.filter((r) => r && typeof r === 'object' && typeof r.id === 'string') : [];
  } catch (e) {
    emit?.({ type: 'warn', msg: `自动修复未执行：${e.message}；问题句保留给人工处理` });
    stats.failed = targets.length;
    stats.error = e.message;
    return stats;
  }

  const names = entityNames(sheet);
  for (const { s, blocks } of targets) {
    const r = repairs.find((x) => x.id === s.id);
    const before = { text: s.text, type: s.type, refs: s.refs, problems: blocks.map((b) => b.msg) };
    const reason = String(r?.reason || '').slice(0, 120);
    if (!r) {
      stats.failed++;
      s.repair = { status: 'failed', before, reason: '模型没有给出这句的修订' };
      continue;
    }
    if (r.action === 'delete') {
      stats.deleted++;
      s.deleted = true;
      s.repair = { status: 'deleted', before, reason };
      continue;
    }
    const lifted = liftInlineRefs(String(r.text || '').trim(), Array.isArray(r.refs) ? r.refs.map(String).slice(0, 12) : []);
    const cand = { ...s, text: lifted.text, refs: lifted.refs, type: ['fact', 'inference', 'pending'].includes(r.type) ? r.type : s.type };
    const flags = verifySentence(cand, sheet, names, custom);
    const remaining = flags.filter((f) => f.level === 'block');
    if (!cand.text || remaining.length) {
      stats.failed++;
      s.repair = { status: 'failed', before, attempt: cand.text, reason, remaining: remaining.map((f) => f.msg) };
      continue;
    }
    Object.assign(s, { text: cand.text, refs: cand.refs, type: cand.type, flags });
    s.repair = { status: 'fixed', before, reason };
    stats.fixed++;
  }
  emit?.({ type: 'info', msg: `自动修复结果：修好 ${stats.fixed} 句、删除 ${stats.deleted} 句、未修好 ${stats.failed} 句（保留原句交人工）` });
  return stats;
}
