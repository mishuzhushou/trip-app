// 本地功能自测：hourly 催办去重 / 编辑保存（segments 同步、execId 修改、字段清空）/ 已约车后静默
// 用法：先启动本地服务（独立 DATA_DIR + 假 webhook key），再 node scripts/test-local.js
const BASE = process.env.BASE || 'http://127.0.0.1:3212';
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`); }
}
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
function bjDay(n) { // n=0 今天, 1 明天（北京时区安全算法）
  const s = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return new Date(Date.parse(s + 'T00:00:00+08:00') + n * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}
(async () => {
  // 0. 健康检查
  const h = await api('GET', '/api/health');
  ok('health', h.status === 200 && h.data.ok, JSON.stringify(h.data));

  // 1. 注册管理员 + 登录（测试库是全新的，第一个注册者即管理员）
  const reg = await api('POST', '/api/register', { username: 'testadmin', password: 'test123456', name: '测试管理员' });
  ok('register', reg.status === 200 || (reg.data || {}).error === '系统已初始化，请联系管理员开通账号', reg.data);
  const login = await api('POST', '/api/login', { username: 'testadmin', password: 'test123456' });
  ok('login', login.status === 200 && !!login.data.token);
  const T = login.data.token;

  // 2. 建高管
  const e1 = await api('POST', '/api/admin/execs', { name: '张三', title: '副总裁' }, T);
  const e2 = await api('POST', '/api/admin/execs', { name: '李四', title: '财务总监' }, T);
  ok('create execs', e1.status === 200 && e2.status === 200, { e1: e1.data, e2: e2.data });
  const idA = e1.data.exec.id;
  const idB = e2.data.exec.id;
  ok('exec ids', !!idA && !!idB);

  // 3. 造行程：今天张三未约车 / 明天王工未约车 / 明天李四已约车 / 明天李四不需车
  const today = bjDay(0), tmrw = bjDay(1);
  const mk = (execId, execName, date, needCar, carBooked, extra) =>
    api('POST', '/api/trips', Object.assign({
      execId, execName, date, weekday: '周X', no: 'T' + Math.random().toString(36).slice(2, 8),
      vehicle: '高铁', depCity: '广州', depTime: '09:00', arrCity: '上海', arrTime: '12:00',
      needCar, carBooked
    }, extra || {}), T);
  const t1 = await mk(idA, '张三', today, true, false, {
    segments: [{ flightNo: 'CZ3101', depCity: '广州', depTime: '08:30', arrCity: '北京', arrTime: '11:30' }],
    carType: '送机/站', pickupTime: '07:30', pickupAddr: '白云电器'
  });
  const t2 = await mk(idA, '张三', tmrw, true, false, {});
  const t3raw = await mk(idB, '李四', tmrw, true, false, {});
  const t4 = await mk(idB, '李四', tmrw, 0, 0, {});
  ok('create trips x4', [t1, t2, t3raw, t4].every(x => x.status === 200), [t1, t2, t3raw, t4].map(x => x.data));
  // 创建接口强制 carBooked=0，用编辑接口把 t3 置为已约车
  const t3 = { data: { id: t3raw.data.trip.id } };
  await api('POST', '/api/trips/' + t3.data.id, { carBooked: true }, T);

  // 4. hourly 催办（第 1 次）：应尝试推送（假 webhook 会报 errcode，但证明链路打通），待约=2
  const r1 = await api('GET', '/api/cron/remind?mode=hourly&key=testcron123');
  ok('hourly #1 attempted', r1.status === 200 && !r1.data.skipped, r1.data);

  // 5. hourly 催办（第 2 次，同一小时）：应被去重跳过
  const r2 = await api('GET', '/api/cron/remind?mode=hourly&key=testcron123');
  ok('hourly #2 deduped', r2.status === 200 && r2.data.skipped === true, r2.data);

  // 6. 编辑行程 t2：勾选已约车 + 改为多段行程 + 换高管到李四
  const edit = await api('POST', '/api/trips/' + t2.data.trip.id, {
    carBooked: true, carInfo: '粤A88888 王师傅 13800000000',
    execId: idB,
    segments: [
      { flightNo: 'G65', depCity: '广州南', depTime: '08:00', arrCity: '长沙南', arrTime: '10:30' },
      { trainNo: 'G1421', depCity: '长沙南', depTime: '11:00', arrCity: '武汉', arrTime: '13:20' }
    ]
  }, T);
  ok('edit trip t2', edit.status === 200, edit.data);
  const after = await api('GET', '/api/trips', null, T);
  const t2b = after.data.trips.find(x => x.id === t2.data.trip.id);
  ok('t2 carBooked persisted', t2b && t2b.carBooked == true, t2b);
  ok('t2 execId changed', t2b && t2b.execId === idB, { execId: t2b && t2b.execId });
  ok('t2 first-seg synced to flat fields', t2b && t2b.no === 'G65' && t2b.depCity === '广州南' && t2b.arrTime === '10:30', { no: t2b.no, dep: t2b.depCity, arr: t2b.arrTime });

  // 7. 清空字段（pickupAddr / pickupTime 置空）
  const clear = await api('POST', '/api/trips/' + t1.data.trip.id, { pickupAddr: '', pickupTime: '' }, T);
  ok('clear fields accepted', clear.status === 200, clear.data);
  const after2 = await api('GET', '/api/trips', null, T);
  const t1b = after2.data.trips.find(x => x.id === t1.data.trip.id);
  ok('t1 pickupAddr cleared', t1b && !t1b.pickupAddr, { pickupAddr: t1b.pickupAddr });

  // 8. 强制 hourly：此刻未约车只剩 t1（今天张三），待约=1；且 t2 已约车不进入统计
  const r3 = await api('GET', '/api/cron/remind?mode=hourly&key=testcron123&force=1');
  ok('hourly force=1 counts 1 pending', r3.status === 200 && r3.data.trips === 1, r3.data);

  // 9. t1 也勾选已约车后强制催办：待约=0，静默且不占坑
  await api('POST', '/api/trips/' + t1.data.trip.id, { carBooked: true }, T);
  const r4 = await api('GET', '/api/cron/remind?mode=hourly&key=testcron123&force=1');
  ok('hourly all booked => silent, no slot', r4.status === 200 && r4.data.trips === 0, r4.data);

  // 10. morning 模式 force=1（全部已约）：也应为 0
  const r5 = await api('GET', '/api/cron/remind?mode=morning&key=testcron123&force=1');
  ok('morning all booked => 0 pending', r5.status === 200 && r5.data.trips === 0, r5.data);

  console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
