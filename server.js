// 行程助手服务端：H5 页面 + REST API + 定时提醒入口
// 环境变量：WECOM_CORPID / WECOM_SECRET / WECOM_AGENTID / CRON_KEY / PORT
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const DB = require('./src/db');
const wecom = require('./src/wecom');
const ocr = require('./src/ocr');
const parser = require('./src/parser');
const remind = require('./src/remind');

const app = express();
app.use(express.json({ limit: '12mb' }));  // 图片 base64 上传需要较大上限
app.use(express.static(path.join(__dirname, 'public')));

const db = DB.load();
if (!db.applies) db.applies = [];   // 成员申请负责高管的审批记录

// ---------- 首次启动预置推送配置（可用 Railway 环境变量覆盖） ----------
// 说明：仓库为私有仓库；如需更换机器人，在企业微信群重建机器人后改此处或配置环境变量
const BOOT_HOOK_KEY = process.env.WEWORK_HOOK_KEY || 'e64d26e7-e830-4c7f-bf90-ad1b13a854a4';
const BOOT_CRON_KEY = process.env.CRON_KEY || 'tk_7c41e9b2d6f8a03e5b1d';
if (!db.settings.weworkHook && BOOT_HOOK_KEY) { db.settings.weworkHook = BOOT_HOOK_KEY; DB.save(); }
if (!db.settings.cronKey && BOOT_CRON_KEY) { db.settings.cronKey = BOOT_CRON_KEY; DB.save(); }

// ---------- 工具 ----------
function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32).toString('hex');
}
function todayStr() { return remind.todayStr(); }
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = db.sessions[token];
  if (!s) return res.status(401).json({ error: '未登录或登录已过期' });
  const u = db.users.find(x => x.id === s.userId);
  if (!u || u.status !== 'active') return res.status(401).json({ error: '账号不可用' });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}
function visibleExecIds(u) {
  if (u.role === 'admin') return db.execs.filter(e => e.active).map(e => e.id);
  return (u.execIds || []).filter(id => db.execs.find(e => e.id === id && e.active));
}
function publicUser(u) {
  const { passHash, salt, ...rest } = u;
  return rest;
}

// ---------- 首次初始化：系统无任何账号时，第一个注册者自动成为管理员（之后关闭该入口） ----------
app.post('/api/register', (req, res) => {
  if (db.users.length > 0) return res.status(403).json({ error: '系统已初始化，请联系管理员开通账号' });
  const { username, password, name } = req.body || {};
  if (!username || !password || String(password).length < 6) {
    return res.status(400).json({ error: '用户名与密码必填，密码至少 6 位' });
  }
  const salt = crypto.randomBytes(8).toString('hex');
  const u = {
    id: DB.nextId('u'), username: String(username).trim(), salt, passHash: hashPass(password, salt),
    name: name || '', role: 'admin', wecomUserid: '', status: 'active', execIds: [], createdAt: Date.now()
  };
  db.users.push(u);
  DB.save();
  console.log(`[init] 管理员已创建: ${u.username}`);
  res.json({ ok: true, user: publicUser(u) });
});

// ---------- 登录 / 会话 ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.users.find(x => x.username === String(username || '').trim());
  if (!u || u.status !== 'active') return res.status(401).json({ error: '账号不存在或已停用' });
  if (hashPass(password, u.salt) !== u.passHash) return res.status(401).json({ error: '密码错误' });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: u.id, createdAt: Date.now() };
  DB.save();
  res.json({ token, user: publicUser(u) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  delete db.sessions[token];
  DB.save();
  res.json({ ok: true });
});

// ---------- 解析（粘贴订单文本 → 结构化行程；自动匹配高管姓名） ----------
app.post('/api/parse', requireAuth, (req, res) => {
  const text = String((req.body || {}).text || '');
  const r = parser.parseText(text, db.execs);
  res.json({ ok: true, segments: r.segments, execName: r.execName, carHint: r.carHint });
});

// ---------- 图片识别（OCR → 文本 → 行程） ----------
// 入参：{ image: 'data:image/jpeg;base64,...' 或纯 base64 }，限制 6MB
app.post('/api/ocr', requireAuth, async (req, res) => {
  try {
    let b64 = String((req.body || {}).image || '');
    if (!b64) return res.status(400).json({ error: '缺少图片数据' });
    b64 = b64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
    if (b64.length > 8 * 1024 * 1024) return res.status(413).json({ error: '图片过大，请压缩后重试（建议 3MB 内）' });
    if (!ocr.hasCred()) {
      return res.status(503).json({
        error: 'OCR 未配置：请在部署环境变量中添加 TENCENT_SECRET_ID / TENCENT_SECRET_KEY（腾讯云文字识别免费额度 1000 次/月），或先用「粘贴文本」方式登记'
      });
    }
    const r = await ocr.recognize(b64);
    const p = parser.parseText(r.text, db.execs);
    res.json({ ok: true, text: r.text, lines: r.count, segments: p.segments, execName: p.execName, carHint: p.carHint });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 行程 ----------
// 查询：不带 date/days 时返回全部（含改签/取消，由前端按需过滤）；秘书只看到分管高管
// 支持范围查询：?from=YYYY-MM-DD&to=YYYY-MM-DD（历史行程页用）
app.get('/api/trips', requireAuth, (req, res) => {
  const ids = new Set(visibleExecIds(req.user));
  const day = req.query.date;
  const days = Number(req.query.days || 0);
  const now = Date.now();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
  let list = db.trips.filter(t => ids.has(t.execId));
  if (day) list = list.filter(t => t.date === day);
  if (from) list = list.filter(t => t.date >= from);
  if (to) list = list.filter(t => t.date <= to);
  if (days > 0) {
    const min = now - days * 86400000;
    list = list.filter(t => new Date(t.date + 'T23:59:59+08:00').getTime() >= min && new Date(t.date + 'T00:00:00+08:00').getTime() <= now + days * 86400000);
  }
  list = list.slice().sort((a, b) => (a.date + a.depTime).localeCompare(b.date + b.depTime));
  res.json({ ok: true, trips: list, execs: db.execs.filter(e => ids.has(e.id)) });
});

function validTrip(b) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) errors.push('日期格式应为 YYYY-MM-DD');
  if (!b.depCity && !(b.segments && b.segments.length)) errors.push('缺少出发地');
  if (!b.arrCity && !(b.segments && b.segments.length)) errors.push('缺少到达地');
  if (!/^\d{1,2}:\d{2}$/.test(b.depTime || '') && !(b.segments && b.segments.length)) errors.push('出发时间格式 HH:MM');
  return errors;
}

app.post('/api/trips', requireAuth, (req, res) => {
  const b = req.body || {};
  const errs = validTrip(b);
  if (errs.length) return res.status(400).json({ error: errs.join('；') });
  if (!visibleExecIds(req.user).includes(b.execId)) return res.status(403).json({ error: '无权为该高管登记行程' });
  const t = {
    id: DB.nextId('t'), execId: b.execId, date: b.date,
    vehicle: b.vehicle || 'other', no: b.no || '', seat: b.seat || '',
    depCity: b.depCity, depTime: b.depTime, arrCity: b.arrCity, arrTime: b.arrTime || '',
    needCar: (b.needCar === 0 || b.needCar === false || b.needCar === '0') ? 0 : 1, carBooked: 0, status: 'active',
    carType: b.carType || '', pickupTime: b.pickupTime || '',
    pickupAddr: b.pickupAddr || '', dropoffAddr: b.dropoffAddr || '',
    carInfo: b.carInfo || '',
    segments: Array.isArray(b.segments) && b.segments.length ? b.segments : [],
    remark: b.remark || '', rawText: b.rawText || '',
    createdBy: req.user.id, createdAt: Date.now(), updatedAt: Date.now()
  };
  db.trips.push(t);
  DB.save();
  res.json({ ok: true, trip: t });
});

// 行程上允许更新的字段（含小程序迁移来的扩展字段）
const TRIP_FIELDS = ['date', 'depCity', 'depTime', 'arrCity', 'arrTime', 'seat', 'no', 'vehicle', 'needCar',
  'carType', 'pickupTime', 'pickupAddr', 'dropoffAddr', 'carInfo'];

app.post('/api/trips/:id', requireAuth, (req, res) => {
  const t = db.trips.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '行程不存在' });
  if (!visibleExecIds(req.user).includes(t.execId)) return res.status(403).json({ error: '无权操作该行程' });
  const b = req.body || {};
  if ('carBooked' in b) t.carBooked = b.carBooked ? 1 : 0;
  if ('status' in b && ['active', 'changed', 'cancelled'].includes(b.status)) t.status = b.status;
  if ('remark' in b) t.remark = b.remark;
  if ('segments' in b && Array.isArray(b.segments)) {
    t.segments = b.segments;
    // 同步首段到平铺字段（看板/提醒兼容单段读取）
    const f0 = b.segments[0] || {};
    if (f0.flightNo || f0.trainNo) { t.no = f0.flightNo || f0.trainNo; t.vehicle = f0.flightNo ? 'flight' : 'train'; }
    if (f0.depCity !== undefined) t.depCity = f0.depCity;
    if (f0.depTime !== undefined) t.depTime = f0.depTime;
    if (f0.arrCity !== undefined) t.arrCity = f0.arrCity;
    if (f0.arrTime !== undefined) t.arrTime = f0.arrTime;
    if (f0.seat !== undefined) t.seat = f0.seat;
    if (f0.date && /^\d{4}-\d{2}-\d{2}$/.test(f0.date)) t.date = f0.date;
  }
  if ('execId' in b && visibleExecIds(req.user).includes(b.execId)) t.execId = b.execId;
  for (const k of TRIP_FIELDS) {
    if (k in b && b[k] !== undefined) t[k] = b[k];   // 允许清空（详情编辑需要）
  }
  t.updatedAt = Date.now();
  DB.save();
  res.json({ ok: true, trip: t });
});

// ---------- 数据迁移：导入小程序云开发导出的 executives / trips JSON ----------
// 鉴权双通道：管理员会话 或 定时密钥（?key=，一次性迁移用）
app.post('/api/admin/import', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = db.sessions[token];
  const u = s && db.users.find(x => x.id === s.userId && x.status === 'active');
  const isAdmin = !!(u && u.role === 'admin');
  const keyOk = !!(req.query.key && req.query.key === (db.settings.cronKey || process.env.CRON_KEY || ''));
  if (!isAdmin && !keyOk) return res.status(403).json({ error: '无权导入' });
  const creator = isAdmin ? u.id : 'import';
  const b = req.body || {};
  const execsIn = Array.isArray(b.execs) ? b.execs : [];
  const tripsIn = Array.isArray(b.trips) ? b.trips : [];
  if (!execsIn.length && !tripsIn.length) return res.status(400).json({ error: '没有可导入的数据（execs/trips 均为空）' });

  // 1) 高管：按姓名去重复用，记录 云 _id -> 本地 exec.id 映射
  const execMap = {};   // 云 _id -> web exec id
  const byName = {};    // name -> web exec
  for (const e of db.execs) byName[e.name] = e;
  let execAdded = 0;
  for (const e of execsIn) {
    const name = String(e.name || '').trim();
    if (!name) continue;
    let w = byName[name];
    if (!w) {
      w = { id: DB.nextId('e'), name, title: e.title || '', phone: String(e.phone || '').trim(), active: true, createdAt: Date.now() };
      db.execs.push(w); byName[name] = w; execAdded++;
    }
    if (e._id) execMap[e._id] = w.id;
  }

  // 2) 行程：execId 映射（优先按云 execId，兜底按 execName）；tripStatus -> status
  const existingKeys = new Set(db.trips.map(t => t.execId + '|' + t.date + '|' + (t.no || '') + '|' + (t.depTime || '') + '|' + (t.segments ? t.segments.length : 0)));
  let tripAdded = 0, tripSkipped = 0;
  for (const t of tripsIn) {
    let execId = execMap[t.execId];
    if (!execId) {
      const name = String(t.execName || '').trim();
      const w = name && byName[name];
      if (!w) { tripSkipped++; continue; }
      execId = w.id;
    }
    const segs = Array.isArray(t.segments) ? t.segments.filter(s => s && (s.depCity || s.arrCity || s.flightNo || s.trainNo)) : [];
    const first = segs[0] || {};
    const no = t.no || first.flightNo || first.trainNo || '';
    const status = t.tripStatus === 'changed' ? 'changed' : (t.tripStatus === 'cancelled' ? 'cancelled' : 'active');
    const key = execId + '|' + (t.date || '') + '|' + no + '|' + (first.depTime || t.pickupTime || '') + '|' + segs.length;
    if (existingKeys.has(key)) { tripSkipped++; continue; }   // 幂等：重复导入跳过
    existingKeys.add(key);
    db.trips.push({
      id: DB.nextId('t'), execId, date: t.date || '',
      vehicle: t.vehicle || (first.flightNo ? 'flight' : (first.trainNo || no ? 'train' : 'other')),
      no, seat: t.seat || first.seat || '',
      depCity: t.depCity || first.depCity || '', depTime: t.depTime || first.depTime || '',
      arrCity: t.arrCity || first.arrCity || '', arrTime: t.arrTime || first.arrTime || '',
      needCar: t.needCar ? 1 : 0, carBooked: t.carBooked ? 1 : 0, status,
      carType: t.carType || '', pickupTime: t.pickupTime || '',
      pickupAddr: t.pickupAddr || '', dropoffAddr: t.dropoffAddr || '',
      carInfo: t.carInfo || '',
      segments: segs.map(s => ({
        flightNo: s.flightNo || '', trainNo: s.trainNo || '',
        depCity: s.depCity || '', depStation: s.depStation || '', depTime: s.depTime || '',
        arrCity: s.arrCity || '', arrStation: s.arrStation || '', arrTime: s.arrTime || '',
        seat: s.seat || ''
      })),
      remark: '', rawText: '',
      createdBy: creator, createdAt: Date.now(), updatedAt: Date.now()
    });
    tripAdded++;
  }
  DB.save();
  res.json({ ok: true, execAdded, tripAdded, tripSkipped, execTotal: db.execs.length, tripTotal: db.trips.length });
});

// ---------- 管理员删除行程 ----------
app.post('/api/admin/trips/:id/delete', requireAuth, (req, res) => {
  const t = db.trips.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '行程不存在' });
  if (req.user.role !== 'admin' && t.createdBy !== req.user.id) return res.status(403).json({ error: '无权删除该行程' });
  db.trips = db.trips.filter(x => x.id !== t.id);
  DB.save();
  res.json({ ok: true });
});


// ---------- 管理（仅管理员） ----------
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, users: db.users.map(publicUser), execs: db.execs });
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, name, role, wecomUserid } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (db.users.find(x => x.username === username)) return res.status(400).json({ error: '用户名已存在' });
  if (!['admin', 'sec'].includes(role)) return res.status(400).json({ error: '角色应为 admin 或 sec' });
  const salt = crypto.randomBytes(8).toString('hex');
  const u = {
    id: DB.nextId('u'), username, salt, passHash: hashPass(password, salt),
    name: name || '', role, wecomUserid: wecomUserid || '', status: 'active',
    execIds: [], createdAt: Date.now()
  };
  db.users.push(u);
  DB.save();
  res.json({ ok: true, user: publicUser(u) });
});

app.post('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const b = req.body || {};
  if ('role' in b && ['admin', 'sec'].includes(b.role)) u.role = b.role;
  if ('name' in b) u.name = b.name;
  if ('wecomUserid' in b) u.wecomUserid = String(b.wecomUserid).trim();
  if ('status' in b && ['active', 'disabled', 'blocked'].includes(b.status)) u.status = b.status;
  if ('password' in b && b.password) {
    u.salt = crypto.randomBytes(8).toString('hex');
    u.passHash = hashPass(b.password, u.salt);
  }
  if ('execIds' in b && Array.isArray(b.execIds)) u.execIds = b.execIds.filter(id => db.execs.find(e => e.id === id));
  DB.save();
  res.json({ ok: true, user: publicUser(u) });
});

app.post('/api/admin/execs', requireAuth, requireAdmin, (req, res) => {
  const { name, title, phone } = req.body || {};
  if (!name) return res.status(400).json({ error: '高管姓名必填' });
  if (db.execs.find(e => e.name === name)) return res.status(400).json({ error: '高管已存在' });
  const e = { id: DB.nextId('e'), name, title: title || '', phone: String(phone || '').trim(), active: true, createdAt: Date.now() };
  db.execs.push(e);
  DB.save();
  res.json({ ok: true, exec: e });
});

// 管理员：高管批量添加（带重复检测与替换）
// 入参：{ items: [{name,title,phone}], replaceNames?: [已存在且要替换信息的姓名] }
// 不传 replaceNames 时为「检查模式」：重复的不会新增，返回 duplicates 让前端确认；
// 传 replaceNames 时：非重复的正常新增，重复且在 replaceNames 中的用新信息覆盖 title/phone。
// 注意：必须注册在 /api/admin/execs/:id 之前，否则 batch 会被 :id 捕获
app.post('/api/admin/execs/batch', requireAuth, requireAdmin, (req, res) => {
  const raw = Array.isArray((req.body || {}).items) ? req.body.items : [];
  const replaceNames = new Set(Array.isArray((req.body || {}).replaceNames) ? req.body.replaceNames : []);
  if (!raw.length) return res.status(400).json({ error: '没有可导入的数据' });
  const norm = s => String(s || '').trim();
  const items = raw.map(x => ({ name: norm(x.name), title: norm(x.title), phone: norm(x.phone) })).filter(x => x.name);
  if (!items.length) return res.status(400).json({ error: '没有解析到有效姓名' });

  const added = [], replaced = [], skipped = [], duplicates = [];
  for (const it of items) {
    const exist = db.execs.find(e => e.name === it.name);
    if (!exist) {
      const e = { id: DB.nextId('e'), name: it.name, title: it.title, phone: it.phone, active: true, createdAt: Date.now() };
      db.execs.push(e);
      added.push(it.name);
    } else if (replaceNames.has(it.name)) {
      exist.title = it.title || exist.title;
      exist.phone = it.phone || exist.phone;
      replaced.push(it.name);
    } else {
      skipped.push(it.name);
      if (!replaceNames.size) duplicates.push({ name: it.name, title: it.title, phone: it.phone, existing: { id: exist.id, name: exist.name, title: exist.title || '', phone: exist.phone || '' } });
    }
  }
  DB.save();
  res.json({
    ok: true, added, replaced, skipped,
    needConfirm: !replaceNames.size && duplicates.length > 0,
    duplicates
  });
});

app.post('/api/admin/execs/:id', requireAuth, requireAdmin, (req, res) => {
  const e = db.execs.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: '高管不存在' });
  const b = req.body || {};
  if ('name' in b && String(b.name).trim()) e.name = String(b.name).trim();
  if ('title' in b) e.title = b.title;
  if ('phone' in b) e.phone = String(b.phone || '').trim();
  if ('active' in b) e.active = !!b.active;
  DB.save();
  res.json({ ok: true, exec: e });
});

app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const s = { ...db.settings, weworkHook: db.settings.weworkHook ? '已配置（隐藏）' : '' };
  res.json({ ok: true, settings: s, wecomReady: wecom.hasCred() });
});

app.post('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if ('weworkHook' in b && b.weworkHook && !b.weworkHook.startsWith('已配置')) {
    db.settings.weworkHook = String(b.weworkHook).trim();  // 接受完整 webhook 或纯 key
    if (db.settings.weworkHook.includes('key=')) db.settings.weworkHook = db.settings.weworkHook.split('key=')[1].split('&')[0];
  }
  if ('deadlineTime' in b && /^\d{1,2}:\d{2}$/.test(b.deadlineTime)) db.settings.deadlineTime = b.deadlineTime;
  if ('cronKey' in b && b.cronKey) db.settings.cronKey = String(b.cronKey).trim();
  DB.save();
  res.json({ ok: true });
});

app.post('/api/admin/sync-wecom-users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await wecom.listVisibleUsers();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 成员自助：查看全部高管 + 申请负责 ----------
// 全部在职高管列表，标注 mine（我已负责）与我的待审批申请
app.get('/api/execs', requireAuth, (req, res) => {
  const mine = new Set(req.user.execIds || []);
  res.json({
    ok: true,
    execs: db.execs.filter(e => e.active).map(e => ({ id: e.id, name: e.name, title: e.title || '', phone: e.phone || '', mine: mine.has(e.id) })),
    myApplies: db.applies.filter(a => a.userId === req.user.id && a.status === 'pending')
  });
});

// 成员申请负责某高管（去重：已负责 / 已有待审批的相同申请）
app.post('/api/apply-exec', requireAuth, (req, res) => {
  const exec = db.execs.find(e => e.id === String((req.body || {}).execId || '') && e.active);
  if (!exec) return res.status(404).json({ error: '高管不存在或已停用' });
  if ((req.user.execIds || []).includes(exec.id)) return res.status(400).json({ error: '你已负责该高管' });
  if (db.applies.find(a => a.userId === req.user.id && a.execId === exec.id && a.status === 'pending')) {
    return res.status(400).json({ error: '已提交过申请，等待管理员审批' });
  }
  const a = {
    id: DB.nextId('a'), userId: req.user.id, username: req.user.username,
    name: req.user.name || req.user.username, execId: exec.id, execName: exec.name,
    status: 'pending', createdAt: Date.now()
  };
  db.applies.push(a);
  DB.save();
  // 通知管理员（群机器人，尽力而为）
  wecom.sendHookWebhook(db.settings.weworkHook, `[行程助手] ${a.name} 申请负责高管「${exec.name}」，请到网页管理页审批。`)
    .catch(() => {});
  res.json({ ok: true, apply: a });
});

// 管理员：待审批申请列表
app.get('/api/admin/applies', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, applies: db.applies.filter(a => a.status === 'pending').slice().reverse() });
});

// 管理员：审批（approve / reject）
app.post('/api/admin/applies/:id', requireAuth, requireAdmin, (req, res) => {
  const a = db.applies.find(x => x.id === req.params.id && x.status === 'pending');
  if (!a) return res.status(404).json({ error: '申请不存在或已处理' });
  const action = String((req.body || {}).action || '');
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action 应为 approve / reject' });
  a.status = action === 'approve' ? 'approved' : 'rejected';
  a.handledAt = Date.now();
  if (action === 'approve') {
    const u = db.users.find(x => x.id === a.userId);
    if (u) {
      u.execIds = u.execIds || [];
      if (!u.execIds.includes(a.execId)) u.execIds.push(a.execId);
    }
    // 通知申请人（群机器人，尽力而为）
    wecom.sendHookWebhook(db.settings.weworkHook, `[行程助手] 管理员已同意：${a.name} 负责「${a.execName}」。`)
      .catch(() => {});
  }
  DB.save();
  res.json({ ok: true, apply: a });
});

// ---------- 管理员：移除账号 ----------
// 移除 = 删除账号与其全部会话（其登记的行程保留）。不能移除自己；不能移除最后一名管理员。
app.post('/api/admin/users/:id/delete', requireAuth, requireAdmin, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.id === req.user.id) return res.status(400).json({ error: '不能移除当前登录的账号自己' });
  if (u.role === 'admin' && db.users.filter(x => x.role === 'admin' && x.status === 'active').length <= 1) {
    return res.status(400).json({ error: '不能移除最后一名管理员' });
  }
  db.users = db.users.filter(x => x.id !== u.id);
  for (const tk of Object.keys(db.sessions)) { if (db.sessions[tk].userId === u.id) delete db.sessions[tk]; }
  DB.save();
  res.json({ ok: true });
});


// ---------- 定时提醒入口（cron-job.org 每天定时调用） ----------
app.get('/api/cron/remind', async (req, res) => {
  const key = String(req.query.key || '');
  const mode = String(req.query.mode || '');
  const force = req.query.force === '1';
  const expect = db.settings.cronKey || process.env.CRON_KEY || '';
  if (!expect || key !== expect) return res.status(403).json({ error: '无效的定时密钥' });
  if (!['morning', 'deadline', 'hourly'].includes(mode)) return res.status(400).json({ error: 'mode 应为 morning / deadline / hourly' });
  try {
    const r = await remind.run(mode, force);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true, now: todayStr(),
    initialized: db.users.length > 0,
    hook: db.settings.weworkHook ? 'ready' : 'not-configured',
    wecom: wecom.hasCred() ? 'ready' : 'not-configured',
    ocr: ocr.hasCred() ? 'ready' : 'not-configured'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[trip-helper] listening on :${PORT}, today=${todayStr()}, wecom=${wecom.hasCred() ? 'ready' : 'NOT-CONFIGURED'}`));
