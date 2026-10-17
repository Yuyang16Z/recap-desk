import { cnDate } from './dates.js';

// 合规词表：block = 必须改掉才能提交审核；warn = 提醒人工判断
export const RULES = [
  {
    id: 'predict', level: 'block', name: '确定性预测或未来走势判断',
    // "主要涨停""将涨停个股归类"是中性陈述：排除"主要"里的"要"和紧跟"停/幅"的情况
    re: /(?<!主)(必|将|会|要)(大)?(涨|跌)(?![停幅])|(必|将|会)(大)?(反弹|回调)|看涨|看跌|有望|即将(启动|爆发|拉升|反转|见底)|明[日天]|后市|下周|上涨空间|下跌空间|目标价|翻倍|反转在即|已经见底|已经见顶|才刚刚开始|还会继续|大概率(上涨|下跌|延续|反弹)/,
    fix: '删除对未来走势的判断，只陈述已经发生的事实',
  },
  {
    id: 'advice', level: 'block', name: '买卖或仓位建议',
    re: /建议(买入|卖出|加仓|减仓|持有|关注|布局|配置|低吸|止盈|止损)|(可以|可|适当|逢低|择机|积极|及时)(买入|卖出|加仓|减仓|布局|吸纳|介入|上车|抄底|低吸|参与|离场)|抄底|满仓|梭哈|重仓|上车|闭眼买|值得(买|入手|配置|关注)|推荐(买入|关注|标的)|首选|牛股|金股|买点|卖点|仓位/,
    fix: '删除操作建议；投顾复盘只陈述事实与风险',
  },
  {
    id: 'promise', level: 'block', name: '收益承诺或保本暗示',
    re: /稳赚|保本|保收益|保证(收益|盈利|赚钱|回报)|无风险|零风险|躺赚|包赚|稳稳(赚|拿)|收益(率)?(高达|至少|稳定在)/,
    fix: '删除收益承诺类表述',
  },
  {
    id: 'hype', level: 'warn', name: '夸张或煽动性措辞',
    re: /史诗级|千载难逢|最后(一次)?机会|疯涨|暴涨|妖股|绝对|毫无疑问|一定会|必然|错过再等/,
    fix: '改为中性客观的描述',
  },
];
const HEDGE = /或|可能|或许|推测|一定程度|似乎|显示|反映|指向|有待|仍需|不排除|大致|侧面/;
const PLACEHOLDER = /\{\{\s*(F\d+|E\d+|DATE)\s*\}\}/g;

// 名称里自带数字的指数（沪深300、科创50 等）不能算作"未溯源数字"
const INDEX_NAMES = [
  '沪深300', '科创50', '科创100', '科创200', '北证50', '上证50', '上证180', '上证380', '中证A500', '中证A50', '中证A100',
  '中证500', '中证800', '中证1000', '中证2000', '国证2000', '深证100', '创业板50', '双创50', 'A50',
];

export function entityNames(sheet) {
  const names = new Set(INDEX_NAMES);
  for (const f of sheet.facts) {
    if (f.stock) names.add(f.stock);
    (f.members || []).forEach((m) => names.add(m));
    const m = /「(.+?)」/.exec(f.label);
    if (m) names.add(m[1]);
    const idx = /^(.+?)(收盘点位|涨跌幅|指数涨跌幅)$/.exec(f.label);
    if (idx) names.add(idx[1]);
  }
  for (const e of sheet.evidence) if (e.stock) names.add(e.stock);
  return [...names].filter((n) => /\d/.test(n)).sort((a, b) => b.length - a.length);
}

function stockNames(sheet) {
  const set = new Set();
  for (const f of sheet.facts) {
    if (f.stock) set.add(f.stock);
    if (/个股数|家数|只/.test(f.label) || f.stock) (f.members || []).forEach((m) => set.add(m));
  }
  for (const e of sheet.evidence) if (e.stock) set.add(e.stock);
  return [...set].filter((n) => n && n.length >= 2);
}

export function verifySentence(s, sheet, names = entityNames(sheet)) {
  const flags = [];
  if (s.deleted) return flags;
  const factIds = new Set(sheet.facts.map((f) => f.id));
  const evIds = new Set(sheet.evidence.map((e) => e.id));
  const used = [...s.text.matchAll(PLACEHOLDER)].map((m) => m[1]);
  for (const id of used) {
    if (id !== 'DATE' && !factIds.has(id) && !evIds.has(id)) flags.push({ rule: 'unknown_ref', level: 'block', msg: `引用了底稿中不存在的编号 ${id}` });
  }
  // 去掉占位符与含数字的实体名后，剩余的阿拉伯数字都视为"未溯源数字"
  let stripped = s.text.replace(PLACEHOLDER, '');
  for (const n of names) stripped = stripped.split(n).join('');
  const nums = stripped.match(/[0-9０-９]+(?:\.[0-9]+)?\s*(?:%|％|亿|万|点|家|只|倍|连板|板|元|名)?/g);
  if (nums) flags.push({ rule: 'untraced_number', level: 'block', msg: `出现未溯源数字「${nums.join('、')}」`, fix: '数字必须通过 {{F编号}} 引用事实底稿，或删除' });
  // 实体一致性：属于某只股票的事实，句内离它最近的前一个股票名必须是它自己（中文主语常跨逗号延续，所以按句而不是按逗号判断）
  const stocks = stockNames(sheet);
  for (const seg of s.text.split(/[；;。！？]/)) {
    for (const m of seg.matchAll(PLACEHOLDER)) {
      const f = sheet.facts.find((x) => x.id === m[1]);
      if (!f?.stock) continue;
      const before = seg.slice(0, m.index);
      const clause = before.slice(Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1);
      let nearest = null;
      let pos = -1;
      for (const n of stocks) {
        const i = before.lastIndexOf(n);
        if (i > pos) { pos = i; nearest = n; }
      }
      // 放行：所在分句已点名该股（含"A、B、C均为…"并列句），或句内最近提到的股票就是它
      const ok = seg.includes(f.stock) && (clause.includes(f.stock) || !nearest || nearest === f.stock);
      if (!ok) {
        flags.push({ rule: 'entity_mismatch', level: 'block', msg: `${f.id}（${f.label}）属于「${f.stock}」，但句中${nearest && nearest !== f.stock ? `把它写在「${nearest}」名下` : '没有提到该股票'}，疑似张冠李戴`, fix: `改为引用正确个股的事实，或写明「${f.stock}」` });
      }
    }
  }
  const dup = used.filter((x, i) => x !== 'DATE' && used.indexOf(x) !== i);
  if (dup.length) flags.push({ rule: 'dup_ref', level: 'warn', msg: `同一事实在一句中重复引用：${[...new Set(dup)].join('、')}`, fix: '检查是否引用错了编号' });
  const refs = new Set([...(s.refs || []), ...used.filter((x) => x !== 'DATE')]);
  const hasBasis = [...refs].some((r) => factIds.has(r) || evIds.has(r));
  if (s.type === 'fact' && !hasBasis) flags.push({ rule: 'fact_no_source', level: 'block', msg: '标为「事实」但没有引用任何底稿编号', fix: '补充引用编号，或改为「推断」「待确认」' });
  if (s.type === 'fact' && /显示|反映|表明|说明|意味着|可能|或许|一定程度上|或与/.test(s.text)) {
    flags.push({ rule: 'fact_has_inference', level: 'warn', msg: '「事实」句里夹带了判断性措辞，读者会把判断当成数据结论', fix: '把判断拆成单独的「推断」句，或删掉判断部分' });
  }
  if (s.type === 'inference') {
    if (!hasBasis) flags.push({ rule: 'inference_no_basis', level: 'block', msg: '推断句没有给出依据编号', fix: '补充依据编号，或删除该推断' });
    if (!HEDGE.test(s.text)) flags.push({ rule: 'inference_no_hedge', level: 'warn', msg: '推断句缺少不确定性措辞（如「或」「可能」），容易被读成确定结论' });
  }
  for (const r of RULES) {
    const m = stripped.match(r.re);
    if (m) flags.push({ rule: r.id, level: r.level, msg: `${r.name}：「${m[0]}」`, fix: r.fix });
  }
  return flags;
}

// 渲染值已含"第…名""近…根日K"等字词，模型常在占位符前后再写一遍；拼接时去掉重叠部分
export function trimOverlap(prev, display, next) {
  let d = display;
  for (let k = Math.min(4, d.length - 1); k >= 1; k--) {
    if (prev.endsWith(d.slice(0, k))) { d = d.slice(k); break; }
  }
  for (let k = Math.min(4, d.length - 1); k >= 1; k--) {
    if (next.startsWith(d.slice(-k))) { d = d.slice(0, d.length - k); break; }
  }
  return d;
}

export function renderText(text, sheet, date) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const before = text.slice(last, m.index);
    out += before;
    const id = m[1];
    const next = text.slice(m.index + m[0].length);
    if (id === 'DATE') out += cnDate(date);
    else {
      const f = sheet.facts.find((x) => x.id === id);
      if (f) out += trimOverlap(out, f.display, next);
      else if (!sheet.evidence.find((x) => x.id === id)) out += `【无效引用${id}】`;
    }
    last = m.index + m[0].length;
  }
  return (out + text.slice(last)).replace(/\s{2,}/g, ' ');
}

export function computeGate(draft) {
  let block = 0;
  let warn = 0;
  let pending = 0;
  let total = 0;
  let sourced = 0;
  for (const sec of draft.sections) {
    for (const s of sec.sentences) {
      if (s.deleted) continue;
      total++;
      if ((s.refs || []).length || /\{\{\s*[FE]\d+\s*\}\}/.test(s.text)) sourced++;
      block += (s.flags || []).filter((f) => f.level === 'block').length;
      warn += (s.flags || []).filter((f) => f.level === 'warn').length + (s.ai_flags || []).filter((f) => !f.dismissed).length;
      if (s.type === 'pending' && !s.pending_confirmed) pending++;
    }
  }
  return { block, warn, pending_unresolved: pending, sentences: total, sourced_ratio: total ? +(sourced / total).toFixed(3) : 0, can_submit: block === 0 && pending === 0 && total > 0 };
}

export function verifyDraft(draft, sheet) {
  const names = entityNames(sheet);
  for (const sec of draft.sections) for (const s of sec.sentences) s.flags = verifySentence(s, sheet, names);
  return computeGate(draft);
}
