// 用 curl 做 HTTP（curl 在本机网络下稳定），Node 只负责组装 JSON
// 用法: GH_TOKEN=xxx node scripts/upload-curl.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN || (() => {
  try { return require('fs').readFileSync(require('path').join(__dirname, '..', '.deploy-token'), 'utf8').trim(); }
  catch { return ''; }
})();
const OWNER = 'mishuzhushou';
const REPO = 'trip-app';
const BRANCH = 'main';
const ROOT = path.join(__dirname, '..');
const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:62513';

const FILES = [
  'server.js', 'package.json', 'package-lock.json', 'README.md', '.gitignore',
  'src/db.js', 'src/wecom.js', 'src/parser.js', 'src/remind.js', 'src/ocr.js',
  'public/index.html', 'public/app.js', 'public/style.css',
  'scripts/smoke2.js', 'scripts/upload-curl.js',
];

if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

function curlJson(args, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const out = execFileSync('curl', ['-sS', '--max-time', '40', '-x', PROXY, ...args], {
        encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      });
      return out;
    } catch (e) {
      console.log(`  …curl 抖动(${i}/${tries})，重试`);
      if (i === tries) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * i);
    }
  }
}

function api(method, url, bodyFile) {
  const args = ['-X', method,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: trip-uploader',
  ];
  if (bodyFile) args.push('-H', 'Content-Type: application/json', '--data', `@${bodyFile}`);
  args.push(`https://api.github.com${url}`);
  const out = curlJson(args);
  try { return JSON.parse(out); } catch { throw new Error('响应非 JSON: ' + String(out).slice(0, 200)); }
}

let ok = 0, skip = 0, fail = 0;
for (const f of FILES) {
  const local = path.join(ROOT, f);
  const apiUrl = `/repos/${OWNER}/${REPO}/contents/${f.split('\\').join('/')}`;
  const content = fs.readFileSync(local).toString('base64');

  // 查远端是否已有同内容文件
  let sha;
  try {
    const head = api('GET', `${apiUrl}?ref=${BRANCH}`);
    if (head && head.sha) {
      if (head.content && head.content.replace(/\n/g, '') === content) {
        console.log(`跳过(相同): ${f}`); skip++; continue;
      }
      sha = head.sha;
    }
  } catch { /* 文件不存在，正常 */ }

  const payload = {
    message: sha ? `update ${f}` : `add ${f}`,
    content, branch: BRANCH,
  };
  if (sha) payload.sha = sha;

  const tmp = path.join(ROOT, 'data', `__payload_${Date.now()}.json`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(payload));
  try {
    const res = api('PUT', apiUrl, tmp);
    if (res && res.content && res.content.sha) { console.log(`OK: ${f}`); ok++; }
    else { console.log(`FAIL: ${f} -> ${JSON.stringify(res).slice(0, 200)}`); fail++; }
  } catch (e) {
    console.log(`FAIL: ${f} -> ${e.message}`); fail++;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
console.log(`\n完成: 成功 ${ok} / 跳过 ${skip} / 失败 ${fail}`);
