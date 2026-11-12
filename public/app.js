// 行程助手 H5 前端（原生 JS，无构建依赖）
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let TOKEN = localStorage.getItem('token') || '';
let ME = JSON.parse(localStorage.getItem('me') || 'null');
let EXEC_CACHE = [];

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

// ---------- 首次使用：注册管理员 ----------
function setRegMode(on) {
  $('#f-name').classList.toggle('hidden', !on);
  $('#btn-login').classList.toggle('hidden', on);
  $('#btn-register').classList.toggle('hidden', !on);
  $('#reg-tip').textContent = on ? '注册的第一个账号自动成为管理员' : '';
  $('#link-toggle-reg').textContent = on ? '已有账号？去登录' : '首次使用？注册管理员账号';
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
// 打开页面时探测系统是否已初始化，未初始化则直接显示注册
(async () => {
  try {
    const h = await fetch('/api/health').then(r => r.json());
    if (!h.initialized) setRegMode(true);
  } catch (e) { /* 忽略，默认显示登录 */ }
})();

function enterMain() {
  $('#hdr-user').textContent = (ME.name || ME.username) + (ME.role === 'admin' ? ' · 管理员' : ' · 秘书');
  $('#tab-admin').classList.toggle('hidden', ME.role !== 'admin');
  show('main');
  switchTab('board');
  $('#board-date').value = todayStr();
  loadBoard();
  if (ME.role === 'admin') loadAdmin();
}

// ---------- 看板 ----------
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const BOARD = { mode: 'day', execId: '', onlyCar: false, nearOpen: true };

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
    const filtered = list.filter(t => !BOARD.onlyCar || t.needCar);

    const todayTrips = list.filter(t => t.date === today && active(t)).sort((a, b) => tripKey(a).localeCompare(tripKey(b)));
    const tomorrowTrips = list.filter(t => t.date === tomorrow && active(t)).sort((a, b) => tripKey(a).localeCompare(tripKey(b)));
    const tomorrowCar = tomorrowTrips.filter(t => t.needCar);

    // 1) 明日需约车卡片
    $('#board-tomorrowcar').innerHTML = tomorrowCar.length ? `
      <div class="card-tool warn-card">
        <div class="row" style="margin-bottom:4px"><b style="color:#c05621">⚠️ 明日需约车（${tomorrowCar.length}）</b></div>
        ${tomorrowCar.map(t => `<div class="small muted car-line"><span class="tag ${t.carBooked ? 'tag-green' : 'tag-red'}">${t.carBooked ? '已约车' : '未约车'}</span>
          ${esc(execNameOf(t))} · ${t.date}${weekdayOf(t.date)} · ${esc(t.carType || '')} · ${esc(t.pickupTime || '')} ${esc(t.pickupAddr || '')}→${esc(t.dropoffAddr || '')}
          ${t.carInfo ? ' · ' + esc(t.carInfo) : ''}</div>`).join('')}
      </div>` : '';

    // 2) 今明两天行程（可折叠）
    const un = tomorrowTrips.filter(t => t.needCar && !t.carBooked).length;
    let nearSummary = `今天 ${todayTrips.length} 条 · 明天 ${tomorrowTrips.length} 条`;
    if (un) nearSummary += ` · 未约车 ${un}`;
    const nearBlock = t => `
      <div class="day-block">
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
          <button class="small act-change">改期/取消</button>
          <button class="small act-del">删除</button>
        </div>
      </div>`).join('');
    BOARD.cache = {};   // 卡片点击进入详情
    cards.forEach(t => { BOARD.cache[t.id] = t; });
    box.querySelectorAll('.trip-card').forEach(card => {
      card.onclick = e => { if (e.target.closest('button')) return; openDetail(card.dataset.id); };
    });
    box.querySelectorAll('.act-car').forEach(b => b.onclick = async e => {
      const id = e.target.closest('.trip-card').dataset.id;
      try { await api('/trips/' + id, { method: 'POST', body: { carBooked: Number(e.target.dataset.v) } }); toast('已更新'); loadBoard(); }
      catch (err) { toast(err.message); }
    });
    box.querySelectorAll('.act-change').forEach(b => b.onclick = async e => {
      const id = e.target.closest('.trip-card').dataset.id;
      const st = prompt('输入新状态：active=正常 / changed=已改期 / cancelled=取消');
      if (!st) return;
      try { await api('/trips/' + id, { method: 'POST', body: { status: st } }); toast('已更新'); loadBoard(); }
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
function setSt(v) { $tm('#tm-status').querySelectorAll('.st').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
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

// 话术生成（对齐小程序 genSpeech 的用途）
function buildSpeech(kind) {
  const exec = execNameOf(TM);
  const date = $tm('#tm-date').value;
  const segs = collectSegs();
  const lines = [];
  if (kind === 'car') {
    const carType = $tm('#tm-cartype').value || '用车';
    lines.push(`【约车信息】${exec} ${date} ${weekdayOf(date)}`);
    lines.push(`车型：${carType}`);
    segs.forEach((s, i) => {
      const no = s.flightNo || s.trainNo || '';
      lines.push(`行程段${segs.length > 1 ? i + 1 : ''}：${no ? no + ' ' : ''}${(s.depCity || '') + (s.depStation || '')} ${s.depTime || ''} → ${(s.arrCity || '') + (s.arrStation || '')} ${s.arrTime || ''}`);
    });
    lines.push(`上车：${$tm('#tm-pickupt').value || ''} ${$tm('#tm-pickupa').value || ''}`);
    lines.push(`下车：${$tm('#tm-dropoffa').value || ''}`);
    if ($tm('#tm-carinfo').value.trim()) lines.push(`车辆/司机：${$tm('#tm-carinfo').value.trim()}`);
  } else {
    lines.push(`【行程汇报】${exec}`);
    segs.forEach((s, i) => {
      const no = s.flightNo || s.trainNo || '';
      lines.push(`${segs.length > 1 ? i + 1 + '. ' : ''}${date} ${weekdayOf(date)} ${no ? no + ' ' : ''}${(s.depCity || '') + (s.depStation || '')} ${s.depTime || ''} → ${(s.arrCity || '') + (s.arrStation || '')} ${s.arrTime || ''}${s.seat ? '（' + s.seat + '）' : ''}`);
    });
  }
  return lines.join('\n');
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

// ---------- 登记行程 ----------
$('nav').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  switchTab(b.dataset.tab);
  if (b.dataset.tab === 'board') loadBoard();
  if (b.dataset.tab === 'admin' && ME.role === 'admin') loadAdmin();
});

$('#btn-parse').onclick = async () => {
  const text = $('#raw-text').value.trim();
  if (!text) return toast('请先粘贴行程文本');
  try {
    const j = await api('/parse', { method: 'POST', body: { text } });
    if (!j.trips.length) return toast('未能解析出行程，请检查文本或手动填写');
    renderParsed(j.trips);
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
    if (!j.trips || !j.trips.length) {
      hint.textContent = '已识别文字，但未解析出结构，请核对下方文本后手动修正';
      return;
    }
    hint.textContent = `识别成功：${j.lines} 行文字，解析出 ${j.trips.length} 条行程`;
    renderParsed(j.trips);
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

// 渲染解析结果（文本解析与 OCR 共用）
function renderParsed(trips) {
  const tpl = $('#tpl-trip-form');
  const box = $('#parsed-list');
  box.innerHTML = '<p class="muted">解析出 ' + trips.length + ' 条，核对后逐条保存：</p>';
  trips.forEach(t => {
    const node = tpl.content.cloneNode(true);
    const f = node.querySelector('.trip-form');
    const sel = f.querySelector('.f-exec');
    sel.innerHTML = EXEC_CACHE.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('') || '<option value="">（请先在管理页添加高管）</option>';
    f.querySelector('.f-date').value = t.date;
    f.querySelector('.f-no').value = t.no;
    f.querySelector('.f-dep').value = t.depCity;
    f.querySelector('.f-dept').value = t.depTime;
    f.querySelector('.f-arr').value = t.arrCity;
    f.querySelector('.f-arrt').value = t.arrTime;
    f.querySelector('.f-seat').value = t.seat;
    const needcar = f.querySelector('.f-needcar');
    const carExtra = f.querySelector('.car-extra');
    const syncCar = () => { carExtra.classList.toggle('hidden', !needcar.checked); };
    needcar.onchange = syncCar; syncCar();
    f.querySelector('.btn-save').onclick = async () => {
      try {
        await api('/trips', {
          method: 'POST',
          body: {
            execId: sel.value, date: f.querySelector('.f-date').value,
            vehicle: t.vehicle, no: f.querySelector('.f-no').value.trim(),
            depCity: f.querySelector('.f-dep').value.trim(), depTime: f.querySelector('.f-dept').value,
            arrCity: f.querySelector('.f-arr').value.trim(), arrTime: f.querySelector('.f-arrt').value,
            seat: f.querySelector('.f-seat').value.trim(), needCar: needcar.checked ? 1 : 0,
            carType: needcar.checked ? f.querySelector('.f-cartype').value : '',
            pickupTime: needcar.checked ? f.querySelector('.f-pickupt').value : '',
            pickupAddr: needcar.checked ? f.querySelector('.f-pickupa').value.trim() : '',
            dropoffAddr: needcar.checked ? f.querySelector('.f-dropoffa').value.trim() : '',
            carInfo: needcar.checked ? f.querySelector('.f-carinfo').value.trim() : '',
            rawText: t.raw
          }
        });
        f.remove(); toast('已保存');
      } catch (err) { toast(err.message); }
    };
    box.appendChild(node);
  });
}

// ---------- 管理 ----------
async function loadAdmin() {
  try {
    const j = await api('/admin/users');
    const execName = id => (j.execs.find(e => e.id === id) || {}).name || '';
    $('#admin-users').innerHTML = j.users.map(u => `
      <div class="admin-item" data-id="${u.id}">
        <div class="line"><b>${esc(u.name || u.username)}</b>
          <span class="tag ${u.role === 'admin' ? 'tag-red' : 'tag-gray'}">${u.role === 'admin' ? '管理员' : '秘书'}</span>
          ${u.status !== 'active' ? '<span class="tag tag-orange">停用</span>' : ''}
          <span class="muted">企微ID：${esc(u.wecomUserid || '未填')}</span></div>
        <div class="tools">
          <input class="a-name" type="text" value="${esc(u.name)}" placeholder="姓名">
          <input class="a-wxid" type="text" value="${esc(u.wecomUserid || '')}" placeholder="企微userid(用于定向提醒)">
          <button class="small a-save">保存资料</button>
          <button class="small a-pass">重置密码</button>
          <button class="small a-toggle">${u.status === 'active' ? '停用' : '启用'}</button>
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
    });

    $('#admin-execs').innerHTML = j.execs.map(e => `
      <div class="admin-item"><div class="line"><b>${esc(e.name)}</b><span class="muted">${esc(e.title || '')}</span>
        <span class="tools"><button class="small e-toggle" data-id="${e.id}">${e.active ? '停用' : '启用'}</button></span></div></div>`).join('');
    $('#admin-execs').querySelectorAll('.e-toggle').forEach(b => b.onclick = async () => {
      try { await api('/admin/execs/' + b.dataset.id, { method: 'POST', body: { active: b.textContent === '停用' ? false : true } }); loadAdmin(); }
      catch (e2) { toast(e2.message); }
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

// ---------- 启动 ----------
if (TOKEN && ME) {
  api('/trips?date=' + todayStr()).then(j => { EXEC_CACHE = j.execs || []; enterMain(); }).catch(() => {});
} else {
  show('login');
}
