// 行程文本解析器（从小程序 parseTrip 移植思路，Node 版，"城市(时间)"配对提取）
// 支持：
//  火车：11月12日 G6551次列车(二等座(03车厢,09C号，03车厢),广州东(07:25)-香港西九龙(09:07)，已出票成功。
//  航班：11月12日 CZ3456 广州(08:00)-北京(11:00)
// 输出：[{date, vehicle, no, depCity, depTime, arrCity, arrTime, seat, raw}]

const CN_MONTH = '([0-9]{1,2})月([0-9]{1,2})日';
const YEAR_RE = /(?:(20[0-9]{2})年)?/;
const CITY_TIME_RE = /([一-龥A-Za-z]{2,10})\s*[（(]\s*([0-9]{1,2}:[0-9]{2})\s*[）)]/g;

function pad2(n) { n = String(Number(n)); return n.length < 2 ? '0' + n : n; }

function normDate(y, m, d) {
  const year = y ? Number(y) : new Date().getFullYear();
  return `${year}-${pad2(m)}-${pad2(d)}`;
}

function cleanBody(text) {
  return String(text || '')
    .replace(/[一-龥]{1,4}\s*[（(]\s*证件号码[：:]?\s*[0-9Xx*]{0,20}\s*[）)]?/g, ' ')
    .replace(/\r/g, '\n');
}

// 从一行中提取全部"城市(时间)"对（按出现顺序：出发在前、到达在后）
function cityPairs(line) {
  const pairs = [];
  CITY_TIME_RE.lastIndex = 0;
  let m;
  while ((m = CITY_TIME_RE.exec(line)) !== null) {
    pairs.push({ city: m[1], time: m[2] });
  }
  return pairs;
}

function pickSeat(line) {
  const m = line.match(/(?:商务座|特等座|一等座|二等座|硬座|软座|硬卧|软卧|动卧|无座|经济舱|公务舱|头等舱)/);
  let seat = m ? m[0] : '';
  const seatDetail = line.match(/(?:商务座|一等座|二等座)\s*[（(]\s*[^）)]{1,24}[）)]/);
  if (seatDetail) seat = seatDetail[0].replace(/\s/g, '').replace(/[（）()]/g, '').replace(/厢(?=[0-9A-Za-z])/, '').replace(/[,，]$/, '');
  return seat;
}

function parseChunk(chunk, results) {
  const t = chunk.trim();
  if (!t) return;
  const dm = t.match(new RegExp(YEAR_RE.source + CN_MONTH));
  const pairs = cityPairs(t);
  if (pairs.length < 2) return;  // 至少要有出发地和到达地两个"城市(时间)"

  const date = dm ? normDate(dm[1], dm[2], dm[3]) : normDate('', '', '1');
  const seat = pickSeat(t);

  // 航班先判（二字码+3~4位数字，如 CZ3456），再判火车（单字母车次），避免 CZ3456 被截成 Z3456
  const fm = t.match(/(?<![A-Za-z])[A-Z]{2}[0-9]{3,4}(?![0-9])/);
  if (fm) {
    results.push({
      vehicle: 'flight', no: fm[0], date,
      depCity: pairs[0].city, depTime: pairs[0].time,
      arrCity: pairs[pairs.length - 1].city, arrTime: pairs[pairs.length - 1].time,
      seat, raw: t
    });
    return;
  }

  // 火车：车次号（前面不能是字母，避免把航班尾号当车次）
  const noM = t.match(/(?<![A-Za-z])[GDCCKTZ][0-9]{1,5}\s*次?/);
  if (noM) {
    results.push({
      vehicle: 'train', no: noM[0].replace(/\s/g, '').replace(/次$/, ''), date,
      depCity: pairs[0].city, depTime: pairs[0].time,
      arrCity: pairs[pairs.length - 1].city, arrTime: pairs[pairs.length - 1].time,
      seat, raw: t
    });
    return;
  }
  // 其他交通方式：有明确两地时间也收录（vehicle=other，车次留空）
  results.push({
    vehicle: 'other', no: '', date,
    depCity: pairs[0].city, depTime: pairs[0].time,
    arrCity: pairs[pairs.length - 1].city, arrTime: pairs[pairs.length - 1].time,
    seat, raw: t
  });
}

function parseText(text) {
  const cleaned = cleanBody(text);
  const results = [];
  const chunks = cleaned.split(/已出票成功|已出票|已购票成功|已购票|\n+/);
  for (const c of chunks) {
    // 一段里可能含多条行程，按日期关键词再切（lookbehind 防止"11月"被截成"1月"）
    const sub = c.split(/(?<![0-9])(?=[0-9]{1,2}月[0-9]{1,2}日)/);
    for (const line of sub) parseChunk(line, results);
  }
  return results;
}

module.exports = { parseText };
