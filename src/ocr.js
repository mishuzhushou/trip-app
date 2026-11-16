// 腾讯云 OCR（通用印刷体识别 GeneralBasicOCR）——纯 HTTP + 自签 TC3-HMAC-SHA256，无 SDK 依赖
// 环境变量：TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_OCR_REGION(默认 ap-guangzhou)
// 免费额度：通用印刷体识别每月 1000 次（以腾讯云控制台实际为准）
const crypto = require('crypto');

const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const VERSION = '2018-11-19';
const ACTION = 'GeneralBasicOCR';

const SECRET_ID = () => process.env.TENCENT_SECRET_ID || '';
const SECRET_KEY = () => process.env.TENCENT_SECRET_KEY || '';
const REGION = () => process.env.TENCENT_OCR_REGION || 'ap-guangzhou';

function hasCred() { return !!(SECRET_ID() && SECRET_KEY()); }

function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(key, s) { return crypto.createHmac('sha256', key).update(s, 'utf8').digest(); }

// 把 OCR 碎片按坐标还原成屏幕上的视觉行：同一行内按 x 排序拼接。
// 与小程序 ocrService/rowsFromItems 完全一致——多栏订单截图若不还原，行序错乱会让解析把同一组时间套到多段行程。
function rowsFromDetections(dets) {
  const arr = (dets || []).map(d => {
    if (!d || !d.DetectedText) return null;
    let x = 0, y = 0, h = 20;
    const ip = d.ItemPolygon;
    if (ip && typeof ip.X === 'number') {
      x = ip.X; y = ip.Y; h = ip.Height || 20;
    } else if (Array.isArray(d.Polygon) && d.Polygon.length >= 4) {
      const xs = d.Polygon.map(p => p.X || 0), ys = d.Polygon.map(p => p.Y || 0);
      x = Math.min.apply(null, xs); y = Math.min.apply(null, ys);
      h = Math.max.apply(null, ys) - y || 20;
    } else return null;
    return { text: String(d.DetectedText), x, y, h };
  }).filter(Boolean);
  if (!arr.length) return null;
  arr.sort((a, b) => a.y - b.y || a.x - b.x);
  const hs = arr.map(a => a.h).filter(n => n > 0).sort((a, b) => a - b);
  const tol = Math.max(10, (hs[Math.floor(hs.length / 2)] || 20) * 0.7);
  const rows = [];
  let cur = [], curY = null;
  for (const it of arr) {
    if (curY === null || Math.abs(it.y - curY) <= tol) {
      cur.push(it);
      curY = curY === null ? it.y : (curY * (cur.length - 1) + it.y) / cur.length;
    } else {
      rows.push(cur); cur = [it]; curY = it.y;
    }
  }
  if (cur.length) rows.push(cur);
  return rows.map(r => r.sort((a, b) => a.x - b.x).map(i => i.text).join(' ').trim()).filter(Boolean);
}

async function recognize(imageBase64) {
  if (!hasCred()) {
    const e = new Error('未配置 OCR 凭证（TENCENT_SECRET_ID / TENCENT_SECRET_KEY），请在部署环境变量中添加');
    e.code = 'OCR_NOT_CONFIGURED';
    throw e;
  }
  const payload = JSON.stringify({ ImageBase64: imageBase64 });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const canonicalRequest = [
    'POST', '/', '',
    'content-type:application/json; charset=utf-8\nhost:' + HOST + '\n',
    'content-type;host',
    sha256hex(payload)
  ].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac('TC3' + SECRET_KEY(), date);
  const kService = hmac(kDate, SERVICE);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `TC3-HMAC-SHA256 Credential=${SECRET_ID()}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;

  const res = await fetch(`https://${HOST}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Host': HOST,
      'X-TC-Action': ACTION,
      'X-TC-Version': VERSION,
      'X-TC-Region': REGION(),
      'X-TC-Timestamp': String(timestamp),
      'Authorization': authorization
    },
    body: payload
  });
  const j = await res.json();
  const r = j.Response || {};
  if (r.Error) {
    const e = new Error(`OCR 失败: [${r.Error.Code}] ${r.Error.Message}`);
    e.code = r.Error.Code;
    throw e;
  }
  const dets = r.TextDetections || [];
  const fallback = dets.map(x => x && x.DetectedText).filter(Boolean);
  const rows = rowsFromDetections(dets);
  const text = (rows && rows.length ? rows : fallback).join('\n');
  return { text, count: (rows && rows.length ? rows : fallback).length, requestId: r.RequestId };
}

module.exports = { recognize, hasCred, rowsFromDetections };
