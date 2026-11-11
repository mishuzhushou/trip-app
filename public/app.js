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
$('#f-pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-login').click(); });

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
function todayStr() {
  const d = new Date(Date.now() + 8 * 3600000);  // 北京时间
  return d.toISOString().slice(0, 10);
}
$('#btn-refresh').onclick = loadBoard;
$('#board-date').onchange = loadBoard;

async function loadBoard() {
  const date = $('#board-date').value || todayStr();
  const box = $('#board-list');
  box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const j = await api('/trips?date=' + date);
    EXEC_CACHE = j.execs || [];
    if (!j.trips.length) { box.innerHTML = '<p class="empty">该日期暂无行程</p>'; return; }
    const execName = id => (j.execs.find(e => e.id === id) || {}).name || '?';
    box.innerHTML = j.trips.map(t => `
      <div class="trip-card" data-id="${t.id}">
        <div class="top"><span class="exec">${esc(execName(t.execId))}</span>
          <span class="tag ${t.status === 'active' ? 'tag-gray' : 'tag-orange'}">${t.status === 'active' ? '正常' : t.status === 'changed' ? '已改期' : '已取消'}</span></div>
        <div class="no">${esc(t.vehicle === 'flight' ? '航班 ' : t.vehicle === 'train' ? '车次 ' : '')}${esc(t.no || '—')}</div>
        <div class="route">${esc(t.depCity)} ${esc(t.depTime)} → ${esc(t.arrCity)} ${esc(t.arrTime)}</div>
        <div class="seat">${esc(t.seat || '')}</div>
        <div class="actions">
          ${t.needCar ? `<button class="small ${t.carBooked ? 'ghost' : 'primary'} act-car" data-v="${t.carBooked ? 0 : 1}">${t.carBooked ? '✓ 已约车（点击取消）' : '标记已约车'}</button>` : ''}
          <button class="small act-change">改期/取消</button>
        </div>
      </div>`).join('');
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
  } catch (e) { box.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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
    f.querySelector('.btn-save').onclick = async () => {
      try {
        await api('/trips', {
          method: 'POST',
          body: {
            execId: sel.value, date: f.querySelector('.f-date').value,
            vehicle: t.vehicle, no: f.querySelector('.f-no').value.trim(),
            depCity: f.querySelector('.f-dep').value.trim(), depTime: f.querySelector('.f-dept').value,
            arrCity: f.querySelector('.f-arr').value.trim(), arrTime: f.querySelector('.f-arrt').value,
            seat: f.querySelector('.f-seat').value.trim(), needCar: f.querySelector('.f-needcar').checked ? 1 : 0,
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
