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
  const lines = (r.TextDetections || []).map(x => x.DetectedText).filter(Boolean);
  return { text: lines.join('\n'), count: lines.length, requestId: r.RequestId };
}

module.exports = { recognize, hasCred };
