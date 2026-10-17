import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySentence } from '../lib/verify.js';

// 三条用例都来自开发中真实出现的模型输出（见 docs/AI_USAGE.md 第 8、8b、8c 条）
const sheet = {
  facts: [
    { id: 'F24', label: '东方嘉盛连板高度', display: '2连板', stock: '东方嘉盛' },
    { id: 'F25', label: '吉大正元连板高度', display: '2连板', stock: '吉大正元' },
    { id: 'F26', label: '尖峰集团连板高度', display: '2连板', stock: '尖峰集团' },
    { id: 'F35', label: '新华传媒收盘封单额', display: '9.08亿元', stock: '新华传媒' },
    { id: 'F36', label: '跌停家数', display: '10家', members: ['阳光乳业', '电魂网络'] },
    { id: 'F47', label: '新华传媒近五根日K累计涨跌幅', display: '近5根日K累计上涨61.1%', stock: '新华传媒' },
  ],
  evidence: [],
};
const mismatches = (text) => verifySentence({ text, type: 'fact', refs: [] }, sheet).filter((f) => f.rule === 'entity_mismatch');

test('把新华传媒的涨幅写到阳光乳业、电魂网络名下 → 阻断', () => {
  const flags = mismatches('当日跌停{{F36}}，如阳光乳业此前{{F47}}，电魂网络此前{{F47}}。');
  assert.equal(flags.length, 2);
  assert.ok(flags.every((f) => f.level === 'block'));
  assert.match(flags[0].msg, /阳光乳业/);
});

test('主语跨逗号延续（新华传媒…，收盘封单额…）→ 放行', () => {
  assert.equal(mismatches('新华传媒{{F47}}，收盘封单额{{F35}}，公司公告提示停牌核查风险。').length, 0);
});

test('并列句共用一个值（A、B、C均为…）→ 放行', () => {
  assert.equal(mismatches('东方嘉盛、吉大正元、尖峰集团连板高度均为{{F24}}。').length, 0);
});

test('整句没有提到该股票 → 阻断', () => {
  const flags = mismatches('收盘封单额达到{{F35}}。');
  assert.equal(flags.length, 1);
  assert.match(flags[0].msg, /没有提到/);
});

test('同句先提到正确股票、后切换到别的股票再引用 → 阻断', () => {
  assert.equal(mismatches('新华传媒连续涨停，阳光乳业此前{{F47}}。').length, 1);
});
