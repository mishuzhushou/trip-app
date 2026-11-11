// 企业微信对接：access_token 缓存（7200s）+ 应用消息推送 + 成员查询
// 凭证全部来自环境变量，绝不写入代码与数据文件：
//   WECOM_CORPID / WECOM_SECRET / WECOM_AGENTID
const DB = require('./db');

const CORPID = process.env.WECOM_CORPID || '';
const SECRET = process.env.WECOM_SECRET || '';
const AGENTID = process.env.WECOM_AGENTID || '';

let tokenCache = { token: '', expiresAt: 0 };

async function getToken(force = false) {
  if (!CORPID || !SECRET) throw new Error('未配置 WECOM_CORPID / WECOM_SECRET 环境变量');
  const now = Date.now();
  if (!force && tokenCache.token && tokenCache.expiresAt > now + 60000) return tokenCache.token;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(CORPID)}&corpsecret=${encodeURIComponent(SECRET)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.errcode !== 0) {
    const err = new Error(`gettoken 失败: [${j.errcode}] ${j.errmsg}`);
    err.errcode = j.errcode;
    throw err;
  }
  tokenCache = { token: j.access_token, expiresAt: now + (j.expires_in - 120) * 1000 };
  return tokenCache.token;
}

// 60020（可信IP）等固定错误一次性强制刷新重试，避免 token 失效误报
async function callApi(path, body, method = 'POST') {
  let token = await getToken();
  let j = await rawCall(path, token, body, method);
  if (j.errcode === 40014 || j.errcode === 42001) {  // token 失效
    token = await getToken(true);
    j = await rawCall(path, token, body, method);
  }
  return j;
}

async function rawCall(path, token, body, method) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (method === 'POST' && body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

// 定向推送文本卡片（消息脱敏由调用方控制文案）
async function sendTextCard(userIds, title, desc, url) {
  if (!AGENTID) throw new Error('未配置 WECOM_AGENTID 环境变量');
  const touser = Array.isArray(userIds) ? userIds.filter(Boolean).join('|') : String(userIds);
  if (!touser) return { errcode: -1, errmsg: '无推送目标' };
  return callApi('message/send', {
    touser,
    msgtype: 'textcard',
    agentid: Number(AGENTID),
    textcard: { title: String(title).slice(0, 60), description: String(desc).slice(0, 200), url: url || '' }
  });
}

// 按可见范围拉成员（尽量不用；管理员也可手工填 userid）
async function listVisibleUsers() {
  return callApi('user/simplelist?department_id=1&fetch_child=1', undefined, 'GET');
}

// 群机器人 webhook 推送（双保险通道，纯文本）
async function sendHookWebhook(key, text) {
  if (!key) return { ok: false, error: '未配置群机器人' };
  try {
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: String(text).slice(0, 1800) } })
    });
    const j = await r.json();
    return { ok: j.errcode === 0, errcode: j.errcode, errmsg: j.errmsg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { getToken, sendTextCard, listVisibleUsers, sendHookWebhook, hasCred: () => !!(CORPID && SECRET && AGENTID) };
