// 约车提醒引擎
// 模式：
//  - morning  8:00 晨间提醒（当天+明天未约车汇总）
//  - deadline 17:00 截止提醒（当天+明天未约车汇总）
//  - hourly   17:00 后每小时催办（当天+明天仍未约车；约好即静默；行程过期自然消失）
// 规则：
//  - 只统计 needCar 且未 carBooked 且状态 active 的行程（日期=当天或明天）
//  - 主通道：企微群机器人 webhook（无需可信IP）；副通道：应用内定向消息（需凭证，可选）
//  - 文案脱敏：只报高管与条数，不写证件等敏感信息
//  - 去重：morning/deadline 以 "day|mode" 占坑；hourly 以 "day|hourly|HH" 占坑（每小时独立）
const DB = require('./db');
const wecom = require('./wecom');

function beijingNow() {
  return new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
}
function todayStr() {
  const n = beijingNow();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function tomorrowStr() {
  const n = beijingNow();
  n.setDate(n.getDate() + 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

// 当天+明天：需约车且未约车且状态正常的行程
function unbookedTrips(db) {
  const days = new Set([todayStr(), tomorrowStr()]);
  const activeExec = e => e && e.active !== false;
  return db.trips.filter(t =>
    days.has(t.date) && t.needCar && !t.carBooked && t.status === 'active' &&
    activeExec(db.execs.find(e => e.id === t.execId))
  );
}

// mode: 'morning' | 'deadline' | 'hourly'；force=true 忽略去重（手动测试用）
async function run(mode, force = false) {
  const db = DB.load();
  const day = todayStr();
  const tomorrow = tomorrowStr();
  const hour = String(beijingNow().getHours()).padStart(2, '0');
  const logId = mode === 'hourly' ? `${day}|hourly|${hour}` : `${day}|${mode}`;
  const log = (msg) => `[remind ${day} ${mode}] ${msg}`;

  const hookKey = db.settings.weworkHook || '';
  const hasApi = wecom.hasCred();
  if (!hookKey && !hasApi) {
    return { ok: false, error: '未配置推送通道：请管理员在「管理-设置」填入企微群机器人 Webhook 地址' };
  }
  if (!force && db.remindLogs.some(l => l.id === logId)) {
    return { ok: true, skipped: true, reason: '该时段已推送过（去重生效）' };
  }

  const trips = unbookedTrips(db);

  const detail = [];
  let sent = 0, failed = 0;

  // ---- 主通道：群机器人 webhook（按高管汇总，标注今日/明日条数） ----
  let hook = { ok: false, skipped: true };
  if (hookKey) {
    if (trips.length > 0) {
      const groups = new Map();  // execId -> { name, title, today, tomorrow }
      for (const t of trips) {
        const e = db.execs.find(x => x.id === t.execId) || { name: '未知高管' };
        const g = groups.get(e.id) || { name: e.name, title: e.title || '', today: 0, tomorrow: 0 };
        if (t.date === day) g.today++; else g.tomorrow++;
        groups.set(e.id, g);
      }
      const lines = [...groups.values()].map(g => {
        const parts = [];
        if (g.today) parts.push(`今日${g.today}`);
        if (g.tomorrow) parts.push(`明日${g.tomorrow}`);
        return `· ${g.name}${g.title ? `（${g.title}）` : ''}：${g.today + g.tomorrow} 条待约车${parts.length ? `（${parts.join('、')}）` : ''}`;
      });
      const deadline = db.settings.deadlineTime || '17:00';
      let head, tail;
      if (mode === 'morning') {
        head = `【晨间约车提醒 ${day}】`;
        tail = '\n请打开应用查看详情并安排用车。';
      } else if (mode === 'deadline') {
        head = `【截止提醒 ${day}】`;
        tail = `\n请在 ${deadline} 前完成约车并在应用中标记「已约车」。`;
      } else {
        head = `【催办提醒 ${day} ${hour}:00】`;
        tail = `\n已超过 ${deadline}，请尽快完成约车并标记「已约车」，约好后提醒自动停止。`;
      }
      const text = `${head}今明两天共 ${trips.length} 条行程未约车：\n${lines.join('\n')}${tail}`;
      hook = await wecom.sendHookWebhook(hookKey, text);
      if (!hook.ok) detail.push(`webhook: ${hook.errmsg || hook.error || '发送失败'}`);
    } else {
      hook = { ok: true, skipped: true };
    }
  }

  // ---- 副通道：应用内定向推送（仅当配置了企微应用凭证时尝试，失败不影响主通道） ----
  if (hasApi && trips.length > 0) {
    const deadline = db.settings.deadlineTime || '17:00';
    for (const u of db.users) {
      if (u.status !== 'active' || !u.wecomUserid) continue;
      const execIds = new Set(u.execIds || []);
      if (u.role === 'admin') db.execs.forEach(e => execIds.add(e.id));
      const mine = trips.filter(t => execIds.has(t.execId));
      if (!mine.length) continue;
      const title = mode === 'morning' ? `约车提醒 · 待约 ${mine.length} 条`
        : mode === 'deadline' ? `约车截止提醒 · 待约 ${mine.length} 条`
        : `催办提醒 · 仍未约车 ${mine.length} 条`;
      const desc = mode === 'hourly'
        ? `您好 ${u.name || u.username}，今明两天尚有 ${mine.length} 条行程未完成约车（已超过 ${deadline}），请尽快处理并在应用中勾选「已约车」。`
        : `您好 ${u.name || u.username}，今明两天共有 ${mine.length} 条行程需安排用车${mode === 'deadline' ? `，请在 ${deadline} 前` : ''}完成并在应用中勾选「已约车」。`;
      try {
        const rr = await wecom.sendTextCard(u.wecomUserid, title, desc, process.env.APP_HOME_URL || '');
        if (rr.errcode === 0) sent++; else { failed++; detail.push(`${u.username}: [${rr.errcode}] ${rr.errmsg}`); }
      } catch (e) {
        failed++; detail.push(`${u.username}: ${e.message}`);
      }
    }
  }

  // 占坑去重：hourly 无待办时不占坑（下一小时继续静默判断）
  if (!force && !(mode === 'hourly' && trips.length === 0)) {
    const rec = { id: logId, day, mode, hour, trips: trips.length, sent, failed, hookOk: !!hook.ok, at: Date.now() };
    const idx = db.remindLogs.findIndex(l => l.id === logId);
    if (idx >= 0) db.remindLogs[idx] = rec; else db.remindLogs.push(rec);
    if (db.remindLogs.length > 400) db.remindLogs = db.remindLogs.slice(-400);
    DB.save();
  }

  console.log(log(`trips=${trips.length} sent=${sent} failed=${failed} hook=${hook.ok}`));
  if (detail.length) console.log(log(detail.join(' | ')));
  return { ok: true, day, mode, hour, trips: trips.length, sent, failed, hook, detail };
}

module.exports = { run, todayStr };
