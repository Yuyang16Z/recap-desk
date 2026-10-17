// 所有业务日期按 Asia/Shanghai 处理（扶摇接口约定），与服务器所在时区无关
export const DAY = 86400000;
const SH_OFFSET = 8 * 3600000;

export function shanghaiNow(nowMs = Date.now()) {
  const d = new Date(nowMs + SH_OFFSET);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    text: d.toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）',
  };
}

// 交易日在上海时区 00:00:00 的毫秒戳
export function dateMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - SH_OFFSET;
}

export function msToDate(ms) {
  return new Date(ms + SH_OFFSET).toISOString().slice(0, 10);
}

export function msToTime(ms) {
  return new Date(ms + SH_OFFSET).toISOString().slice(0, 16).replace('T', ' ');
}

export function dash(yyyymmdd) {
  const s = String(yyyymmdd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function cnDate(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日`;
}
