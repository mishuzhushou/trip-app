// 约车提醒引擎：morning（晨间总览）/ deadline（截止提醒）
// 规则（沿用小程序修复版）：
//  - 只统计 needCar 且未 carBooked 且状态 active 的行程
//  - 按秘书定向推送（只算其分管高管的行程），全部约好则不发
//  - 推送文案脱敏：只报条数，不写车次/站点
//  - 去重：remindLogs 以 "day|mode|userId" 固定 id 占坑，重复触发直接跳过
//  - 双通道：应用消息（定向）+ 群机器人 webhook（团队兜底，可选）
const DB = require('./db');
const wecom = require('./wecom');

function beijingNow() {
  return new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
}
function todayStr() {
  const n = beijingNow();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function unbookedFor(db, userId, day) {
  const u = db.users.find(x => x.id === userId);
  if (!u || u.status !== 'active' || !u.wecomUserid) return null;
  const execIds = new Set(u.execIds || []);
  if (u.role === 'admin') db.execs.forEach(e => execIds.add(e.id));
  const trips = db.trips.filter(t =>
    t.date === day && t.needCar && !t.carBooked && t.status === 'active' && execIds.has(t.execId)
  );
  return { user: u, trips };
}

// mode: 'morning' | 'deadline'；force=true 忽略当日去重（管理员手动测试用）
async function run(mode, force = false) {
  const db = DB.load();
  const day = todayStr();
  const logId = `${day}|${mode}`;
  const log = (msg) => `[remind ${day} ${mode}] ${msg}`;

  if (!wecom.hasCred()) return { ok: false, error: '未配置企微凭证(WECOM_CORPID/SECRET/AGENTID)' };
  if (!force && db.remindLogs.some(l => l.id === logId)) {
    return { ok: true, skipped: true, reason: '当天该时段已推送过（去重生效）' };
  }

  const targets = [];
  for (const u of db.users) {
    if (u.status !== 'active' || !u.wecomUserid) continue;
    const r = unbookedFor(db, u.id, day);
    if (r && r.trips.length > 0) targets.push(r);
  }

  const detail = [];
  let sent = 0, failed = 0;
  for (const t of targets) {
    const title = mode === 'morning' ? `今日约车提醒 · 待约 ${t.trips.length} 条` : `约车截止提醒 · 待约 ${t.trips.length} 条`;
    const desc = mode === 'morning'
      ? `您好 ${t.user.name || ''}，您分管的高管今日共有 ${t.trips.length} 条行程需安排用车，请打开应用查看详情并完成约车。`
      : `您好 ${t.user.name || ''}，今日尚有 ${t.trips.length} 条行程未完成约车，请在 ${db.settings.deadlineTime || '17:00'} 前完成并在应用中勾选「已约车」。`;
    try {
      const r = await wecom.sendTextCard(t.user.wecomUserid, title, desc, process.env.APP_HOME_URL || '');
      if (r.errcode === 0) sent++; else { failed++; detail.push(`${t.user.username}: [${r.errcode}] ${r.errmsg}`); }
    } catch (e) {
      failed++; detail.push(`${t.user.username}: ${e.message}`);
    }
  }

  // 群机器人兜底（汇总，脱敏：只报人数与条数）
  let hook = { ok: false, skipped: true };
  if (db.settings.weworkHook) {
    const execName = id => (db.execs.find(e => e.id === id) || {}).name || '';
    const lines = targets.map(t => `· ${(t.user.name || t.user.username)}：待约 ${t.trips.length} 条（${t.trips.map(x => execName(x.execId)).filter(Boolean).join('、')}）`);
    if (lines.length) {
      hook = await wecom.sendHookWebhook(db.settings.weworkHook,
        `【${mode === 'morning' ? '晨间' : '截止'}约车提醒 ${day}】共 ${targets.length} 位秘书待办：\n${lines.join('\n')}`);
    } else {
      hook = { ok: true, skipped: true };
    }
  }

  // 原子占坑去重：同 id 重复触发时保留首条
  if (!force) {
    const rec = { id: logId, day, mode, users: targets.length, sent, failed, at: Date.now() };
    const idx = db.remindLogs.findIndex(l => l.id === logId);
    if (idx >= 0) db.remindLogs[idx] = rec; else db.remindLogs.push(rec);
    if (db.remindLogs.length > 200) db.remindLogs = db.remindLogs.slice(-200);
    DB.save();
  }

  console.log(log(`targets=${targets.length} sent=${sent} failed=${failed} hook=${hook.ok}`));
  if (detail.length) console.log(log(detail.join(' | ')));
  return { ok: true, day, mode, targets: targets.length, sent, failed, hook, detail };
}

module.exports = { run, todayStr };
