// 约车提醒引擎：morning（晨间总览）/ deadline（截止提醒）
// 规则（沿用小程序修复版）：
//  - 只统计 needCar 且未 carBooked 且状态 active 的行程
//  - 推送主通道：企微群机器人 webhook（无需可信IP，任何部署环境可用）
//  - 可选副通道：应用内定向消息（需配置 WECOM_CORPID/SECRET/AGENTID 且环境有固定出口IP）
//  - 推送文案脱敏：只报条数，不写车次/证件等敏感信息
//  - 去重：remindLogs 以 "day|mode" 固定 id 占坑，重复触发直接跳过
const DB = require('./db');
const wecom = require('./wecom');

function beijingNow() {
  return new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
}
function todayStr() {
  const n = beijingNow();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

// 按秘书维度算其分管高管的待约行程（用于可选的定向推送）
function unbookedFor(db, userId, day) {
  const u = db.users.find(x => x.id === userId);
  if (!u || u.status !== 'active') return null;
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

  const hookKey = db.settings.weworkHook || '';
  const hasApi = wecom.hasCred();
  if (!hookKey && !hasApi) {
    return { ok: false, error: '未配置推送通道：请管理员在「管理-设置」填入企微群机器人 Webhook 地址' };
  }
  if (!force && db.remindLogs.some(l => l.id === logId)) {
    return { ok: true, skipped: true, reason: '当天该时段已推送过（去重生效）' };
  }

  // 当天全部需约车行程（在职高管）
  const activeExec = e => e && e.active !== false;
  const trips = db.trips.filter(t =>
    t.date === day && t.needCar && !t.carBooked && t.status === 'active' &&
    activeExec(db.execs.find(e => e.id === t.execId))
  );

  const detail = [];
  let sent = 0, failed = 0;

  // ---- 主通道：群机器人 webhook（按高管汇总，脱敏只报条数） ----
  let hook = { ok: false, skipped: true };
  if (hookKey) {
    if (trips.length > 0) {
      const groups = new Map();  // execId -> { name, title, count }
      for (const t of trips) {
        const e = db.execs.find(x => x.id === t.execId) || { name: '未知高管' };
        const g = groups.get(e.id) || { name: e.name, title: e.title || '', count: 0 };
        g.count++;
        groups.set(e.id, g);
      }
      const lines = [...groups.values()].map(g => `· ${g.name}${g.title ? `（${g.title}）` : ''}：${g.count} 条待约车`);
      const tail = mode === 'deadline'
        ? `\n请在 ${db.settings.deadlineTime || '17:00'} 前完成约车并在应用中标记「已约车」。`
        : '\n请打开应用查看详情并安排用车。';
      const text = `【${mode === 'morning' ? '晨间' : '截止'}约车提醒 ${day}】今日共 ${trips.length} 条行程待约车：\n${lines.join('\n')}${tail}`;
      hook = await wecom.sendHookWebhook(hookKey, text);
      if (!hook.ok) detail.push(`webhook: ${hook.errmsg || hook.error || '发送失败'}`);
    } else {
      hook = { ok: true, skipped: true };
    }
  }

  // ---- 副通道：应用内定向推送（仅当配置了企微应用凭证时尝试，失败不影响主通道） ----
  if (hasApi) {
    for (const u of db.users) {
      if (u.status !== 'active' || !u.wecomUserid) continue;
      const r = unbookedFor(db, u.id, day);
      if (!r || r.trips.length === 0) continue;
      const title = mode === 'morning' ? `今日约车提醒 · 待约 ${r.trips.length} 条` : `约车截止提醒 · 待约 ${r.trips.length} 条`;
      const desc = mode === 'morning'
        ? `您好 ${u.name || u.username}，您分管的高管今日共有 ${r.trips.length} 条行程需安排用车，请打开应用查看详情并完成约车。`
        : `您好 ${u.name || u.username}，今日尚有 ${r.trips.length} 条行程未完成约车，请在 ${db.settings.deadlineTime || '17:00'} 前完成并在应用中勾选「已约车」。`;
      try {
        const rr = await wecom.sendTextCard(u.wecomUserid, title, desc, process.env.APP_HOME_URL || '');
        if (rr.errcode === 0) sent++; else { failed++; detail.push(`${u.username}: [${rr.errcode}] ${rr.errmsg}`); }
      } catch (e) {
        failed++; detail.push(`${u.username}: ${e.message}`);
      }
    }
  }

  // 原子占坑去重：同 id 重复触发时保留首条
  if (!force) {
    const rec = { id: logId, day, mode, trips: trips.length, sent, failed, hookOk: !!hook.ok, at: Date.now() };
    const idx = db.remindLogs.findIndex(l => l.id === logId);
    if (idx >= 0) db.remindLogs[idx] = rec; else db.remindLogs.push(rec);
    if (db.remindLogs.length > 200) db.remindLogs = db.remindLogs.slice(-200);
    DB.save();
  }

  console.log(log(`trips=${trips.length} sent=${sent} failed=${failed} hook=${hook.ok}`));
  if (detail.length) console.log(log(detail.join(' | ')));
  return { ok: true, day, mode, trips: trips.length, sent, failed, hook, detail };
}

module.exports = { run, todayStr };
