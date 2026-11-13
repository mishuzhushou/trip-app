// 行程助手 H5 前端（原生 JS，无构建依赖）
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let TOKEN = localStorage.getItem('token') || '';
let ME = JSON.parse(localStorage.getItem('me') || 'null');
let EXEC_CACHE = [];
let INITED = false; // 系统是否已有账号（决定注册文案：管理员/成员）

// ---------- 基础 ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const j = await res.json().catch(() => ({ error: '服务无返回' }));
  if (res.status === 401) { logout(true); throw new Error(j.error || '未登录'); }
  if (!res.ok && !j.ok) throw new Error(j.error || ('请求失败 ' + res.status));
  return j;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2200);
}
function show(view) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
}
function switchTab(name) {
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('section').forEach(s => s.classList.add('hidden'));
  $('#tab-' + name).classList.remove('hidden');
}
function logout(silent) {
  if (!silent && TOKEN) api('/logout', { method: 'POST' }).catch(() => {});
  TOKEN = ''; ME = null; localStorage.clear();
  show('login');
}

// ---------- 登录 ----------
$('#btn-login').onclick = async () => {
  $('#login-err').textContent = '';
  try {
    const j = await api('/login', { method: 'POST', body: { username: $('#f-user').value.trim(), password: $('#f-pass').value } });
    TOKEN = j.token; ME = j.user;
    localStorage.setItem('token', TOKEN);
    localStorage.setItem('me', JSON.stringify(ME));
    enterMain();
  } catch (e) { $('#login-err').textContent = e.message; }
};
$('#btn-logout').onclick = () => logout(false);
$('#f-pass').addEventListener('keydown', e => { if (e.key === 'Enter') ($('#btn-register').classList.contains('hidden') ? $('#btn-login') : $('#btn-register')).click(); });

// ---------- 首次使用：注册（第一个账号为管理员，之后注册的都是成员） ----------
function setRegMode(on) {
  $('#f-name').classList.toggle('hidden', !on);
  $('#btn-login').classList.toggle('hidden', on);
  $('#btn-register').classList.toggle('hidden', !on);
  $('#btn-register').textContent = INITED ? '注 册 成 员 账 号' : '注 册 管 理 员 账 号';
  $('#reg-tip').textContent = on ? (INITED ? '注册后为普通成员账号，可在"管理"页申请负责的高管' : '注册的第一个账号自动成为管理员') : '';
  $('#link-toggle-reg').textContent = on ? '已有账号？去登录' : '首次使用？注册账号';
}
$('#link-toggle-reg').onclick = e => {
  e.preventDefault();
  $('#login-err').textContent = '';
  setRegMode($('#btn-register').classList.contains('hidden'));
};
$('#btn-register').onclick = async () => {
  $('#login-err').textContent = '';
  const username = $('#f-user').value.trim();
  const password = $('#f-pass').value;
  if (!username || password.length < 6) { $('#login-err').textContent = '请填写账号，密码至少 6 位'; return; }
  try {
    await api('/register', { method: 'POST', body: { username, password, name: $('#f-name').value.trim() } });
    const j = await api('/login', { method: 'POST', body: { username, password } });
    TOKEN = j.token; ME = j.user;
    localStorage.setItem('token', TOKEN);
    localStorage.setItem('me', JSON.stringify(ME));
    enterMain();
  } catch (e) { $('#login-err').textContent = e.message; }
};
// 打开页面时探测系统是否已初始化：未初始化直接显示注册（管理员），已初始化则显示登录、注册入口变成员注册
(async () => {
  try {
    const h = await fetch('/api/health').then(r => r.json());
    INITED = !!h.initialized;
    if (!INITED) setRegMode(true);
  } catch (e) { /* 忽略，默认显示登录 */ }
})();

function enterMain() {
  $('#hdr-user').textContent = (ME.name || ME.username) + (ME.role === 'admin' ? ' · 管理员' : ' · 秘书');
  show('main');
  switchTab('board');
  $('#board-date').value = todayStr();
  loadBoard();
}

// ---------- 看板 ----------
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const BOARD = { mode: 'day', execId: '', onlyCar: false, onlyMine: false, nearOpen: true };

// 长按删除（对齐小程序 bindlongpress）；桌面端用右键
function bindLongPress(el, fn) {
  let timer = null;
  el.addEventListener('touchstart', () => { timer = setTimeout(() => { timer = null; fn(); }, 550); }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev => el.addEventListener(ev, () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true }));
  el.addEventListener('contextmenu', e => { e.preventDefault(); fn(); });
}
function delTripById(id, name) {
  if (!id) return;
  if (!confirm('确定删除「' + (name || '该行程') + '」这条行程吗？\n删除后不可恢复（关联的约车信息也会一并清除）。')) return;
  api('/admin/trips/' + id + '/delete', { method: 'POST', body: {} })
    .then(() => { toast('已删除'); loadBoard(); })
    .catch(err => toast(err.message));
}
// 手动立即提醒（对齐小程序"🔔立即提醒"）：推送当天+明天未约车汇总到群
async function remindNow() {
  toast('发送中…');
  try {
    const r = await api('/remind-now', { method: 'POST', body: {} });
    toast(r.hook && r.hook.ok ? `提醒已发到群（待约 ${r.trips} 条）` : '提醒触发成功，请到群里查看');
  } catch (e) { toast('发送失败：' + e.message); }
}

function todayStr() {
  const d = new Date(Date.now() + 8 * 3600000);  // 北京时间
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  // 以北京时区为基准做日期加减（先解析北京时间零点，再整体平移读取）
  const base = Date.parse(dateStr + 'T00:00:00+08:00');
  return new Date(base + n * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
}
function weekdayOf(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return '';
  return '周' + WEEK[new Date(dateStr + 'T00:00:00+08:00').getDay()];
}
// 行程段展示文本：出发地(出发时间)→目的地(到达时间)，时间为空不拼括号
function segTextOf(s) {
  s = s || {};
  const dep = (s.depCity || '') + (s.depStation || '') + (s.depTime ? '(' + s.depTime + ')' : '');
  const arr = (s.arrCity || '') + (s.arrStation || '') + (s.arrTime ? '(' + s.arrTime + ')' : '');
  if (dep && arr) return dep + '→' + arr;
  return dep || arr || '';
}
// 行程的段列表：优先 segments（迁移数据可多段），否则用平铺字段合成单段
function segsOf(t) {
  if (t.segments && t.segments.length) return t.segments;
  if (!t.depCity && !t.arrCity && !t.no) return [];
  return [{ flightNo: t.vehicle === 'flight' ? t.no : '', trainNo: t.vehicle === 'train' ? t.no : '', depCity: t.depCity, depTime: t.depTime, arrCity: t.arrCity, arrTime: t.arrTime, seat: t.seat }];
}
function tripKey(t) {  // 排序键：日期 + 首段出发时间
  const segs = segsOf(t);
  const dep = (segs[0] && segs[0].depTime) || t.pickupTime || '';
  return (t.date || '') + ' ' + dep;
}
function statusTag(t) {
  if (t.status === 'changed') return '<span class="tag tag-orange">改签</span>';
  if (t.status === 'cancelled') return '<span class="tag tag-gray">取消</span>';
  return '<span class="tag tag-green">正常</span>';
}
function carTags(t) {
  if (!t.needCar) return '<span class="tag tag-gray">不约车</span>';
  let s = `<span class="tag ${t.carBooked ? 'tag-green' : 'tag-red'}">${t.carBooked ? '已约车' : '未约车'}${t.carType ? '·' + esc(t.carType) : ''}</span>`;
  if (t.carInfo) s += ` <span class="tag tag-gray">${esc(t.carInfo)}</span>`;
  return s;
}
function segLinesHtml(t) {
  return segsOf(t).map(s => {
    const no = s.flightNo || s.trainNo || '';
    return `<div class="seg-line">${no ? `<span class="tag tag-blue">${esc(no)}</span> ` : ''}${esc(segTextOf(s))}${s.seat ? `<span class="muted"> · ${esc(s.seat)}</span>` : ''}</div>`;
  }).join('');
}

$('#btn-refresh').onclick = loadBoard;
$('#board-date').onchange = loadBoard;
$('#f-onlycar').onchange = e => { BOARD.onlyCar = e.target.checked; loadBoard(); };
$('#f-onlymine').onchange = e => { BOARD.onlyMine = e.target.checked; loadBoard(); };
$('#mode-day').onclick = () => setMode('day');
$('#mode-all').onclick = () => setMode('all');
function setMode(m) {
  BOARD.mode = m;
  $('#mode-day').classList.toggle('on', m === 'day');
  $('#mode-all').classList.toggle('on', m === 'all');
  loadBoard();
}
$('#board-exec').onchange = e => { BOARD.execId = e.target.value; loadBoard(); };

async function loadBoard() {
  const box = $('#board-list');
  box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const j = await api('/trips');
    EXEC_CACHE = j.execs || [];
    // 高管筛选下拉（保留当前选择）
    const sel = $('#board-exec');
    const cur = BOARD.execId;
    sel.innerHTML = '<option value="">全部领导</option>' + EXEC_CACHE.map(e =>
      `<option value="${e.id}">${esc(e.name)}${e.title ? '（' + esc(e.title) + '）' : ''}</option>`).join('');
    sel.value = cur; if (sel.value !== cur) { BOARD.execId = ''; sel.value = ''; }

    const today = todayStr(), tomorrow = addDays(today, 1);
    const active = t => t.status !== 'changed' && t.status !== 'cancelled';
    let list = j.trips.filter(t => !BOARD.execId || t.execId === BOARD.execId);
    if (BOARD.onlyMine) list = list.filter(t => (ME.execIds || []).includes(t.execId));
    const filtered = list.filter(t => !BOARD.onlyCar || t.needCar);
    BOARD.cache = {};   // 所有可点击区域共用：明日约车卡 / 今明块 / 行程卡

    const todayTrips = list.filter(t => t.date === today && active(t)).sort((a, b) => tripKey(a).localeCompare(tripKey(b)));
    const tomorrowTrips = list.filter(t => t.date === tomorrow && active(t)).sort((a, b) => tripKey(a).localeCompare(tripKey(b)));
    const tomorrowCar = tomorrowTrips.filter(t => t.needCar);

    // 1) 明日需约车卡片（条目点击进详情；🔔立即提醒按钮，对齐小程序）
    $('#board-tomorrowcar').innerHTML = tomorrowCar.length ? `
      <div class="card-tool warn-card">
        <div class="row" style="margin-bottom:4px"><b style="color:#c05621">⚠️ 明日需约车（${tomorrowCar.length}）</b>
          <span class="flex1"></span><button id="btn-tomcar-remind" class="small ghost">🔔 立即提醒</button></div>
        ${tomorrowCar.map(t => `<div class="small muted car-line" data-id="${t.id}"><span class="tag ${t.carBooked ? 'tag-green' : 'tag-red'}">${t.carBooked ? '已约车' : '未约车'}</span>
          ${esc(execNameOf(t))} · ${t.date}${weekdayOf(t.date)} · ${esc(t.carType || '')} · ${esc(t.pickupTime || '')} ${esc(t.pickupAddr || '')}→${esc(t.dropoffAddr || '')}
          ${t.carInfo ? ' · ' + esc(t.carInfo) : ''}</div>`).join('')}
      </div>` : '';
    tomorrowCar.forEach(t => { BOARD.cache[t.id] = t; });
    const tomRemind = $('#btn-tomcar-remind');
    if (tomRemind) tomRemind.onclick = remindNow;
    $('#board-tomorrowcar').querySelectorAll('.car-line').forEach(line => {
      line.onclick = () => openDetail(line.dataset.id);
    });

    // 2) 今明两天行程（可折叠；条目点击进详情、长按/右键删除，对齐小程序）
    const un = tomorrowTrips.filter(t => t.needCar && !t.carBooked).length;
    let nearSummary = `今天 ${todayTrips.length} 条 · 明天 ${tomorrowTrips.length} 条`;
    if (un) nearSummary += ` · 未约车 ${un}`;
    const nearBlock = t => `
      <div class="day-block" data-id="${t.id}" data-name="${esc(execNameOf(t))}">
        <div class="day-title">${esc(execNameOf(t))} ${t.needCar ? `<span class="tag ${t.carBooked ? 'tag-green' : 'tag-red'}" style="margin-left:6px">${t.carBooked ? '已约车' : '未约车'}</span>` : ''}</div>
        ${segLinesHtml(t)}
      </div>`;
    $('#board-near').innerHTML = `
      <div class="card-tool near-card">
        <div class="near-head" id="near-head">
          <div><b>今明两天行程</b><div class="muted small">${nearSummary}</div></div>
          <span class="arrow ${BOARD.nearOpen ? 'up' : ''}">▾</span>
        </div>
        ${BOARD.nearOpen ? `
        <div class="day-label">今天（${today}）</div>
        ${todayTrips.length ? todayTrips.map(nearBlock).join('') : '<div class="muted small">今天暂无行程</div>'}
        <div class="day-label">明天（${tomorrow}）</div>
        ${tomorrowTrips.length ? tomorrowTrips.map(nearBlock).join('') : '<div class="muted small">明天暂无行程</div>'}` : ''}
      </div>`;
    const head = $('#near-head');
    if (head) head.onclick = () => { BOARD.nearOpen = !BOARD.nearOpen; loadBoard(); };
    todayTrips.concat(tomorrowTrips).forEach(t => { BOARD.cache[t.id] = t; });
    $('#board-near').querySelectorAll('.day-block').forEach(block => {
      block.onclick = () => openDetail(block.dataset.id);
      bindLongPress(block, () => delTripById(block.dataset.id, block.dataset.name));
    });

    // 3) 行程卡片（当日 / 全部）
    let cards;
    if (BOARD.mode === 'day') {
      const date = $('#board-date').value || today;
      cards = filtered.filter(t => t.date === date).sort((a, b) => tripKey(a).localeCompare(tripKey(b)));
      if (!cards.length) { box.innerHTML = '<p class="empty">当日暂无行程</p>'; return; }
    } else {
      cards = filtered.slice().sort((a, b) => tripKey(b).localeCompare(tripKey(a)));
      if (!cards.length) { box.innerHTML = '<p class="empty">暂无行程</p>'; return; }
    }
    box.innerHTML = cards.map(t => `
      <div class="trip-card" data-id="${t.id}">
        <div class="top"><span class="exec">${esc(execNameOf(t))} · ${t.date} ${weekdayOf(t.date)}</span>${statusTag(t)}</div>
        ${segLinesHtml(t)}
        <div class="row" style="margin-top:8px;margin-bottom:0">
          <div>${carTags(t)}${t.needCar && t.pickupTime ? ` <span class="tag tag-gray">${esc(t.pickupTime)} ${esc(t.pickupAddr || '')}→${esc(t.dropoffAddr || '')}</span>` : ''}</div>
        </div>
        <div class="actions">
          ${t.needCar ? `<button class="small ${t.carBooked ? 'ghost' : 'primary'} act-car" data-v="${t.carBooked ? 0 : 1}">${t.carBooked ? '✓ 已约车（点击取消）' : '标记已约车'}</button>` : ''}
          <button class="small act-del">删除</button>
          <span class="muted small" style="align-self:center;margin-left:auto">点卡片改行程/状态</span>
        </div>
      </div>`).join('');
    cards.forEach(t => { BOARD.cache[t.id] = t; });
    box.querySelectorAll('.trip-card').forEach(card => {
      card.onclick = e => { if (e.target.closest('button')) return; openDetail(card.dataset.id); };
    });
    box.querySelectorAll('.act-car').forEach(b => b.onclick = async e => {
      const id = e.target.closest('.trip-card').dataset.id;
      try { await api('/trips/' + id, { method: 'POST', body: { carBooked: Number(e.target.dataset.v) } }); toast('已更新'); loadBoard(); }
      catch (err) { toast(err.message); }
    });
    box.querySelectorAll('.act-del').forEach(b => b.onclick = async e => {
      const card = e.target.closest('.trip-card');
      if (!confirm('确定删除这条行程吗？删除后不可恢复。')) return;
      try { await api('/admin/trips/' + card.dataset.id + '/delete', { method: 'POST', body: {} }); toast('已删除'); loadBoard(); }
      catch (err) { toast(err.message); }
    });
  } catch (e) { box.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; }
}
function execNameOf(t) {
  const e = EXEC_CACHE.find(x => x.id === t.execId);
  return (e && e.name) || t.execName || '?';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 行程详情编辑（对齐小程序 trip-detail） ----------
let TM = null;   // 当前编辑的行程
const $tm = s => document.querySelector('#trip-modal ' + s);

function openDetail(id) {
  const t = BOARD.cache[id];
  if (!t) return;
  TM = t;
  // 高管下拉
  const sel = $tm('#tm-exec');
  sel.innerHTML = EXEC_CACHE.map(e => `<option value="${e.id}">${esc(e.name)}${e.title ? '（' + esc(e.title) + '）' : ''}</option>`).join('');
  sel.value = t.execId;
  $tm('#tm-date').value = t.date;
  // 行程段
  renderSegs(segsOf(t).map(s => Object.assign({}, s)));
  // 状态
  setSt(t.status || 'active');
  // 约车
  $tm('#tm-needcar').checked = !!t.needCar;
  $tm('#tm-carbooked').checked = !!t.carBooked;
  $tm('#tm-cartype').value = t.carType || '';
  $tm('#tm-pickupt').value = t.pickupTime || '';
  $tm('#tm-pickupa').value = t.pickupAddr || '';
  $tm('#tm-dropoffa').value = t.dropoffAddr || '';
  $tm('#tm-carinfo').value = t.carInfo || '';
  syncCar();
  $tm('#tm-raw').value = t.rawText || '';
  $tm('#tm-speech-out').classList.add('hidden');
  $tm('#tm-copy').classList.add('hidden');
  $('#trip-modal').classList.remove('hidden');
}
function closeDetail() { $('#trip-modal').classList.add('hidden'); TM = null; }
$('#tm-close').onclick = closeDetail;
$('#trip-modal').onclick = e => { if (e.target.id === 'trip-modal') closeDetail(); };

function renderSegs(segs) {
  const box = $tm('#tm-segs');
  box.innerHTML = segs.map((s, i) => `
    <div class="seg-edit" data-i="${i}">
      <div class="line"><b>行程段 ${i + 1}</b>${segs.length > 1 ? `<button class="small seg-del" style="color:#c33">删除</button>` : ''}</div>
      <div class="grid2">
        <label>航班/车次 <input class="s-no" type="text" value="${esc(s.flightNo || s.trainNo || '')}" placeholder="如 G6551 / CZ3456"></label>
        <label>座位 <input class="s-seat" type="text" value="${esc(s.seat || '')}"></label>
        <label>出发地 <input class="s-dep" type="text" value="${esc(s.depCity || '')}"></label>
        <label>航站楼/车站 <input class="s-depst" type="text" value="${esc(s.depStation || '')}"></label>
        <label>出发时间 <input class="s-dept" type="text" value="${esc(s.depTime || '')}" maxlength="5" placeholder="14:09"></label>
        <label>到达地 <input class="s-arr" type="text" value="${esc(s.arrCity || '')}"></label>
        <label>航站楼/车站 <input class="s-arrst" type="text" value="${esc(s.arrStation || '')}"></label>
        <label>到达时间 <input class="s-arrt" type="text" value="${esc(s.arrTime || '')}" maxlength="5" placeholder="18:11"></label>
      </div>
    </div>`).join('');
  box.querySelectorAll('.seg-del').forEach(b => b.onclick = () => {
    const rows = collectSegs();
    rows.splice(Number(b.closest('.seg-edit').dataset.i), 1);
    renderSegs(rows);
  });
}
function collectSegs() {
  return Array.from($tm('#tm-segs').querySelectorAll('.seg-edit')).map(row => {
    const no = row.querySelector('.s-no').value.trim();
    const isFlight = /^[A-Z0-9]{2}\d/i.test(no.replace(/\(.*\)/, ''));
    return {
      flightNo: isFlight ? no : '',
      trainNo: isFlight ? '' : no,
      depCity: row.querySelector('.s-dep').value.trim(),
      depStation: row.querySelector('.s-depst').value.trim(),
      depTime: row.querySelector('.s-dept').value.trim(),
      arrCity: row.querySelector('.s-arr').value.trim(),
      arrStation: row.querySelector('.s-arrst').value.trim(),
      arrTime: row.querySelector('.s-arrt').value.trim(),
      seat: row.querySelector('.s-seat').value.trim(),
      date: TM ? TM.date : '', weekday: TM ? TM.weekday : ''
    };
  });
}
$('#tm-addseg').onclick = () => {
  const rows = collectSegs();
  rows.push({ flightNo: '', trainNo: '', depCity: '', depStation: '', depTime: '', arrCity: '', arrStation: '', arrTime: '', seat: '', date: TM.date, weekday: '' });
  renderSegs(rows);
};
function setSt(v) {
  $tm('#tm-status').querySelectorAll('.st').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  // 改签状态下才显示"重新录入行程"按钮（对齐小程序改签流程）
  $tm('#tm-reenter').classList.toggle('hidden', v !== 'changed');
}
$tm('#tm-status').querySelectorAll('.st').forEach(b => b.onclick = () => setSt(b.dataset.v));
function syncCar() {
  const on = $tm('#tm-needcar').checked;
  ['tm-cartype', 'tm-pickupt', 'tm-pickupa', 'tm-dropoffa', 'tm-carinfo'].forEach(id => { $tm('#' + id).disabled = !on; });
  const booked = $tm('#tm-carbooked').checked;
  $tm('#tm-remind-hint').textContent = on
    ? (booked ? '✅ 已确认约车，系统将停止该行程的追提醒。' : '车约好后请勾选「确认已约车」，否则 17:00 后系统每小时提醒一次。')
    : '该行程不约车，不参与提醒。';
}
$tm('#tm-needcar').onchange = syncCar;
$tm('#tm-carbooked').onchange = syncCar;

// ---------- 话术生成（完整移植小程序 genSpeech 模板） ----------
function mdOf(dateStr) {
  const d = new Date((dateStr || '') + 'T00:00:00+08:00');
  if (isNaN(d.getTime())) return { m: '', d: '' };
  return { m: d.getMonth() + 1, d: d.getDate() };
}
// 称呼：存储称呼无效时退回"姓+总"
function titleOf(execName, storedTitle) {
  const n = (execName || '').trim();
  let t = (storedTitle || '').trim();
  if (t && n && (t === n || t === n + '总')) t = '';
  if (t === '领导') t = '';
  if (!t && n) t = n.charAt(0) + '总';
  return t || '领导';
}
// 时间段前缀：凌晨/上午/中午/下午/晚上
function periodOf(t) {
  const h = parseInt((t || '').split(':')[0], 10);
  if (isNaN(h)) return '';
  if (h < 6) return '凌晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  return '晚上';
}
// "明天"处理：默认明天；非次日则替换为今天/后天/周X/具体日期
function dayWord(date, baseDateStr) {
  const base = new Date((baseDateStr || todayStr()) + 'T00:00:00+08:00');
  const cur = new Date((date || '') + 'T00:00:00+08:00');
  if (isNaN(base.getTime()) || isNaN(cur.getTime())) return '';
  const diff = Math.round((cur - base) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff > 2 && diff <= 7) return '周' + WEEK[cur.getDay()];
  return (cur.getMonth() + 1) + '月' + cur.getDate() + '日';
}
function minusMinutes(hhmm, mins) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return hhmm;
  let total = (+m[1]) * 60 + (+m[2]) - mins;
  if (total < 0) total += 24 * 60;
  const h = Math.floor(total / 60), mm = total % 60;
  return (h < 10 ? '0' + h : '' + h) + ':' + (mm < 10 ? '0' + mm : '' + mm);
}
// 高管汇报话术（订票成功通知）
function execSpeechText(trip) {
  const title = titleOf(trip.execName, trip.title);
  const segs = (trip.segments || []).map(s => {
    const { m, d } = mdOf(s.date || trip.date);
    const md = m ? `${m}月${d}日` : '';
    const no = s.flightNo || s.trainNo || '';
    let line = `${md}${s.weekday || ''}，${no}，`;
    line += `${s.depCity || ''}${s.depStation || ''}(${s.depTime || ''})→${s.arrCity || ''}${s.arrStation || ''}(${s.arrTime || ''})`;
    if (s.seat) line += `，${s.seat}`;
    return line;
  });
  return `${title}，已订票成功：\n${segs.join('\n\n')}`;
}
// 约车话术（发司机调度/祥兰）：送机/接机/临时三种模板
function driverSpeechText(cb, baseDateStr) {
  const title = titleOf(cb.execName, cb.title);
  const day = dayWord(cb.date, baseDateStr);
  const { m, d } = mdOf(cb.date);
  const md = `${m}月${d}日`;
  const wd = cb.weekday || weekdayOf(cb.date);
  const p = periodOf(cb.pickupTime);
  const phone = cb.phone ? (' ' + String(cb.phone).trim()) : '';
  const flightNo = cb.flightNo || '';
  const flightTime = cb.flightTime || '';
  const useTime = cb.pickupTime || '';
  const flightTag = /实承/.test(flightNo) ? flightNo : (flightNo ? `（${flightNo}）` : '');
  const type = cb.carType || '';
  const isPick = type.indexOf('接机') >= 0;
  const from = cb.fromAddr || cb.pickupAddr || (isPick ? (cb.terminal || '集团') : '集团');
  const dest = cb.destAddr || cb.dropoffAddr || (isPick ? '集团' : (cb.terminal || '集团'));
  if (type.indexOf('送机') >= 0) {
    return `祥兰，麻烦帮忙安排一下${day}${title}的送机/站：\n`
      + `1.时间：${wd}（${md}）${p}${useTime}\n`
      + `2.用车人：${title}${phone}\n`
      + `3.行程：${useTime}${from}出发去${dest}${flightTag}${flightTime ? flightTime + '起飞' : ''}`;
  }
  if (isPick) {
    return `祥兰，麻烦安排${title}${day}${p}接机/站\n`
      + `1.时间：${wd}（${md}）${p}${useTime}\n`
      + `2.用车人：${title}${phone}\n`
      + `3.行程：${useTime}前在${from}接${title}回${dest}${flightTag}${flightTime ? flightTime + '落地' : ''}`;
  }
  return `祥兰，麻烦帮忙安排一下${day}${title}的用车：\n`
    + `1.时间：${wd}（${md}）${p}${useTime}\n`
    + `2.用车人：${title}${phone}\n`
    + `3.行程：${useTime}从${from}前往${dest}`;
}

function buildSpeech(kind) {
  const exec = EXEC_CACHE.find(x => x.id === $tm('#tm-exec').value) || {};
  const date = $tm('#tm-date').value;
  const segs = collectSegs();
  if (kind === 'car') {
    const type = $tm('#tm-cartype').value;
    const isPick = type.indexOf('接机') >= 0;
    const seg = segs[0] || {};
    // 未填用车时间兜底：送机 = 起飞前 2.5 小时；接机 = 落地时间
    const flightTime = (isPick ? seg.arrTime : seg.depTime) || '';
    let useTime = $tm('#tm-pickupt').value;
    if (!useTime && flightTime) useTime = isPick ? flightTime : minusMinutes(flightTime, 150);
    return driverSpeechText({
      carType: type,
      execName: exec.name || execNameOf(TM),
      title: exec.title || '',
      date, weekday: weekdayOf(date),
      pickupTime: useTime,
      terminal: isPick ? ((seg.arrCity || '') + (seg.arrStation || '')) : ((seg.depCity || '') + (seg.depStation || '')),
      flightNo: seg.flightNo || seg.trainNo || '',
      flightTime,
      fromAddr: $tm('#tm-pickupa').value.trim(),
      destAddr: $tm('#tm-dropoffa').value.trim(),
      phone: exec.phone || ''
    });
  }
  return execSpeechText({
    execName: exec.name || execNameOf(TM),
    title: exec.title || '',
    date,
    segments: segs.map(s => Object.assign({ date, weekday: weekdayOf(date) }, s))
  });
}
$tm('#tm-speech-car').onclick = () => showSpeech(buildSpeech('car'));
$tm('#tm-speech-exec').onclick = () => showSpeech(buildSpeech('exec'));
function showSpeech(text) {
  const out = $tm('#tm-speech-out');
  out.value = text;
  out.classList.remove('hidden');
  $tm('#tm-copy').classList.remove('hidden');
}
$tm('#tm-copy').onclick = () => {
  const out = $tm('#tm-speech-out');
  out.select();
  navigator.clipboard ? navigator.clipboard.writeText(out.value).then(() => toast('已复制')) : document.execCommand('copy');
};

$tm('#tm-save').onclick = async () => {
  if (!TM) return;
  const body = {
    execId: $tm('#tm-exec').value,
    date: $tm('#tm-date').value,
    segments: collectSegs(),
    status: $tm('#tm-status').querySelector('.st.on') ? $tm('#tm-status').querySelector('.st.on').dataset.v : 'active',
    needCar: $tm('#tm-needcar').checked ? 1 : 0,
    carBooked: $tm('#tm-needcar').checked && $tm('#tm-carbooked').checked ? 1 : 0,
    carType: $tm('#tm-needcar').checked ? $tm('#tm-cartype').value : '',
    pickupTime: $tm('#tm-needcar').checked ? $tm('#tm-pickupt').value : '',
    pickupAddr: $tm('#tm-needcar').checked ? $tm('#tm-pickupa').value.trim() : '',
    dropoffAddr: $tm('#tm-needcar').checked ? $tm('#tm-dropoffa').value.trim() : '',
    carInfo: $tm('#tm-needcar').checked ? $tm('#tm-carinfo').value.trim() : ''
  };
  try {
    await api('/trips/' + TM.id, { method: 'POST', body });
    toast('已保存');
    closeDetail();
    loadBoard();
  } catch (e) { toast(e.message); }
};
$tm('#tm-del').onclick = async () => {
  if (!TM) return;
  if (!confirm('确定删除这条行程吗？删除后不可恢复。')) return;
  try {
    await api('/admin/trips/' + TM.id + '/delete', { method: 'POST', body: {} });
    toast('已删除');
    closeDetail();
    loadBoard();
  } catch (e) { toast(e.message); }
};

// ---------- 改签：重新录入行程（新行程直接顶替本条，对齐小程序） ----------
let REPLACE = null;   // {id, label} 改签模式下保存时替换该行程
$tm('#tm-reenter').onclick = () => {
  if (!TM) return;
  if (!confirm('将进入登记页粘贴/拍摄新的订票信息；保存后新行程会直接顶替本条行程，原约车确认自动失效。继续吗？')) return;
  REPLACE = { id: TM.id, label: `${execNameOf(TM)} ${TM.date} ${weekdayOf(TM.date)} 的行程` };
  $('#replace-banner').classList.remove('hidden');
  $('#replace-info').textContent = `保存后将替换：${REPLACE.label}`;
  closeDetail();
  switchTab('add');
  $('#raw-text').focus();
  toast('已进入改签模式，请粘贴或拍摄新的订票信息');
};
$('#btn-replace-cancel').onclick = () => {
  REPLACE = null;
  $('#replace-banner').classList.add('hidden');
  toast('已取消改签');
};

// ---------- 登记行程 ----------
$('nav').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  switchTab(b.dataset.tab);
  if (b.dataset.tab === 'board') loadBoard();
  if (b.dataset.tab === 'history') loadHistory();
  if (b.dataset.tab === 'admin') loadAdmin();
});

$('#btn-parse').onclick = async () => {
  const text = $('#raw-text').value.trim();
  if (!text) return toast('请先粘贴行程文本');
  try {
    const j = await api('/parse', { method: 'POST', body: { text } });
    if (!j.segments || !j.segments.length) return toast('未能解析出行程，请检查文本或手动填写');
    renderParsed(j.segments, j.execName, text);
  } catch (e) { toast(e.message); }
};

// ---- OCR：拍照/选图 → 服务端识别 → 自动解析 ----
$('#btn-ocr').onclick = () => $('#ocr-file').click();
$('#ocr-file').onchange = async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const hint = $('#ocr-hint');
  hint.textContent = '识别中，请稍候…';
  try {
    const dataUrl = await compressImage(file, 1600, 0.82);
    const j = await api('/ocr', { method: 'POST', body: { image: dataUrl } });
    $('#raw-text').value = j.text || '';
    if (!j.segments || !j.segments.length) {
      hint.textContent = '已识别文字，但未解析出结构，请核对下方文本后手动修正';
      return;
    }
    hint.textContent = `识别成功：${j.lines} 行文字，解析出 ${j.segments.length} 段行程`;
    renderParsed(j.segments, j.execName, j.text || '');
  } catch (err) {
    hint.textContent = '识别失败：' + err.message;
    toast(err.message);
  }
};

// 客户端压缩：长边限制 + JPEG 质量，避免上传过大
function compressImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片格式不支持'));
      img.onload = () => {
        let { width: w, height: h } = img;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// 渲染解析结果（文本解析与 OCR 共用）：一条行程可含多段，支持增删改，高管自动匹配
function blankRegSeg() {
  return { flightNo: '', trainNo: '', depCity: '', depStation: '', depTime: '', arrCity: '', arrStation: '', arrTime: '', seat: '', date: '', weekday: '' };
}
// 解析结果段 → 编辑器段（航班号归 flightNo，车次归 trainNo）
function normalizeParsedSeg(s) {
  s = s || {};
  const row = blankRegSeg();
  if (s.type === 'flight') row.flightNo = s.flightNo || '';
  else if (s.type === 'train') row.trainNo = s.trainNo || s.flightNo || '';
  row.depCity = s.depCity || ''; row.depStation = s.depStation || '';
  row.depTime = s.depTime || ''; row.arrCity = s.arrCity || '';
  row.arrStation = s.arrStation || ''; row.arrTime = s.arrTime || '';
  row.seat = s.seat || ''; row.date = s.date || ''; row.weekday = s.weekday || '';
  return row;
}
function renderRegSegs(box, segs) {
  box.innerHTML = segs.map((s, i) => `
    <div class="seg-edit" data-i="${i}">
      <div class="line"><b>行程段 ${i + 1}</b>${segs.length > 1 ? `<button class="small r-segdel" style="color:#c33">删除</button>` : ''}</div>
      <div class="grid2">
        <label>航班/车次 <input class="r-no" type="text" value="${esc(s.flightNo || s.trainNo || '')}" placeholder="如 G6551 / CZ3456"></label>
        <label>座位 <input class="r-seat" type="text" value="${esc(s.seat || '')}"></label>
        <label>出发地 <input class="r-dep" type="text" value="${esc(s.depCity || '')}"></label>
        <label>航站楼/车站 <input class="r-depst" type="text" value="${esc(s.depStation || '')}"></label>
        <label>出发时间 <input class="r-dept" type="text" value="${esc(s.depTime || '')}" maxlength="5" placeholder="14:09"></label>
        <label>到达地 <input class="r-arr" type="text" value="${esc(s.arrCity || '')}"></label>
        <label>航站楼/车站 <input class="r-arrst" type="text" value="${esc(s.arrStation || '')}"></label>
        <label>到达时间 <input class="r-arrt" type="text" value="${esc(s.arrTime || '')}" maxlength="5" placeholder="18:11"></label>
      </div>
    </div>`).join('');
  box.querySelectorAll('.r-segdel').forEach(b => b.onclick = () => {
    const rows = collectRegSegs(box);
    rows.splice(Number(b.closest('.seg-edit').dataset.i), 1);
    renderRegSegs(box, rows.length ? rows : [blankRegSeg()]);
  });
}
function collectRegSegs(box) {
  return Array.from(box.querySelectorAll('.seg-edit')).map(row => {
    const no = row.querySelector('.r-no').value.trim();
    const isFlight = /^[A-Z0-9]{2}\d/i.test(no.replace(/\(.*\)/, ''));
    return {
      flightNo: isFlight ? no : '',
      trainNo: isFlight ? '' : no,
      depCity: row.querySelector('.r-dep').value.trim(),
      depStation: row.querySelector('.r-depst').value.trim(),
      depTime: row.querySelector('.r-dept').value.trim(),
      arrCity: row.querySelector('.r-arr').value.trim(),
      arrStation: row.querySelector('.r-arrst').value.trim(),
      arrTime: row.querySelector('.r-arrt').value.trim(),
      seat: row.querySelector('.r-seat').value.trim()
    };
  });
}

function renderParsed(segments, execName, rawText) {
  const tpl = $('#tpl-trip-form');
  const box = $('#parsed-list');
  segments = segments || [];
  box.innerHTML = `<p class="muted">解析出 ${segments.length} 段行程，核对后保存${execName ? '（已识别乘机人：' + esc(execName) + '）' : ''}：</p>`;
  const node = tpl.content.cloneNode(true);
  const f = node.querySelector('.trip-form');
  const sel = f.querySelector('.f-exec');
  sel.innerHTML = EXEC_CACHE.map(e => `<option value="${e.id}">${esc(e.name)}${e.title ? '（' + esc(e.title) + '）' : ''}</option>`).join('') || '<option value="">（请先在管理页添加高管）</option>';
  if (execName) {
    const hit = EXEC_CACHE.find(e => e.name === execName);
    if (hit) sel.value = hit.id;
  }
  const firstDate = (segments[0] && segments[0].date) || todayStr();
  f.querySelector('.f-date').value = /^\d{4}-\d{2}-\d{2}$/.test(firstDate) ? firstDate : todayStr();

  const segsBox = f.querySelector('.segs');
  const segs = segments.length ? segments.map(normalizeParsedSeg) : [blankRegSeg()];
  renderRegSegs(segsBox, segs);
  f.querySelector('.btn-addseg').onclick = () => {
    const rows = collectRegSegs(segsBox);
    rows.push(blankRegSeg());
    renderRegSegs(segsBox, rows);
  };

  // 纯约车文本（无航班/车次）：自动勾选需约车并填入临时用车信息
  const needcar = f.querySelector('.f-needcar');
  const carExtra = f.querySelector('.car-extra');
  const isCarOnly = segments.length === 1 && segments[0].type === 'car';
  if (isCarOnly) {
    needcar.checked = true;
    f.querySelector('.f-cartype').value = '临时';
    f.querySelector('.f-pickupt').value = segments[0].depTime || '';
    f.querySelector('.f-pickupa').value = segments[0].depCity || '';
    f.querySelector('.f-dropoffa').value = segments[0].arrCity || '';
  }
  const syncCar = () => { carExtra.classList.toggle('hidden', !needcar.checked); };
  needcar.onchange = syncCar; syncCar();

  f.querySelector('.btn-save').onclick = async () => {
    const date = f.querySelector('.f-date').value;
    const segRows = collectRegSegs(segsBox);
    if (!date) return toast('请选择日期');
    if (!segRows.length || (!segRows[0].depCity && !segRows[0].flightNo && !segRows[0].trainNo)) return toast('请至少填写一段行程');
    const body = {
      execId: sel.value, date,
      segments: segRows.map(r => Object.assign({ date, weekday: weekdayOf(date) }, r)),
      status: 'active',
      needCar: needcar.checked ? 1 : 0,
      carType: needcar.checked ? f.querySelector('.f-cartype').value : '',
      pickupTime: needcar.checked ? f.querySelector('.f-pickupt').value : '',
      pickupAddr: needcar.checked ? f.querySelector('.f-pickupa').value.trim() : '',
      dropoffAddr: needcar.checked ? f.querySelector('.f-dropoffa').value.trim() : '',
      carInfo: needcar.checked ? f.querySelector('.f-carinfo').value.trim() : '',
      rawText: rawText || ''
    };
    try {
      if (REPLACE) {
        // 改签替换：新行程顶替原行程；原约车确认自动失效（对齐小程序）
        await api('/trips/' + REPLACE.id, { method: 'POST', body: Object.assign({}, body, { carBooked: 0, carInfo: '' }) });
        toast('已用新行程替换原行程');
        REPLACE = null;
        $('#replace-banner').classList.add('hidden');
      } else {
        await api('/trips', { method: 'POST', body });
        toast('已保存');
      }
      f.remove();
      loadBoard();
    } catch (err) { toast(err.message); }
  };
  box.appendChild(node);
}

// ---------- 历史行程查询 + 导出 Excel ----------
const HIS = { trips: [] };

async function loadHistory() {
  const sel = $('#his-exec');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部领导</option>' + EXEC_CACHE.map(e =>
    `<option value="${e.id}">${esc(e.name)}${e.title ? '（' + esc(e.title) + '）' : ''}</option>`).join('');
  sel.value = cur;
  await queryHistory();
}

async function queryHistory() {
  const box = $('#his-table');
  const from = $('#his-from').value, to = $('#his-to').value;
  const qs = [];
  if (from) qs.push('from=' + from);
  if (to) qs.push('to=' + to);
  box.innerHTML = '<p class="empty">查询中…</p>';
  try {
    const j = await api('/trips' + (qs.length ? '?' + qs.join('&') : ''));
    HIS.trips = j.trips || [];
    renderHistory();
  } catch (e) { box.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; }
}

function hisFilter() {
  const execId = $('#his-exec').value;
  const kw = $('#his-kw').value.trim().toLowerCase();
  const onlyCar = $('#his-onlycar').checked;
  let list = HIS.trips.filter(t => !execId || t.execId === execId);
  if (onlyCar) list = list.filter(t => t.needCar);
  if (kw) {
    const hay = t => [t.no, t.depCity, t.arrCity, t.carInfo, t.pickupAddr, t.dropoffAddr, t.remark,
      ...segsOf(t).map(s => [s.flightNo, s.trainNo, s.depCity, s.depStation, s.arrCity, s.arrStation])].join('|').toLowerCase();
    list = list.filter(t => hay(t).includes(kw));
  }
  return list.sort((a, b) => tripKey(b).localeCompare(tripKey(a)));
}

function renderHistory() {
  const list = hisFilter();
  $('#his-count').textContent = `共 ${list.length} 条`;
  if (!list.length) { $('#his-table').innerHTML = '<p class="empty">没有符合条件的行程</p>'; return; }
  $('#his-table').innerHTML = `
    <div class="hist-scroll"><table class="hist-table">
      <thead><tr><th>日期</th><th>星期</th><th>高管</th><th>行程</th><th>约车</th><th>车辆/司机</th><th>状态</th></tr></thead>
      <tbody>
        ${list.map(t => `
          <tr>
            <td>${t.date}</td>
            <td>${weekdayOf(t.date)}</td>
            <td>${esc(execNameOf(t))}</td>
            <td class="his-segs">${segLinesHtml(t)}</td>
            <td>${carTags(t)}${t.needCar && t.pickupTime ? `<div class="muted small">${esc(t.pickupTime)} ${esc(t.pickupAddr || '')}→${esc(t.dropoffAddr || '')}</div>` : ''}</td>
            <td>${esc(t.carInfo || '')}</td>
            <td>${statusTag(t)}</td>
          </tr>`).join('')}
      </tbody>
    </table></div>`;
}

$('#btn-his-query').onclick = queryHistory;
$('#his-exec').onchange = () => renderHistory();
$('#his-kw').oninput = () => renderHistory();
$('#his-onlycar').onchange = () => renderHistory();

// 导出 Excel（SheetJS 已本地打包；万一加载失败自动降级 CSV，Excel 可直接打开）
$('#btn-his-export').onclick = () => {
  const list = hisFilter();
  if (!list.length) return toast('没有可导出的行程');
  const rows = list.map(t => {
    const e = EXEC_CACHE.find(x => x.id === t.execId) || {};
    const segs = segsOf(t).map(s => {
      const no = s.flightNo || s.trainNo || '';
      return `${no ? no + ' ' : ''}${(s.depCity || '') + (s.depStation || '')} ${s.depTime || ''} → ${(s.arrCity || '') + (s.arrStation || '')} ${s.arrTime || ''}${s.seat ? '（' + s.seat + '）' : ''}`;
    }).join('\n');
    return {
      '日期': t.date, '星期': weekdayOf(t.date), '高管': e.name || '', '职务': e.title || '',
      '行程': segs,
      '需约车': t.needCar ? '是' : '否',
      '约车状态': t.needCar ? (t.carBooked ? '已约车' : '未约车') : '—',
      '车型': t.carType || '', '上车时间': t.pickupTime || '',
      '上车地点': t.pickupAddr || '', '下车地点': t.dropoffAddr || '',
      '车辆/司机': t.carInfo || '',
      '行程状态': t.status === 'changed' ? '改签' : t.status === 'cancelled' ? '取消' : '正常'
    };
  });
  const fname = `行程历史_${todayStr()}.xlsx`;
  try {
    if (typeof XLSX === 'undefined') throw new Error('no xlsx');
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 11 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 46 }, { wch: 7 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 9 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '行程历史');
    XLSX.writeFile(wb, fname);
    toast('已导出 ' + fname);
  } catch (e) {
    const csv = '\ufeff' + Object.keys(rows[0]).join(',') + '\n' + rows.map(r =>
      Object.values(r).map(v => '"' + String(v).replace(/"/g, '""').replace(/\n/g, ' ') + '"').join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = fname.replace('.xlsx', '.csv');
    a.click();
    toast('已导出 CSV（Excel 可直接打开）');
  }
};

// ---------- 我的高管（成员查看 / 申请负责；嵌在管理页顶部，全员可见） ----------
async function loadMine() {
  const mineBox = $('#mine-list'), applyBox = $('#apply-list'), applyCard = $('#grp-apply');
  mineBox.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const j = await api('/execs');
    if (ME.role === 'admin') {
      mineBox.innerHTML = j.execs.length
        ? j.execs.map(e => `<div class="mine-item"><b>${esc(e.name)}</b><span class="muted">${esc(e.title || '')}${e.phone ? ' · ' + esc(e.phone) : ''}</span></div>`).join('')
        : '<p class="empty">暂无高管，请在下方「高管管理」中添加。</p>';
      if (applyCard) applyCard.classList.add('hidden');
      return;
    }
    if (applyCard) applyCard.classList.remove('hidden');
    const mine = j.execs.filter(e => e.mine);
    mineBox.innerHTML = mine.length
      ? mine.map(e => `<div class="mine-item"><b>${esc(e.name)}</b><span class="muted">${esc(e.title || '')}${e.phone ? ' · ' + esc(e.phone) : ''}</span></div>`).join('')
      : '<p class="empty">还没有负责的高管，请在下方申请。</p>';
    const pendIds = new Set((j.myApplies || []).map(a => a.execId));
    const others = j.execs.filter(e => !e.mine);
    applyBox.innerHTML = others.length
      ? others.map(e => `<div class="mine-item"><b>${esc(e.name)}</b><span class="muted">${esc(e.title || '')}</span>
          <span class="tools">${pendIds.has(e.id)
            ? '<span class="tag tag-orange">待审批</span>'
            : `<button class="small primary act-apply" data-id="${e.id}">申请负责</button>`}</span></div>`).join('')
      : '<p class="empty">全部高管已由你负责。</p>';
    applyBox.querySelectorAll('.act-apply').forEach(b => b.onclick = async () => {
      try { await api('/apply-exec', { method: 'POST', body: { execId: b.dataset.id } }); toast('已提交申请，等待管理员审批'); loadMine(); }
      catch (err) { toast(err.message); }
    });
  } catch (e) { mineBox.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; }
}

// ---------- 管理 ----------
async function loadAdmin() {
  await loadMine();   // 我的高管（全员可见）
  if (ME.role !== 'admin') {
    // 普通成员：只显示自助区，隐藏管理员功能区
    $('#admin-only').classList.add('hidden');
    return;
  }
  $('#admin-only').classList.remove('hidden');
  try {
    const j = await api('/admin/users');

    // 待审批申请（成员申请负责高管）
    try {
      const ja = await api('/admin/applies');
      const badgeAp = $('#badge-applies');
      if (badgeAp) { badgeAp.textContent = ja.applies.length; badgeAp.classList.toggle('zero', !ja.applies.length); }
      const grpAp = $('#grp-applies');
      if (grpAp && ja.applies.length) grpAp.open = true; // 有待审批时自动展开
      $('#admin-applies').innerHTML = ja.applies.length ? ja.applies.map(a => `
        <div class="admin-item"><div class="line"><b>${esc(a.name)}</b>
          <span class="muted">申请负责</span> <b>${esc(a.execName)}</b>
          <span class="tools"><button class="small primary ap-ok" data-id="${a.id}">✓ 同意</button>
          <button class="small ap-no" data-id="${a.id}" style="color:#c53030">✕ 拒绝</button></span></div></div>`).join('')
        : '<p class="muted small">暂无待审批申请。</p>';
      $('#admin-applies').querySelectorAll('.ap-ok,.ap-no').forEach(b => b.onclick = async () => {
        const ok = b.classList.contains('ap-ok');
        try {
          await api('/admin/applies/' + b.dataset.id, { method: 'POST', body: { action: ok ? 'approve' : 'reject' } });
          toast(ok ? '已同意' : '已拒绝'); loadAdmin();
        } catch (e) { toast(e.message); }
      });
    } catch (e2) { /* 忽略审批接口异常 */ }

    const execName = id => (j.execs.find(e => e.id === id) || {}).name || '';
    const badgeUs = $('#badge-users');
    if (badgeUs) { badgeUs.textContent = j.users.length; badgeUs.classList.remove('zero'); }
    $('#admin-users').innerHTML = j.users.map(u => `
      <div class="admin-item" data-id="${u.id}">
        <div class="line"><b>${esc(u.name || u.username)}</b>
          <span class="muted small">（账号：${esc(u.username)}）</span>
          <span class="tag ${u.role === 'admin' ? 'tag-red' : 'tag-gray'}">${u.role === 'admin' ? '管理员' : '秘书'}</span>
          ${u.status === 'blocked' ? '<span class="tag tag-red">黑名单</span>' : (u.status !== 'active' ? '<span class="tag tag-orange">停用</span>' : '')}
          <span class="muted">企微ID：${esc(u.wecomUserid || '未填')}</span></div>
        <div class="tools">
          <input class="a-name" type="text" value="${esc(u.name)}" placeholder="姓名">
          <input class="a-wxid" type="text" value="${esc(u.wecomUserid || '')}" placeholder="企微userid(用于定向提醒)">
          <button class="small a-save">保存资料</button>
          <button class="small a-pass">重置密码</button>
          <button class="small a-toggle">${u.status === 'active' ? '停用' : '启用'}</button>
          <button class="small a-block">${u.status === 'blocked' ? '解除拉黑' : '拉黑'}</button>
          <button class="small a-remove" style="color:#c53030">移除</button>
          <button class="small a-role">${u.role === 'admin' ? '改为秘书' : '改为管理员'}</button>
        </div>
        <label class="lbl">分管高管（点击切换）</label>
        <div class="exec-chips">${j.execs.map(e =>
          `<span class="chip ${u.execIds.includes(e.id) ? 'on' : ''}" data-exec="${e.id}">${esc(e.name)}${e.active ? '' : '(停)'}</span>`).join('')}</div>
      </div>`).join('');
    $('#admin-users').querySelectorAll('.admin-item').forEach(item => {
      const uid = item.dataset.id;
      const getSel = () => Array.from(item.querySelectorAll('.chip.on')).map(c => c.dataset.exec);
      item.querySelectorAll('.chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
      item.querySelector('.a-save').onclick = async () => {
        try {
          await api('/admin/users/' + uid, { method: 'POST', body: { name: item.querySelector('.a-name').value.trim(), wecomUserid: item.querySelector('.a-wxid').value.trim(), execIds: getSel() } });
          toast('已保存'); loadAdmin();
        } catch (e) { toast(e.message); }
      };
      item.querySelector('.a-pass').onclick = async () => {
        const p = prompt('输入新密码'); if (!p) return;
        try { await api('/admin/users/' + uid, { method: 'POST', body: { password: p } }); toast('密码已重置'); }
        catch (e) { toast(e.message); }
      };
      item.querySelector('.a-toggle').onclick = async () => {
        try { await api('/admin/users/' + uid, { method: 'POST', body: { status: item.querySelector('.a-toggle').textContent === '停用' ? 'disabled' : 'active' } }); loadAdmin(); }
        catch (e) { toast(e.message); }
      };
      item.querySelector('.a-role').onclick = async () => {
        const to = item.querySelector('.a-role').textContent === '改为秘书' ? 'sec' : 'admin';
        if (!confirm('确认改为' + (to === 'admin' ? '管理员' : '秘书') + '？')) return;
        try { await api('/admin/users/' + uid, { method: 'POST', body: { role: to } }); loadAdmin(); }
        catch (e) { toast(e.message); }
      };
      item.querySelector('.a-block').onclick = async () => {
        const toBlocked = item.querySelector('.a-block').textContent === '拉黑';
        if (toBlocked && !confirm('确定将「' + (u.name || u.username) + '」加入黑名单吗？拉黑后该账号将无法登录。')) return;
        try { await api('/admin/users/' + uid, { method: 'POST', body: { status: toBlocked ? 'blocked' : 'active' } }); toast(toBlocked ? '已拉黑' : '已解除拉黑'); loadAdmin(); }
        catch (e) { toast(e.message); }
      };
      item.querySelector('.a-remove').onclick = async () => {
        if (!confirm('确定移除账号「' + u.username + '」吗？\n移除后该账号立即失效、无法登录，其登记过的行程会保留。\n如只是暂时不想让人登录，建议用「停用」或「拉黑」。')) return;
        try { await api('/admin/users/' + uid + '/delete', { method: 'POST', body: {} }); toast('已移除'); loadAdmin(); }
        catch (e) { toast(e.message); }
      };
    });

    // 高管名单：可编辑姓名 / 称呼 / 电话
    const badgeEx = $('#badge-execs');
    if (badgeEx) { badgeEx.textContent = j.execs.length; badgeEx.classList.remove('zero'); }
    $('#admin-execs').innerHTML = j.execs.map(e => `
      <div class="admin-item" data-id="${e.id}">
        <div class="tools">
          <input class="e-name" type="text" value="${esc(e.name)}" placeholder="姓名">
          <input class="e-title" type="text" value="${esc(e.title || '')}" placeholder="称呼/职务">
          <input class="e-phone" type="text" value="${esc(e.phone || '')}" placeholder="电话">
          <button class="small e-save">保存</button>
          <button class="small e-toggle">${e.active ? '停用' : '启用'}</button>
        </div>
      </div>`).join('');
    $('#admin-execs').querySelectorAll('.admin-item').forEach(item => {
      const eid = item.dataset.id;
      item.querySelector('.e-save').onclick = async () => {
        try {
          await api('/admin/execs/' + eid, {
            method: 'POST',
            body: {
              name: item.querySelector('.e-name').value.trim(),
              title: item.querySelector('.e-title').value.trim(),
              phone: item.querySelector('.e-phone').value.trim()
            }
          });
          toast('已保存'); loadAdmin();
        } catch (err) { toast(err.message); }
      };
      item.querySelector('.e-toggle').onclick = async () => {
        try { await api('/admin/execs/' + eid, { method: 'POST', body: { active: item.querySelector('.e-toggle').textContent === '停用' ? false : true } }); loadAdmin(); }
        catch (err) { toast(err.message); }
      };
    });

    const s = await api('/admin/settings');
    $('#admin-settings').innerHTML = `
      <div class="admin-item">
        <label class="lbl">群机器人 webhook（可选，双保险推送）</label>
        <input id="s-hook" type="text" placeholder="${esc(s.settings.weworkHook || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...')}">
        <label class="lbl">截止提醒时间</label>
        <input id="s-deadline" type="time" value="${esc(s.settings.deadlineTime || '17:00')}">
        <label class="lbl">定时调用密钥（cron 用，留空自动生成）</label>
        <input id="s-cronkey" type="text" value="${esc(s.settings.cronKey || '')}">
        <button id="s-save" class="primary small">保存设置</button>
        <p class="muted" style="margin-top:8px">企微凭证状态：${s.wecomReady ? '✅ 已就绪' : '⚠️ 服务端未配置'}</p>
      </div>`;
    $('#s-save').onclick = async () => {
      const body = { deadlineTime: $('#s-deadline').value };
      const hook = $('#s-hook').value.trim();
      if (hook && !hook.startsWith('已配置')) body.weworkHook = hook;
      let ck = $('#s-cronkey').value.trim();
      if (!ck) { ck = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); $('#s-cronkey').value = ck; }
      body.cronKey = ck;
      try { await api('/admin/settings', { method: 'POST', body }); toast('设置已保存，定时地址见 README'); }
      catch (e) { toast(e.message); }
    };

    // 数据迁移：读两个 JSON → 一次性导入（幂等，重复导入自动跳过）
    $('#btn-import').onclick = async () => {
      const fExec = $('#import-exec').files[0];
      const fTrips = $('#import-trips').files[0];
      const out = $('#import-result');
      if (!fExec && !fTrips) return toast('请先选择要导入的 JSON 文件');
      const readJson = f => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error('读取文件失败'));
        r.onload = () => {
          const txt = r.result;
          try { const j = JSON.parse(txt); return resolve(j); }
          catch (e1) {
            // 云开发导出为 JSONL（每行一个对象）
            try {
              const lines = String(txt).split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
              if (!lines.length) throw new Error('空文件');
              return resolve(lines);
            } catch (e2) { reject(new Error(f.name + ' 不是有效的 JSON')); }
          }
        };
        r.readAsText(f, 'utf8');
      });
      try {
        out.textContent = '读取文件中…';
        const execs = fExec ? await readJson(fExec) : [];
        const trips = fTrips ? await readJson(fTrips) : [];
        const arrExecs = Array.isArray(execs) ? execs : (execs.data || []);
        const arrTrips = Array.isArray(trips) ? trips : (trips.data || []);
        out.textContent = `导入中（高管 ${arrExecs.length} 条、行程 ${arrTrips.length} 条）…`;
        const j = await api('/admin/import', { method: 'POST', body: { execs: arrExecs, trips: arrTrips } });
        out.textContent = `✅ 完成：新增高管 ${j.execAdded} 人、新增行程 ${j.tripAdded} 条、跳过重复 ${j.tripSkipped} 条（现有高管 ${j.execTotal}、行程 ${j.tripTotal}）`;
        toast('迁移完成');
        loadAdmin();
      } catch (e) { out.textContent = '❌ ' + e.message; }
    };
  } catch (e) { toast(e.message); }
}

$('#btn-add-exec').onclick = async () => {
  const name = $('#new-exec-name').value.trim();
  if (!name) return toast('请输入姓名');
  try { await api('/admin/execs', { method: 'POST', body: { name } }); $('#new-exec-name').value = ''; toast('已新增'); loadAdmin(); }
  catch (e) { toast(e.message); }
};

// 新增成员账号
$('#btn-add-user').onclick = async () => {
  const username = $('#new-user-name').value.trim();
  const password = $('#new-user-pass').value;
  const name = $('#new-user-real').value.trim();
  const role = $('#new-user-role').value;
  if (!username || password.length < 6) return toast('请填写账号，密码至少 6 位');
  try {
    await api('/admin/users', { method: 'POST', body: { username, password, name, role } });
    toast('成员账号已创建，把账号密码告诉对方即可登录');
    $('#new-user-name').value = ''; $('#new-user-pass').value = ''; $('#new-user-real').value = '';
    loadAdmin();
  } catch (e) { toast(e.message); }
};

// 批量添加高管：先检查重复 → 有重复时勾选是否替换 → 确认导入
$('#btn-batch-exec').onclick = async () => {
  const out = $('#batch-exec-result'), dupBox = $('#batch-exec-dup');
  const text = $('#batch-exec-text').value.trim();
  if (!text) return toast('请先粘贴或输入名单');
  const items = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const parts = l.split(/[,，、\t]+/).map(s => s.trim());
    return { name: parts[0] || '', title: parts[1] || '', phone: parts[2] || '' };
  }).filter(x => x.name);
  if (!items.length) return toast('没有解析到姓名，请检查格式：姓名，称呼，电话');
  out.textContent = `解析到 ${items.length} 条，检查重复中…`;
  try {
    const j = await api('/admin/execs/batch', { method: 'POST', body: { items } });
    if (j.needConfirm) {
      out.textContent = `已新增 ${j.added.length} 人；发现 ${j.duplicates.length} 位重复高管，请勾选是否用新信息替换：`;
      dupBox.innerHTML = j.duplicates.map(d => `
        <div class="mine-item dup-item">
          <label class="chk" style="margin:0;flex:none"><input type="checkbox" class="dup-replace" checked data-name="${esc(d.name)}"> 替换信息</label>
          <b>${esc(d.name)}</b>
          <span class="muted small">现有：${esc(d.existing.title || '无称呼')} / ${esc(d.existing.phone || '无电话')}</span>
          <span class="muted small">新导入：${esc(d.title || '无称呼')} / ${esc(d.phone || '无电话')}</span>
        </div>`).join('') + '<button id="btn-batch-confirm" class="primary small">确认导入</button>';
      const dupItems = items.filter(x => j.duplicates.some(d => d.name === x.name));
      $('#btn-batch-confirm').onclick = async () => {
        const replaceNames = Array.from(dupBox.querySelectorAll('.dup-replace:checked')).map(c => c.dataset.name);
        try {
          const j2 = await api('/admin/execs/batch', { method: 'POST', body: { items: dupItems, replaceNames } });
          out.textContent = `✅ 批量导入完成：新增 ${j.added.length} 人、替换信息 ${j2.replaced.length} 人、保留原有 ${dupItems.length - j2.replaced.length} 人`;
          dupBox.innerHTML = '';
          $('#batch-exec-text').value = '';
          toast('批量导入完成'); loadAdmin();
        } catch (err) { out.textContent = '❌ ' + err.message; }
      };
    } else {
      out.textContent = `✅ 批量导入完成：新增 ${j.added.length} 人${j.skipped.length ? '、跳过重复 ' + j.skipped.length + ' 人' : ''}`;
      $('#batch-exec-text').value = '';
      toast('批量导入完成'); loadAdmin();
    }
  } catch (e) { out.textContent = '❌ ' + e.message; }
};

// ---------- 启动 ----------
if (TOKEN && ME) {
  api('/trips?date=' + todayStr()).then(j => { EXEC_CACHE = j.execs || []; enterMain(); }).catch(() => {});
} else {
  show('login');
}
