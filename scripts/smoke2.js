// 自包含冒烟测试：自动初始化 → 登录 → 建行程 → 触发提醒（webhook 主通道）
// 用法: BASE=http://127.0.0.1:3210 node scripts/smoke2.js
const crypto = require('crypto');

const BASE = process.env.BASE || 'http://127.0.0.1:3210';
const USER = 'smoke_admin';
const PASS = 'smoke_' + crypto.randomBytes(4).toString('hex');

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> [${r.status}] ${j.error || JSON.stringify(j)}`);
  return j;
}

(async () => {
  // 1. 初始化账号：空库时注册（自动成为管理员），否则登录
  let token;
  try {
    const r = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: USER, password: PASS, name: '冒烟管理员' }) });
    console.log('✓ 注册管理员（首账号自动成为管理员）');
    const l = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: USER, password: PASS }) });
    token = l.token;
  } catch (e) {
    if (!/已初始化/.test(e.message)) throw e;
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: USER, password: PASS }) });
    token = r.token;
    console.log('✓ 登录已有管理员');
  }
  const H = { Authorization: 'Bearer ' + token };

  // 2. 高管（按名字去重）
  let { execs } = await api('/api/admin/users', { headers: H });
  const names = ['冒烟张总', '冒烟李总'];
  for (const n of names) {
    if (!execs.find(e => e.name === n)) {
      await api('/api/admin/execs', { method: 'POST', headers: H, body: JSON.stringify({ name: n }) });
    }
  }
  ({ execs } = await api('/api/admin/users', { headers: H }));
  console.log(`✓ 高管就绪（共 ${execs.length} 位）`);

  // 3. 建一条今天需约车的行程
  const day = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
  const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const r = await api('/api/trips', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      execId: execs[0].id, date: today, vehicle: 'train', no: 'G0000',
      depCity: '冒烟东', depTime: '07:25', arrCity: '冒烟西', arrTime: '09:07',
      needCar: 1, remark: 'smoke2 测试数据'
    })
  });
  console.log(`✓ 建行程成功（id=${r.trip.id}，${r.trip.depCity}→${r.trip.arrCity}，需约车）`);

  // 4. 配置假 webhook key，触发提醒（验证链路走通；真机推送由真实 webhook 完成）
  await api('/api/admin/settings', { method: 'POST', headers: H, body: JSON.stringify({ weworkHook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=smoke-fake-key' }) });
  const ck = 'smokecron';
  await api('/api/admin/settings', { method: 'POST', headers: H, body: JSON.stringify({ cronKey: ck }) });
  const rr = await api(`/api/cron/remind?mode=morning&key=${ck}&force=1`);
  console.log(`✓ 提醒触发成功： trips=${rr.trips} hook.ok=${rr.hook && rr.hook.ok}（假 key 预期 errcode=${rr.hook && rr.hook.errcode}）`);
  if (rr.detail && rr.detail.length) console.log('  明细:', rr.detail.join(' | '));

  // 5. 去重验证：不 force 再触发应 skipped
  const r3 = await api(`/api/cron/remind?mode=morning&key=${ck}`);
  console.log(`✓ 去重生效: skipped=${r3.skipped}`);

  console.log('\nSMOKE2 PASS ✅');
})().catch(e => { console.error('SMOKE2 FAIL:', e.message); process.exit(1); });
