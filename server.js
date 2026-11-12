// 行程助手服务端：H5 页面 + REST API + 定时提醒入口
// 环境变量：WECOM_CORPID / WECOM_SECRET / WECOM_AGENTID / CRON_KEY / PORT
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const DB = require('./src/db');
const wecom = require('./src/wecom');
const ocr = require('./src/ocr');
const { parseText } = require('./src/parser');
const remind = require('./src/remind');

const app = express();
app.use(express.json({ limit: '12mb' }));  // 图片 base64 上传需要较大上限
app.use(express.static(path.join(__dirname, 'public')));

const db = DB.load();

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

// ---------- 解析（粘贴订单文本 → 结构化行程） ----------
app.post('/api/parse', requireAuth, (req, res) => {
  const list = parseText((req.body || {}).text || '');
  res.json({ ok: true, trips: list });
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
    const trips = parseText(r.text);
    res.json({ ok: true, text: r.text, lines: r.count, trips });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 行程 ----------
// 查询：?date=YYYY-MM-DD 或 ?days=7；秘书只看到分管高管
app.get('/api/trips', requireAuth, (req, res) => {
  const ids = new Set(visibleExecIds(req.user));
  const day = req.query.date;
  const days = Number(req.query.days || 0);
  const now = Date.now();
  let list = db.trips.filter(t => ids.has(t.execId) && t.status !== 'cancelled');
  if (day) list = list.filter(t => t.date === day);
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
  if (!b.depCity) errors.push('缺少出发地');
  if (!b.arrCity) errors.push('缺少到达地');
  if (!/^\d{1,2}:\d{2}$/.test(b.depTime || '')) errors.push('出发时间格式 HH:MM');
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
    needCar: b.needCar === 0 ? 0 : 1, carBooked: 0, status: 'active',
    remark: b.remark || '', rawText: b.rawText || '',
    createdBy: req.user.id, createdAt: Date.now(), updatedAt: Date.now()
  };
  db.trips.push(t);
  DB.save();
  res.json({ ok: true, trip: t });
});

app.post('/api/trips/:id', requireAuth, (req, res) => {
  const t = db.trips.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '行程不存在' });
  if (!visibleExecIds(req.user).includes(t.execId)) return res.status(403).json({ error: '无权操作该行程' });
  const b = req.body || {};
  if ('carBooked' in b) t.carBooked = b.carBooked ? 1 : 0;
  if ('status' in b && ['active', 'changed', 'cancelled'].includes(b.status)) t.status = b.status;
  if ('remark' in b) t.remark = b.remark;
  for (const k of ['date', 'depCity', 'depTime', 'arrCity', 'arrTime', 'seat', 'no', 'vehicle', 'needCar']) {
    if (k in b && b[k] !== undefined && b[k] !== '') t[k] = b[k];
  }
  t.updatedAt = Date.now();
  DB.save();
  res.json({ ok: true, trip: t });
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
  if ('status' in b && ['active', 'disabled'].includes(b.status)) u.status = b.status;
  if ('password' in b && b.password) {
    u.salt = crypto.randomBytes(8).toString('hex');
    u.passHash = hashPass(b.password, u.salt);
  }
  if ('execIds' in b && Array.isArray(b.execIds)) u.execIds = b.execIds.filter(id => db.execs.find(e => e.id === id));
  DB.save();
  res.json({ ok: true, user: publicUser(u) });
});

app.post('/api/admin/execs', requireAuth, requireAdmin, (req, res) => {
  const { name, title } = req.body || {};
  if (!name) return res.status(400).json({ error: '高管姓名必填' });
  if (db.execs.find(e => e.name === name)) return res.status(400).json({ error: '高管已存在' });
  const e = { id: DB.nextId('e'), name, title: title || '', active: true, createdAt: Date.now() };
  db.execs.push(e);
  DB.save();
  res.json({ ok: true, exec: e });
});

app.post('/api/admin/execs/:id', requireAuth, requireAdmin, (req, res) => {
  const e = db.execs.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: '高管不存在' });
  const b = req.body || {};
  if ('title' in b) e.title = b.title;
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

// ---------- 定时提醒入口（cron-job.org 每天定时调用） ----------
app.get('/api/cron/remind', async (req, res) => {
  const key = String(req.query.key || '');
  const mode = String(req.query.mode || '');
  const force = req.query.force === '1';
  const expect = db.settings.cronKey || process.env.CRON_KEY || '';
  if (!expect || key !== expect) return res.status(403).json({ error: '无效的定时密钥' });
  if (!['morning', 'deadline'].includes(mode)) return res.status(400).json({ error: 'mode 应为 morning 或 deadline' });
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
