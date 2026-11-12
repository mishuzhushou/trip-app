// 本地功能自测（第二轮）：成员管理（拉黑/移除）、申请负责高管与审批、高管批量添加与重复替换、历史范围查询
// 用法：先用全新 DATA_DIR 启动服务，再 node scripts/test-admin.js
const BASE = process.env.BASE || 'http://127.0.0.1:3212';
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${JSON.stringify(detail)}`); }
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
function bjDay(n) {
  const s = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return new Date(Date.parse(s + 'T00:00:00+08:00') + n * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}
(async () => {
  // 0. 初始化：注册管理员（新库）、建高管与行程
  await api('POST', '/api/register', { username: 'root', password: 'root123456', name: '管理员' });
  const A = (await api('POST', '/api/login', { username: 'root', password: 'root123456' })).data.token;
  const e1 = (await api('POST', '/api/admin/execs', { name: '张三', title: '副总裁', phone: '13811112222' }, A)).data.exec;
  const e2 = (await api('POST', '/api/admin/execs', { name: '李四', title: '财务总监' }, A)).data.exec;
  const today = bjDay(0), tmrw = bjDay(1), lastYear = bjDay(-400);
  await api('POST', '/api/trips', { execId: e1.id, date: today, no: 'G101', depCity: '广州', depTime: '09:00', arrCity: '上海', arrTime: '12:00', needCar: 1 }, A);
  await api('POST', '/api/trips', { execId: e2.id, date: tmrw, no: 'G202', depCity: '广州', depTime: '10:00', arrCity: '长沙', arrTime: '13:00', needCar: 0 }, A);
  await api('POST', '/api/trips', { execId: e1.id, date: lastYear, no: 'G000', depCity: '广州', depTime: '08:00', arrCity: '北京', arrTime: '11:00', needCar: 0 }, A);

  // 1. 新增成员账号（秘书）
  const cu = await api('POST', '/api/admin/users', { username: 'sec1', password: 'sec123456', name: '小陈', role: 'sec' }, A);
  ok('create member', cu.status === 200 && cu.data.user.role === 'sec', cu.data);
  const sec1Id = cu.data.user.id;

  // 2. 成员登录，看全部高管（mine=false）
  const M = (await api('POST', '/api/login', { username: 'sec1', password: 'sec123456' })).data.token;
  const ge = await api('GET', '/api/execs', null, M);
  ok('member sees all execs', ge.status === 200 && ge.data.execs.length === 2 && ge.data.execs.every(e => e.mine === false), ge.data);

  // 3. 成员申请负责张三 → 管理员收到待审批 → 同意 → 成员可见张三行程
  const ap1 = await api('POST', '/api/apply-exec', { execId: e1.id }, M);
  ok('member applies', ap1.status === 200 && ap1.data.apply.status === 'pending', ap1.data);
  const ap2 = await api('POST', '/api/apply-exec', { execId: e1.id }, M);
  ok('duplicate apply rejected', ap2.status === 400, ap2.data);
  const listA = await api('GET', '/api/admin/applies', null, A);
  ok('admin sees 1 pending', listA.status === 200 && listA.data.applies.length === 1, listA.data);
  const okA = await api('POST', '/api/admin/applies/' + ap1.data.apply.id, { action: 'approve' }, A);
  ok('admin approves', okA.status === 200 && okA.data.apply.status === 'approved', okA.data);
  const myTrips = await api('GET', '/api/trips', null, M);
  ok('member sees approved exec trips', myTrips.status === 200 && myTrips.data.trips.length === 2 && myTrips.data.execs.length === 1, { trips: myTrips.data.trips.length, execs: myTrips.data.execs.map(x => x.name) });

  // 4. 拉黑成员 → 无法登录 → 解除 → 可登录
  const blk = await api('POST', '/api/admin/users/' + sec1Id, { status: 'blocked' }, A);
  ok('blacklist member', blk.status === 200 && blk.data.user.status === 'blocked', blk.data);
  const l1 = await api('POST', '/api/login', { username: 'sec1', password: 'sec123456' });
  ok('blocked cannot login', l1.status === 401, l1.data);
  await api('POST', '/api/admin/users/' + sec1Id, { status: 'active' }, A);
  const l2 = await api('POST', '/api/login', { username: 'sec1', password: 'sec123456' });
  ok('unblock can login again', l2.status === 200, l2.data);

  // 5. 移除成员 → 账号消失、无法登录；不能移除自己
  const del = await api('POST', '/api/admin/users/' + sec1Id + '/delete', {}, A);
  ok('remove member', del.status === 200, del.data);
  const l3 = await api('POST', '/api/login', { username: 'sec1', password: 'sec123456' });
  ok('removed cannot login', l3.status === 401, l3.data);
  const users = await api('GET', '/api/admin/users', null, A);
  ok('member gone from list', users.data.users.length === 1 && users.data.users[0].username === 'root', users.data.users);
  const me = users.data.users[0];
  const delSelf = await api('POST', '/api/admin/users/' + me.id + '/delete', {}, A);
  ok('cannot remove self', delSelf.status === 400, delSelf.data);

  // 6. 批量添加高管：检查模式（重复返回，不覆盖）
  const b1 = await api('POST', '/api/admin/execs/batch', {
    items: [{ name: '张三', title: '新称呼', phone: '13900001111' }, { name: '赵六', title: '总监', phone: '13700002222' }]
  }, A);
  ok('batch check mode flags duplicate', b1.status === 200 && b1.data.needConfirm === true && b1.data.added.includes('赵六') && b1.data.duplicates.length === 1, b1.data);
  const execList = await api('GET', '/api/execs', null, A);
  const zs = execList.data.execs.find(x => x.name === '张三');
  ok('check mode does not overwrite', zs.title === '副总裁' && zs.phone === '13811112222', zs);

  // 7. 确认替换：仅替换张三信息
  const b2 = await api('POST', '/api/admin/execs/batch', {
    items: [{ name: '张三', title: '新称呼', phone: '13900001111' }], replaceNames: ['张三']
  }, A);
  ok('batch replace confirmed', b2.status === 200 && b2.data.replaced.includes('张三'), b2.data);
  const execList2 = await api('GET', '/api/execs', null, A);
  const zs2 = execList2.data.execs.find(x => x.name === '张三');
  ok('replaced info persisted', zs2.title === '新称呼' && zs2.phone === '13900001111', zs2);

  // 8. 高管单条编辑（姓名/称呼/电话）
  const ed = await api('POST', '/api/admin/execs/' + e2.id, { name: '李四四', title: 'CFO', phone: '13655556666' }, A);
  ok('edit exec info', ed.status === 200 && ed.data.exec.name === '李四四' && ed.data.exec.phone === '13655556666', ed.data);

  // 9. 历史范围查询 from/to
  const r1 = await api('GET', '/api/trips?from=' + today + '&to=' + tmrw, null, A);
  ok('history range today~tomorrow', r1.status === 200 && r1.data.trips.length === 2, r1.data.trips.map(t => t.date));
  const r2 = await api('GET', '/api/trips?from=' + lastYear + '&to=' + today, null, A);
  ok('history range past~today', r2.status === 200 && r2.data.trips.length === 2, r2.data.trips.map(t => t.date));
  const r3 = await api('GET', '/api/trips?from=' + lastYear + '&to=' + tmrw, null, A);
  ok('history range all 3', r3.status === 200 && r3.data.trips.length === 3, r3.data.trips.map(t => t.date));

  console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
