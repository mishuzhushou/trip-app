// 解析记忆 + 高管电话回写 + OCR 坐标行还原 自测
// 用法：先以全新 DATA_DIR 启动服务（例：DATA_DIR=.test-learn PORT=3997 node server.js），再 node scripts/test-learn.js
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3997';
let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
async function api(path, body, token) {
  const r = await fetch(BASE + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}

(async () => {
  // ---------- OCR 坐标行还原（对齐小程序 ocrService/rowsFromItems） ----------
  const ocr = require('../src/ocr.js');
  const rows = ocr.rowsFromDetections([
    { DetectedText: '右边的字', ItemPolygon: { X: 200, Y: 10, Width: 60, Height: 20 } },
    { DetectedText: '左边的字', ItemPolygon: { X: 10, Y: 11, Width: 60, Height: 20 } },
    { DetectedText: '第二行', Polygon: [{ X: 10, Y: 60 }, { X: 80, Y: 60 }, { X: 80, Y: 80 }, { X: 10, Y: 80 }] }
  ]);
  ck('同一视觉行按 x 排序合并', rows[0] === '左边的字 右边的字', rows);
  ck('不同视觉行分行', rows.length === 2 && rows[1] === '第二行', rows);

  // ---------- 账号 / 高管 ----------
  let r = await api('/register', { username: 'boss', password: '123456', name: '管理员' });
  ck('注册首个账号为管理员', r.ok === true, r);
  const A = (await api('/login', { username: 'boss', password: '123456' })).token;
  ck('管理员登录', !!A);
  r = await api('/admin/execs', { name: '罗庆南', title: '罗总', phone: '' }, A);
  ck('新增高管', r.ok === true, r);
  const ex = (await api('/admin/users', undefined, A)).execs.find(e => e.name === '罗庆南');
  ck('高管已落库', !!ex, ex);

  r = await api('/admin/users', { username: 'sec1', password: '123456', name: '小王', role: 'sec' }, A);
  ck('新增成员', r.ok === true, r);
  const secId = (await api('/admin/users', undefined, A)).users.find(u => u.username === 'sec1').id;
  r = await api('/admin/users/' + secId, { execIds: [ex.id] }, A);
  ck('成员分配负责高管', r.ok === true, r);
  const S = (await api('/login', { username: 'sec1', password: '123456' })).token;
  ck('成员登录', !!S);

  // ---------- 解析记忆 ----------
  const raw = '11月16日 明天\n14:09 顺德 18:11 广州南\nC7740\nG638\n广州南 韶关';
  let p = await api('/parse', { text: raw }, S);
  ck('首次解析无记忆标记', p.ok === true && !p.learned, p);
  const corrected = [
    { date: '2026-11-16', weekday: '周一', type: 'train', flightNo: '', trainNo: 'C7740', depCity: '顺德', depStation: '', depTime: '14:09', arrCity: '广州南', arrStation: '', arrTime: '18:11', seat: '二等座' },
    { date: '2026-11-16', weekday: '周一', type: 'train', flightNo: '', trainNo: 'G638', depCity: '广州南', depStation: '', depTime: '15:41', arrCity: '韶关', arrStation: '', arrTime: '16:58', seat: '' }
  ];
  r = await api('/learn', { raw, segments: corrected, execId: ex.id }, S);
  ck('保存人工修正样本', r.ok === true, r);
  p = await api('/parse', { text: raw }, S);
  ck('再次解析命中记忆', p.learned === true, p);
  ck('记忆返回修正后的段', Array.isArray(p.segments) && p.segments.length === 2
    && p.segments[0].trainNo === 'C7740' && p.segments[1].depTime === '15:41', p.segments);
  ck('记忆返回高管', p.execName === '罗庆南', p.execName);
  // 指纹命中：同一订单 OCR 措辞略有差异，但车次集合与时间集合相同
  const raw2 = '11月16日 明天\n14:09 顺德 18:11 广州南\nC7740 次\nG638 次\n广州南 韶关 检票口A8';
  p = await api('/parse', { text: raw2 }, S);
  ck('车次时间指纹模糊命中', p.learned === true, p);
  let sm = await api('/admin/samples', undefined, A);
  ck('样本列表可见', sm.ok === true && sm.samples.length === 1 && sm.samples[0].hits >= 2, sm.samples);
  r = await api('/admin/samples/' + sm.samples[0].id + '/delete', {}, A);
  ck('删除单条样本', r.ok === true, r);
  sm = await api('/admin/samples', undefined, A);
  ck('删除后列表为空', sm.samples.length === 0, sm.samples);
  await api('/learn', { raw, segments: corrected, execId: ex.id }, S);
  r = await api('/admin/samples/clear', {}, A);
  ck('清空全部样本', r.ok === true, r);
  sm = await api('/admin/samples', undefined, A);
  ck('清空后为空', sm.samples.length === 0, sm.samples);

  // ---------- 高管电话自动回写 ----------
  r = await api('/execs/' + ex.id + '/phone', { phone: '13800001111' }, S);
  ck('成员可更新自己负责的高管电话', r.ok === true && r.exec.phone === '13800001111', r);
  let gs = await api('/execs', undefined, S);
  ck('高管档案电话已更新', gs.execs.find(e => e.id === ex.id).phone === '13800001111', gs.execs);
  r = await api('/execs/' + ex.id + '/phone', { phone: 'abc' }, S);
  ck('非法电话被拒', r.ok !== true && !!r.error, r);

  // ---------- 解析器回归：多段共用时间行不再全部套同一时间 ----------
  const parser = require('../src/parser.js');
  const pr = parser.parseText('11月16日明天\n14:09 顺德 18:11 广州南\nG5\nC7740\nG638\n广州南 韶关', []);
  const withTime = pr.segments.filter(s => s.depTime && s.arrTime);
  ck('同一时间行最多保留一段', withTime.length <= 1, pr.segments);
  // 机票"起飞/抵达"版式不回归
  const fl = parser.parseText('杭州-深圳，2026-11-13萧山T4--宝安T3，CZ3798，14:55萧山T4起飞17:20抵达，乘机人丁春明', [{ name: '丁春明', title: '丁总' }]);
  ck('机票版式回归', fl.segments.length === 1 && fl.segments[0].flightNo === 'CZ3798'
    && fl.segments[0].depTime === '14:55' && fl.segments[0].arrTime === '17:20' && fl.execName === '丁春明', fl);
  // 真车次"G5次"仍能识别（噪声过滤不能误伤真车次）
  const g5 = parser.parseText('11月16日 G5次 北京南(09:00)-上海虹桥(13:30)', []);
  ck('真车次G5次不误伤', g5.segments.length === 1 && g5.segments[0].trainNo === 'G5' && g5.segments[0].depTime === '09:00', g5.segments);
  // 用户真实订单（12306 联程截图，含状态栏 5G/G5G 噪声）应正确解析两段
  const orderText = [
    '1:08 支 5G G5G 55 分', '订单详情', '客服 更多',
    '1程取票号:E743706678+纪念车票 B检票口', '11月16日明天 11月16日明天',
    '14:12 经停信息 14:23', '顺德 C7740.11分 广州南',
    '罗庾南身份证 二等座￥9 靠窗 07车厢07F号',
    '广州南·同站换乘需在25分内换乘', '2程取票号:E743706678 检票口8或A8',
    '11月16日明天 11月16日明天', '14:48 经停信息 15:41', '广州南 G638·53分 韶关',
    '罗庾南身份证 二等座￥95过道06车厢13C号'
  ].join('\n');
  const real = parser.parseText(orderText, [{ name: '罗庆南', title: '罗总' }]);
  ck('联程订单解析出两段', real.segments.length === 2, real.segments);
  ck('状态栏G5G不误判为车次', !real.segments.some(s => s.trainNo === 'G5'), real.segments);
  ck('第1段 C7740 顺德→广州南', real.segments[0] && real.segments[0].trainNo === 'C7740'
    && real.segments[0].depCity === '顺德' && real.segments[0].arrCity === '广州南'
    && real.segments[0].depTime === '14:12' && real.segments[0].arrTime === '14:23'
    && real.segments[0].seat === '07车厢07F号', real.segments[0]);
  ck('第2段 G638 广州南→韶关', real.segments[1] && real.segments[1].trainNo === 'G638'
    && real.segments[1].depCity === '广州南' && real.segments[1].arrCity === '韶关'
    && real.segments[1].depTime === '14:48' && real.segments[1].arrTime === '15:41', real.segments[1]);
  ck('模糊匹配到罗庆南', real.execName === '罗庆南', real.execName);

  // ---------- 回归：电量并入信号被读成"5G5G55"，曾误判为 G55 车次 + 1:08 出发 ----------
  const noiseText = orderText.replace('1:08 支 5G G5G 55 分', '1:08 支 5G5G55 分');
  const noise = parser.parseText(noiseText, [{ name: '罗庆南', title: '罗总' }]);
  ck('5G5G55电量噪声不误判为G55', noise.segments.length === 2
    && !noise.segments.some(s => s.trainNo === 'G55' || s.depTime === '01:08'), noise.segments);
  ck('5G5G55场景下仍正确解析两段', noise.segments[0] && noise.segments[0].trainNo === 'C7740'
    && noise.segments[1] && noise.segments[1].trainNo === 'G638', noise.segments);
  // 状态栏整行剔除后，纯状态栏文本不应产出任何行程
  const onlyBar = parser.parseText('1:08 支 5G5G55 分\n10:43 5G 94', []);
  ck('纯状态栏不产出假行程', onlyBar.segments.length === 0, onlyBar.segments);

  console.log('\n结果: PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
