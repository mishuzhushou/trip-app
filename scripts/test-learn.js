// 解析记忆 + 高管电话回写 + OCR 坐标行还原 自测
// 用法：先以全新 DATA_DIR 启动服务（例：DATA_DIR=.test-learn PORT=3997 node server.js），再 node scripts/test-learn.js
const BASE = process.env.TEST_BASE || 'http://localhost:3997';
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

  console.log('\n结果: PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
