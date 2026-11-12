// 日期 / 星期 / 时间 通用工具（从小程序 parseTrip/lib/util.js 移植）
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseDate(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function weekdayOf(str) {
  const d = parseDate(str);
  if (!d) return '';
  return '周' + WEEK[d.getDay()];
}
function mdOf(str) {
  const d = parseDate(str);
  if (!d) return { m: '', d: '' };
  return { m: d.getMonth() + 1, d: d.getDate() };
}
// 北京时间"今天"（服务器可能在任意时区）
function todayStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
function addDays(str, n) {
  const base = Date.parse(str + 'T00:00:00+08:00');
  if (isNaN(base)) return '';
  return new Date(base + n * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}
function normalizeDate(raw, defaultYear) {
  if (!raw) return '';
  const year = defaultYear || new Date(Date.now() + 8 * 3600000).getFullYear();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(raw);
  if (m) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
  m = /^(\d{1,2})[-/](\d{1,2})$/.exec(raw.trim());
  if (m) return year + '-' + pad2(+m[1]) + '-' + pad2(+m[2]);
  m = /^(\d{1,2})月(\d{1,2})日?/.exec(raw);
  if (m) return year + '-' + pad2(+m[1]) + '-' + pad2(+m[2]);
  return '';
}
function normalizeTime(raw) {
  if (!raw) return '';
  const m = /(\d{1,2})[:：](\d{1,2})/.exec(raw);
  if (m) return pad2(+m[1]) + ':' + pad2(+m[2]);
  const h = /^(\d{1,2})$/.exec(raw.trim());
  if (h) return pad2(+h[1]) + ':00';
  return raw.trim();
}
module.exports = { WEEK, pad2, fmtDate, parseDate, weekdayOf, mdOf, todayStr, addDays, normalizeDate, normalizeTime };
