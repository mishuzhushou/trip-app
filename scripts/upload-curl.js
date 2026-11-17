// 批量上传：把所有改动合并成「一次 commit」推到 GitHub，
// 避免逐个文件提交导致 Railway 在几秒内被连续触发多次部署、把中途打断的部署误判为崩溃。
// 用法: node scripts/upload-curl.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN || (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', '.deploy-token'), 'utf8').trim(); }
  catch { return ''; }
})();
const OWNER = 'mishuzhushou';
const REPO = 'trip-app';
const BRANCH = 'main';
const ROOT = path.join(__dirname, '..');
const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:62513';

const FILES = [
  'server.js', 'package.json', 'package-lock.json', 'README.md', '.gitignore', 'railway.toml',
  'src/db.js', 'src/wecom.js', 'src/parser.js', 'src/remind.js', 'src/ocr.js', 'src/util.js',
  'public/index.html', 'public/app.js', 'public/style.css', 'public/vendor/xlsx.full.min.js',
  'scripts/smoke2.js', 'scripts/upload-curl.js', 'scripts/test-local.js', 'scripts/test-admin.js', 'scripts/test-learn.js',
  '.github/workflows/remind.yml',
];

if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

function curlJson(args, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const out = execFileSync('curl', ['-sS', '--max-time', '40', '-x', PROXY, ...args], {
        encoding: 'utf8', maxBuffer: 30 * 1024 * 1024,
      });
      return out;
    } catch (e) {
      console.log(`  …curl 抖动(${i}/${tries})，重试`);
      if (i === tries) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * i);
    }
  }
}

function api(method, url, bodyObj) {
  const args = ['-X', method,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: trip-uploader',
  ];
  let tmp = null;
  if (bodyObj !== undefined) {
    tmp = path.join(ROOT, 'data', `__payload_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(bodyObj));
    args.push('-H', 'Content-Type: application/json', '--data', `@${tmp}`);
  }
  args.push(`https://api.github.com${url}`);
  try {
    const out = curlJson(args);
    try { return JSON.parse(out); } catch { throw new Error('响应非 JSON: ' + String(out).slice(0, 200)); }
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

(async () => {
  // 1) 本地比对，挑出真正有变化的文件
  const changes = [];
  for (const f of FILES) {
    const local = path.join(ROOT, f);
    if (!fs.existsSync(local)) { console.log(`跳过(本地缺失): ${f}`); continue; }
    const content = fs.readFileSync(local).toString('base64');
    const apiUrl = `/repos/${OWNER}/${REPO}/contents/${f.split('\\').join('/')}`;
    let remoteChanged = true;
    try {
      const head = api('GET', `${apiUrl}?ref=${BRANCH}`);
      if (head && head.sha) {
        const remote = String(head.content || '').replace(/\n/g, '');
        if (remote === content) remoteChanged = false;
      }
    } catch { /* 远端不存在，视为新增 */ }
    if (remoteChanged) changes.push({ f, content });
    else console.log(`跳过(相同): ${f}`);
  }

  if (!changes.length) { console.log('\n无改动，未触发部署。'); return; }

  // 2) 用 Git Data API 一次性提交所有变化
  const ref = api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  if (!ref || !ref.object || !ref.object.sha) throw new Error('无法获取分支 HEAD');
  const baseCommit = ref.object.sha;
  const baseCommitInfo = api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseCommit}`);
  const baseTree = baseCommitInfo.tree.sha;

  const tree = [];
  for (const { f, content } of changes) {
    const blob = api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding: 'base64' });
    if (!blob || !blob.sha) throw new Error(`创建 blob 失败: ${f}`);
    tree.push({ path: f.split('\\').join('/'), mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`已暂存: ${f}`);
  }

  const newTree = api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: baseTree, tree });
  if (!newTree || !newTree.sha) throw new Error('创建 tree 失败');

  const message = changes.length === 1
    ? `update ${changes[0].f}`
    : `update ${changes.length} files: ${changes.map(c => c.f).join(', ')}`;
  const newCommit = api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message, tree: newTree.sha, parents: [baseCommit],
  });
  if (!newCommit || !newCommit.sha) throw new Error('创建 commit 失败');

  api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: newCommit.sha, force: false });
  console.log(`\n完成：${changes.length} 个文件合并为一次提交，Railway 只会部署一次。`);
})().catch(e => { console.error('上传失败:', e.message); process.exit(1); });
