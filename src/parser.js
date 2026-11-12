// 行程文本解析器 —— 从小程序 parseTrip 云函数完整移植（Node 版，去掉云依赖）
// 支持：火车/航班订单短信、携程截图版式、纯约车文本兜底、乘机人识别、共享航班合并
// 输出 parseText(text) => [{date, weekday, type:'train'|'flight'|'car', flightNo(航班) / trainNo(火车),
//   depCity, depStation, depTime, arrCity, arrStation, arrTime, seat, raw}]
// 另导出 matchExecName(text, execList) —— 按名单匹配高管（精确→称呼→OCR模糊→乘机人→姓氏）
const U = require('./util');

const TRAIN_RE = /[GCDKTZ]\d{1,4}/;
const FLIGHT_RE = /(?<![A-Z])[A-Z]{2}\d{3,4}(?!\d)/;
const TIME_RE = /\d{1,2}[:：]\d{2}/;
// 共享航班"实际乘坐/实际承运/实承"后面的航班号 = 实际承运航班
const OP_FLIGHT_RE = /实际(?:乘坐|承运)[:：]?\s*([A-Z]{2}\d{3,4})|实承[:：]?\s*([A-Z]{2}\d{3,4})/;
const STATION_STOP = /(身份证|购票成功|经停|检票口|取票号|换座|积分|会员|更新|酒店|民宿|汽车票|机票|明天|今天|待出票|出票|已出|订单|客服|更多|电子乘车码|改签|退票|费用|乘机人|联系人|保险|备注|申请单|查看|旅行|商务|服务|航空|航班|票号|平台|起飞|降落|到达|出发|落地|登机|候机|值机|航站|里程|行李|退改|温馨提示|尊敬的|旅客|乘坐|请您|祝您|行程|到达站|出发站|预订|购票|购买|您好|先生|女士|通知|详情|站台|车厢|报销|凭证|电子客票|开车|终到|返程|以下|具体|餐食|经济舱|公务舱|头等|准点|机型|空客|波音|系列|折扣|分享|登机口|机上|随行|全日空|国航|东航|南航|海航|川航|厦航|深航|山航|吉祥|春秋|联合航空|汉莎|达美|美联航|国泰|港龙|澳洲航空|[一-龥]总|^周[一二三四五六日天]$)/;

// 常见城市前缀：用于把"石家庄正定T2"还原为"正定T2"
const CITY_PREFIX = ['石家庄', '哈尔滨', '乌鲁木齐', '呼和浩特', '鄂尔多斯', '包头', '南宁', '银川', '西宁',
  '深圳', '广州', '上海', '北京', '成都', '杭州', '南京', '武汉', '西安', '重庆', '天津', '苏州', '青岛', '大连',
  '沈阳', '长春', '郑州', '长沙', '济南', '宁波', '福州', '厦门', '合肥', '昆明', '贵阳', '南昌', '太原', '兰州',
  '海口', '三亚', '珠海', '温州', '无锡', '佛山', '东莞', '桂林', '丽江', '烟台', '唐山', '保定', '洛阳', '徐州',
  '常州', '南通', '扬州', '嘉兴', '金华', '绍兴', '台州', '泉州', '漳州', '惠州', '汕头', '湛江', '北海', '柳州',
  '绵阳', '宜昌', '襄阳', '衡阳', '株洲', '赣州', '芜湖', '临沂', '济宁', '新乡', '安阳', '南阳', '三亚', '香港',
  '澳门', '台北', '高雄', '拉萨', '兰州', '大同', '运城', '临汾', '秦皇岛', '廊坊', '邯郸', '邢台', '张家口'];

// 找车次：排除"石家庄T2"这类航站楼 T\d 误判（T 字头只有后接"次/列"才认）
function findTrain(line) {
  let m; const re = /[GCDKTZ]\d{1,4}/g;
  while ((m = re.exec(line)) !== null) {
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (m[0][0] === 'T' && !/次|列/.test(after)) continue;
    return { no: m[0], idx: m.index };
  }
  return null;
}

function parse(text) {
  const lines = String(text || '').split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
  const inline = [];
  lines.forEach((l, i) => {
    if (TIME_RE.test(l) && (FLIGHT_RE.test(l) || !!findTrain(l))) {
      const s = parseLine(l);
      if (s) { s._ln = i; inline.push(s); }
    }
  });
  let segs = inline.length ? inline : parseOrderLayout(lines);

  // 兜底补抓：火车座位（X车厢X号/无座）与日期常在车次行的相邻行
  for (const s of segs) {
    const base = (s._ln !== undefined) ? s._ln : -1;
    if (s.type === 'train' && !s.seat) {
      for (let j = Math.max(0, base - 1); j <= Math.min(lines.length - 1, base + 3); j++) {
        const sm = lines[j].match(/(\d{1,2}\s*车\s*厢?\s*[,，]?\s*[0-9A-Za-z]{1,4}\s*号?|\d{1,2}\s*车\s*厢?\s*\d{1,3}\s*号?|无座)/);
        if (sm) { s.seat = sm[0].replace(/\s/g, '').replace(/[,，]/g, '').replace(/[（）()]/g, ''); break; }
      }
    }
    if (!s.date) {
      for (let j = Math.max(0, base - 2); j <= Math.min(lines.length - 1, base + 2); j++) {
        const dm = lines[j].match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日?/);
        if (dm) { s.date = U.normalizeDate(dm[0]); break; }
      }
      if (!s.date) s.date = firstDateAnywhere(lines);
    }
    if (s.date && !s.weekday) s.weekday = U.weekdayOf(s.date);
    delete s._ln;
  }

  // 共享航班合并（同一日期/时间/起讫的多个航班号 → "CZ1401(实承NS3204)"一条）
  segs = mergeCodeshare(segs, text);
  segs = dedup(segs);
  segs.sort((a, b) => ((a.date || '') + (a.depTime || '')).localeCompare((b.date || '') + (b.depTime || '')));
  return segs;
}

// 纯约车兜底：识别"日期 + 姓名 + 时间 + 出发地前往目的地"这类无航班/车次的临时用车
function parseCar(text, execName) {
  const flat = (text || '').replace(/\s/g, '');
  if (!flat) return null;
  let dm = flat.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/) || flat.match(/(\d{1,2})月(\d{1,2})日?/);
  let date = dm ? U.normalizeDate(dm[0]) : resolveWeekday(flat);
  const tm = flat.match(/(\d{1,2})[:：](\d{2})/);
  const time = tm ? U.normalizeTime(tm[1] + ':' + tm[2]) : '';
  if (!time) return null;
  let body = flat
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '')
    .replace(/(\d{1,2})月(\d{1,2})日?/g, '')
    .replace(/(今天|明天|后天|周[一二三四五六日])/g, '')
    .replace(/(\d{1,2})[:：](\d{2})/g, '');
  if (execName) body = body.split(execName).join('');
  const dirs = ['出发前往', '出发去', '前往', '出发', '去往', '去', '到'];
  let from = '', to = '';
  for (const d of dirs) {
    const i = body.indexOf(d);
    if (i > 0) { from = body.slice(0, i); to = body.slice(i + d.length); break; }
  }
  from = (from || '').replace(/^[从由，,。.、\s]+/, '').trim();
  to = (to || '').replace(/^[从由，,。.、\s]+/, '').replace(/[，,。.、\s]+$/, '').trim();
  if (!from || !to) return null;
  return {
    seg: {
      date: date || '', weekday: date ? U.weekdayOf(date) : '', type: 'car',
      flightNo: '', depCity: from, depStation: '', depTime: time,
      arrCity: to, arrStation: '', arrTime: '', seat: ''
    },
    hint: { needCar: true, carType: '临时', carFrom: from, carDest: to, carTime: time }
  };
}

// 把"今天/明天/后天/周X"解析为具体日期（相对今天）
function resolveWeekday(flat) {
  const t = U.todayStr();
  const m = flat.match(/(今天|明天|后天|周[一二三四五六日])/);
  if (!m) return '';
  const w = m[1];
  if (w === '今天') return t;
  if (w === '明天') return U.addDays(t, 1);
  if (w === '后天') return U.addDays(t, 2);
  const map = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const target = map[w.charAt(1)];
  if (target === undefined) return '';
  const d = U.parseDate(t);
  let off = (target - d.getDay() + 7) % 7;
  if (off === 0) off = 7;   // 本周已过则取下周
  return U.addDays(t, off);
}

// 共享航班（实际承运）合并为一条："CZ1401(实承NS3204)"
function mergeCodeshare(segs, text) {
  const flat = (text || '').replace(/\s/g, '');
  const ops = [];
  const re = /实际(?:乘坐|承运)[:：]?([A-Z]{2}\d{3,4})|实承[:：]?([A-Z]{2}\d{3,4})/g;
  let m;
  while ((m = re.exec(flat)) !== null) ops.push(m[1] || m[2]);

  const out = [];
  for (const s of segs) {
    if (s.type !== 'flight' || !s.flightNo) { out.push(s); continue; }
    const key = [s.date, s.depTime, s.arrTime, s.depCity, s.arrCity].join('|');
    const twinIdx = out.findIndex(t => t.type === 'flight' &&
      [t.date, t.depTime, t.arrTime, t.depCity, t.arrCity].join('|') === key);
    if (twinIdx < 0) { out.push(s); continue; }
    const twin = out[twinIdx];
    if (twin.flightNo === s.flightNo) continue;         // 完全重复（dedup 兜底）
    const twinIsOp = ops.indexOf(twin.flightNo) >= 0;
    const sIsOp = ops.indexOf(s.flightNo) >= 0;
    let main, other;
    if (twinIsOp && !sIsOp) { main = s; other = twin; out[twinIdx] = s; }
    else { main = twin; other = s; }
    if (main.flightNo.indexOf('实承') < 0) {
      main.flightNo = `${main.flightNo}(实承${other.flightNo})`;
    }
  }
  return out;
}

function dedup(segs) {
  const seen = new Set(), out = [];
  for (const s of segs) {
    const k = [s.date, s.flightNo, s.depTime, s.arrTime, s.depCity, s.arrCity].join('|');
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

function blankSeg() {
  return { date: '', weekday: '', flightNo: '', trainNo: '', type: '',
    depCity: '', depStation: '', depTime: '', arrCity: '', arrStation: '', arrTime: '', seat: '' };
}

// 订单/截图版式：车次/航班所在行为锚点，向上找时间与日期，行内拆出发/到达，向下找座位
function parseOrderLayout(lines) {
  const segs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const flightM = line.match(FLIGHT_RE);
    const trainM = flightM ? null : findTrain(line);
    if (!trainM && !flightM) continue;
    if (TIME_RE.test(line)) continue; // 车次/航班与时间同行的交给逐行解析

    const seg = blankSeg();
    if (trainM) { seg.trainNo = trainM.no; seg.type = 'train'; }
    else { seg.flightNo = flightM[0]; seg.type = 'flight'; }

    if (trainM) {
      const before = line.slice(0, trainM.idx !== undefined ? trainM.idx : 0);
      const after = line.slice((trainM.idx !== undefined ? trainM.idx : 0) + trainM.no.length)
        .replace(/^[·•\s]*\d+(?:时\d+分)?分?/, '');
      const depTok = lastStation(before) || lookStation(lines, i, -1);
      const arrTok = firstStation(after) || lookStation(lines, i, +1);
      if (depTok) { const s = splitStation(depTok); seg.depCity = s.city; seg.depStation = s.station; }
      if (arrTok) { const s = splitStation(arrTok); seg.arrCity = s.city; seg.arrStation = s.station; }
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const times = lines[j].match(/\d{1,2}[:：]\d{2}/g) || [];
        if (times.length >= 2 && !seg.depTime) {
          seg.depTime = U.normalizeTime(times[0]);
          seg.arrTime = U.normalizeTime(times[1]);
        }
        const dm = lines[j].match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日?/);
        if (dm && !seg.date) seg.date = U.normalizeDate(dm[0]);
      }
      if (!seg.date) seg.date = firstDateAnywhere(lines);
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
        const sm = lines[j].match(/(\d{1,2}\s*车\s*厢?\s*[,，]?\s*[0-9A-Za-z]{1,4}\s*号?|无座)/);
        if (sm) { seg.seat = sm[0].replace(/\s/g, '').replace(/[,，]/g, '').replace(/[（）()]/g, ''); break; }
      }
    } else {
      // 航班：出发 = 航班号上方最近的"时间行"，到达 = 下方最近的"时间行"
      let depIdx = nearestTimeRow(lines, i, -1, 4);
      let arrIdx = nearestTimeRow(lines, i, +1, 4);
      // 航班号上方没有时间行时：下方第一个时间行 = 出发，再下一个 = 到达
      if (depIdx < 0 && arrIdx >= 0) {
        const second = nearestTimeRow(lines, arrIdx, +1, 4);
        if (second >= 0) { depIdx = arrIdx; arrIdx = second; }
      }
      if (depIdx >= 0) {
        const row = lines[depIdx];
        seg.depTime = U.normalizeTime(row.match(/\d{1,2}[:：]\d{2}/)[0]);
        const st = stationFromRow(row) || stationFromRow(lines[depIdx + 1] || '') || stationFromRow(lines[depIdx - 1] || '');
        if (st) { const s = splitStation(st); seg.depCity = s.city; seg.depStation = s.station; }
      }
      if (arrIdx >= 0) {
        const row = lines[arrIdx];
        const tm = row.match(/\d{1,2}[:：]\d{2}/);
        seg.arrTime = U.normalizeTime(tm[0]);
        const st = stationFromRow(row) || stationFromRow(lines[arrIdx + 1] || '') || stationFromRow(lines[arrIdx - 1] || '');
        if (st) { const s = splitStation(st); seg.arrCity = s.city; seg.arrStation = s.station; }
      }
      if (!seg.depTime) {
        for (let j = i - 1; j >= Math.max(0, i - 4) && !seg.depTime; j--) {
          const t = lines[j].match(/\d{1,2}[:：]\d{2}/); if (t) seg.depTime = U.normalizeTime(t[0]);
        }
      }
      if (!seg.arrTime) {
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4) && !seg.arrTime; j++) {
          const t = lines[j].match(/\d{1,2}[:：]\d{2}/); if (t) seg.arrTime = U.normalizeTime(t[0]);
        }
      }
      for (let j = i - 1; j >= Math.max(0, i - 4) && !seg.date; j--) {
        const dm = lines[j].match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日?/);
        if (dm) seg.date = U.normalizeDate(dm[0]);
      }
      if (!seg.date) seg.date = firstDateAnywhere(lines);
    }
    if (seg.date) seg.weekday = U.weekdayOf(seg.date);
    segs.push(seg);
  }
  return segs;
}

function nearestTimeRow(lines, i, dir, max) {
  for (let j = i + dir; j >= 0 && j < lines.length && Math.abs(j - i) <= max; j += dir) {
    if (TIME_RE.test(lines[j])) return j;
  }
  return -1;
}

function firstDateAnywhere(lines) {
  for (const raw of lines) {
    const l = protectTimeRange(raw);   // 防止把时间段里的"10-12"当成日期
    const dm = l.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日?/);
    if (dm) return U.normalizeDate(dm[0]);
  }
  return '';
}

function stationFromRow(row) {
  const s = row.replace(/\d{1,2}[:：]\d{2}/g, ' ').replace(/\s+/g, '');
  return pickPlace(s);
}

function pickPlace(s) {
  const tokens = (s.match(/[一-龥]{2,10}(?:T\d+|机场|站)?|T\d+/g) || []).map(clean).map(stripLeadVerb).filter(isStationToken);
  return bestPlace(tokens);
}

function stripLeadVerb(t) { return (t || '').replace(/^[到往飞去]/, ''); }

function bestPlace(tokens) {
  if (!tokens.length) return '';
  const suff = tokens.filter(t => /(T\d+|机场|站)$/.test(t));
  if (suff.length) return suff[suff.length - 1];
  return tokens[tokens.length - 1];
}

function isStationToken(t) {
  return t && t.length >= 2 && t.length <= 16 && !STATION_STOP.test(t);
}
function lastStation(s) {
  const tokens = pickTokens(s);
  return tokens.length ? tokens[tokens.length - 1] : '';
}
function firstStation(s) {
  const tokens = pickTokens(s);
  return tokens.length ? tokens[0] : '';
}
function pickTokens(s) {
  return ((s || '').match(/[一-龥]{2,10}(?:T\d+|机场|站)?/g) || []).map(clean).map(stripLeadVerb).filter(isStationToken);
}
function lookStation(lines, i, dir) {
  for (let j = i + dir; j >= 0 && j < lines.length && Math.abs(j - i) <= 2; j += dir) {
    const tokens = pickTokens(lines[j]);
    if (tokens.length) return dir < 0 ? tokens[tokens.length - 1] : tokens[0];
  }
  return '';
}

// 保护"10:10-12:30"这类时间段，防止"10-12"被当成 10月12日
function protectTimeRange(line) {
  return String(line || '').replace(
    /(\d{1,2}[:：]\d{2})\s*[-—–~～至到]\s*(\d{1,2}[:：]\d{2})/g,
    '$1至$2'
  );
}

// 单行解析：支持 "日期，航班/车次，出发地站点(时间)→到达地站点(时间)"、
// "杭州-深圳，2026-11-13萧山T4--宝安T3，南方航空CZ3798航班，14:55萧山T4起飞17:20抵达" 等
function parseLine(rawLine) {
  const line = protectTimeRange(rawLine);
  const seg = blankSeg();

  let dm = line.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/)
        || line.match(/\d{1,2}月\d{1,2}日?/)
        || line.match(/(?<!\d)\d{1,2}[-/]\d{1,2}(?!\d)/);
  if (dm) {
    seg.date = U.normalizeDate(dm[0]);
    seg.weekday = seg.date ? U.weekdayOf(seg.date) : '';
  }

  const flightM = line.match(FLIGHT_RE);
  const train = flightM ? null : findTrain(line);
  if (flightM) {
    seg.flightNo = flightM[0]; seg.type = 'flight';
    const op = line.replace(/\s/g, '').match(OP_FLIGHT_RE);
    if (op) seg.flightNo = `${seg.flightNo}(实承${op[1] || op[2]})`;
  }
  else if (train) { seg.trainNo = train.no; seg.type = 'train'; }

  // 座位：火车"X车厢X号 / 无座"；机票仅在明确写了"座位"时才取
  if (seg.type === 'train') {
    const seatM = line.match(/((?:二等|一等|商务|特等|高级?|动卧|硬|软)?座?\s*[（(]?\s*\d{1,2}\s*车\s*厢?\s*[,，]?\s*[0-9A-Za-z]{1,4}\s*号?|无座)/);
    if (seatM) seg.seat = seatM[0].replace(/\s/g, '').replace(/[,，]/g, '').replace(/[（）()]/g, '');
  } else {
    const seatM = line.match(/(?:座位|seat)[^0-9A-Za-z]{0,4}([0-9]{1,2}[A-Fa-f]|[A-Fa-f]\d{1,2})/);
    if (seatM) seg.seat = seatM[1].toUpperCase();
  }

  let body = cleanBody(line);

  const parts = body.split(/→|->|－|—|–|-|-->/);
  if (parts.length >= 2) {
    const left = sideInfo(parts.slice(0, parts.length - 1).join(' '));
    const right = sideInfo(parts[parts.length - 1]);
    if (left.time) seg.depTime = left.time;
    if (right.time) seg.arrTime = right.time;
    if (left.place) { const s = splitStation(left.place); seg.depCity = s.city; seg.depStation = s.station; }
    if (right.place) { const s = splitStation(right.place); seg.arrCity = s.city; seg.arrStation = s.station; }
  }

  // 没有箭头：按出现顺序取前两个时间 + 前两个地点
  if (!seg.depTime && !seg.arrTime) {
    const times = (body.match(/\d{1,2}[:：]\d{2}/g) || []);
    if (times.length >= 2) { seg.depTime = U.normalizeTime(times[0]); seg.arrTime = U.normalizeTime(times[1]); }
    else if (times.length === 1) seg.depTime = U.normalizeTime(times[0]);
  }
  if (!seg.depCity && !seg.arrCity) {
    const ps = pickTokens(body.replace(/\d{1,2}[:：]\d{2}/g, ' '));
    const pick = pickPair(ps);
    if (pick && pick[0]) {
      const a = splitStation(pick[0]);
      seg.depCity = a.city; seg.depStation = a.station;
      if (pick[1]) { const b = splitStation(pick[1]); seg.arrCity = b.city; seg.arrStation = b.station; }
    }
  }

  // 机票"起飞/抵达"版式（如 携程短信）："14:55萧山T4起飞17:20抵达" +
  // 头部机场配对"萧山T4--宝安T3"。起飞时间=出发、抵达时间=到达，机场对=起讫。
  // 此版式下不再信任按短横线拆分出的地点（会把到达机场误当出发地）。
  if (seg.type === 'flight' && /起飞|降落|落地|抵达/.test(line)) {
    const flat = clean(line);
    const to = flat.match(/(\d{1,2}[:：]\d{2})([一-龥A-Za-z0-9]{0,10}?)起飞/);
    const ld = flat.match(/(\d{1,2}[:：]\d{2})([一-龥A-Za-z0-9]{0,10}?)?(?:抵达|降落|落地|到达)/);
    if (to) {
      seg.depTime = U.normalizeTime(to[1]);
      const st = splitStation(to[2] || '');
      if (st.city) { seg.depCity = st.city; seg.depStation = st.station; }
    }
    if (ld) {
      seg.arrTime = U.normalizeTime(ld[1]);
      const st = splitStation(ld[2] || '');
      if (st.city) { seg.arrCity = st.city; seg.arrStation = st.station; }
    }
    // 起讫机场兜底（起飞点未识别 / 抵达点未写明时，取机场对的首尾）
    const pair = flat.match(/([一-龥]{2,8}T\d+)[-—–~]{1,2}([一-龥]{2,8}T\d+)/);
    if (pair) {
      const a = splitStation(pair[1]), b = splitStation(pair[2]);
      if (!seg.depCity && a.city) { seg.depCity = a.city; seg.depStation = a.station; }
      if (!ld || !splitStation(ld[2] || '').city) {
        if (b.city) { seg.arrCity = b.city; seg.arrStation = b.station; }
      }
    }
  }

  if (!seg.flightNo && !seg.trainNo && !seg.depTime && !seg.depCity) return null; // 非行程行
  return seg;
}

// 清洗掉日期/车次/航班号/座位/星期/长数字等噪声
function cleanBody(line) {
  return (line || '')
    .replace(/[一-龥]{2,4}\s*[（(]\s*证件号码[：:]?\s*\d{0,}\s*[）)]?/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\d{5,}/g, ' ')
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, ' ')
    .replace(/\d{1,2}月\d{1,2}日?/g, ' ')
    .replace(/(?<!\d)\d{1,2}[-/]\d{1,2}(?!\d)/g, ' ')
    .replace(/(?<![一-龥])([A-Z]{2}\d{3,4}|[GCDKTZ]\d{1,4})\b/g, ' ')
    .replace(/周[一二三四五六日天]/g, ' ')
    .replace(/\d{1,2}\s*车\s*厢?\s*[0-9A-Za-z]{1,4}\s*号?/g, ' ')
    .replace(/无座/g, ' ');
}

function pickPair(ps) {
  if (!ps.length) return null;
  const suff = ps.filter(t => /(T\d+|机场|站)$/.test(t));
  const pool = suff.length >= 2 ? suff : ps;
  if (pool.length === 1) return [pool[0], null];
  const a = pool[0], b = pool[pool.length - 1];
  return a === b ? [a, null] : [a, b];
}

function sideInfo(side) {
  const tm = side.match(/\d{1,2}[:：]\d{2}/);
  const place = pickPlace(side.replace(/\d{1,2}[:：]\d{2}/g, ' '));
  return { time: tm ? U.normalizeTime(tm[0]) : '', place };
}

// "石家庄正定T2" -> {city:'正定', station:'T2'}；"石家庄站" -> {city:'石家庄', station:'站'}
function splitStation(s) {
  if (!s) return { city: '', station: '' };
  let m = s.match(/^(.*?)(T\d+)$/);
  if (m) return { city: trimCity(m[1]), station: m[2].toUpperCase() };
  m = s.match(/^(.*?)(机场|站)$/);
  if (m) return { city: trimCity(m[1]), station: m[2] };
  return { city: trimCity(s), station: '' };
}

// 去掉城市前缀与"机场"后缀，让话术显示"萧山T4 / 宝安T3 / 广州南"
function trimCity(name) {
  let n = (name || '').trim();
  if (!n) return '';
  for (const c of CITY_PREFIX) {
    if (n.length > c.length && n.indexOf(c) === 0 && n.length - c.length >= 2) n = n.slice(c.length);
  }
  n = n.replace(/(国际)?机场$/, '');
  return n;
}

function clean(s) { return (s || '').replace(/\s/g, ''); }

// ---------- 高管匹配 ----------
const KEY_STRONG = /(乘机人|乘车人|登机人)/;
const KEY_ANY = /(乘机人|乘车人|登机人|旅客|乘客|出行人)/;

function passengerName(text) {
  return grabNameAfter(text, KEY_STRONG) || grabNameAfter(text, KEY_ANY);
}

function grabNameAfter(text, KEY) {
  const lines = String(text || '').split(/[\n\r]+/);
  for (let i = 0; i < lines.length; i++) {
    if (!KEY.test(lines[i])) continue;
    const parts = [lines[i].replace(/^.*?(乘机人|乘车人|登机人|旅客|乘客|出行人)/, '')];
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 2); j++) parts.push(lines[j]);
    for (const p of parts) {
      const c = firstChineseName(p);
      if (c) return c;
    }
  }
  return '';
}

const NAME_BAD_HEAD = /^[出待已票订购乘联身申备值退改签付款经头公舱座食信手编日时周星总副请祝]/;

function firstChineseName(s) {
  const c = ((s || '').replace(/\s/g, '').match(/[一-龥]{2,4}/) || [''])[0];
  if (!c) return '';
  if (NAME_BAD_HEAD.test(c)) return '';
  if (/(成人|儿童|婴儿|证件|身份证|票号|座位|联系人|手机|电话|经济|经济舱|头等|公务|其他|信息|申请单|备注|保险|出票|订单|餐食|机型|空客|波音|准点|随行|登机|值机)/.test(c)) return '';
  return c;
}

// 宽容匹配：OCR 可能认错 1 个字；多位候选无法判定时返回空，交由人工选择
function fuzzyMatchExec(flat, list) {
  const cands = new Set();
  for (const e of list) {
    const n = (e.name || '').replace(/\s/g, '');
    if (n.length < 2 || n.length > 4) continue;
    for (let i = 0; i + n.length <= flat.length; i++) {
      let diff = 0;
      for (let k = 0; k < n.length; k++) if (flat[i + k] !== n[k]) diff++;
      if (diff === 0) return e.name;      // 精确命中
      if (diff === 1) cands.add(e.name);
    }
  }
  return cands.size === 1 ? [...cands][0] : '';
}

// 按名单匹配高管：精确姓名（长的优先）→ 称呼 → OCR 模糊 → 乘机人 → "X总"姓氏 → 乘机人姓名
function matchExecName(text, execList) {
  try {
    const flat = String(text || '').replace(/\s/g, '');
    const list = (execList || []).filter(e => e.name && e.active !== false).sort((a, b) => b.name.length - a.name.length);
    for (const e of list) {
      if (e.name && flat.indexOf(e.name) >= 0) return e.name;
    }
    for (const e of list) {
      if (e.title && e.title.length >= 2 && flat.indexOf(e.title) >= 0) return e.name;
    }
    const fz = fuzzyMatchExec(flat, list);
    if (fz) return fz;
    const pn = passengerName(text);
    if (pn) {
      for (const e of list) {
        if (e.name && (e.name.indexOf(pn) === 0 || pn.indexOf(e.name) === 0)) return e.name;
      }
    }
    const m = flat.match(/([一-龥]{1,2})总/);
    if (m) {
      const cands = list.filter(e => e.name && e.name.indexOf(m[1]) === 0);
      if (cands.length === 1) return cands[0].name;
      return m[1];
    }
    if (pn) return pn;
  } catch (e) {}
  return '';
}

// 对外主入口：解析 + 高管匹配 + 纯约车兜底
// execList 传入高管名单时可自动识别乘机人，纯约车文本会剔除姓名再拆起讫
function parseText(text, execList) {
  const execName = matchExecName(text, execList || []);
  let segs = parse(text);
  let carHint = null;
  if (!segs.length) {
    const c = parseCar(text, execName);
    if (c) { segs = [c.seg]; carHint = c.hint; }
  }
  return { segments: segs.map(s => Object.assign({ raw: String(text || '') }, s)), execName, carHint };
}

module.exports = { parseText, parse, parseCar, matchExecName, passengerName };
