// 数据层：JSON 文件存储（零原生依赖，部署简单；数据量小——秘书团队规模，完全够用）
// 文件：data/db.json，原子写入（tmp + rename），进程内串行写避免并发损坏
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = {
  users: [],        // {id, username, passHash, salt, role:'admin'|'sec', name, wecomUserid, status:'active'|'disabled', execIds:[], createdAt}
  execs: [],        // {id, name, title, active:true, createdAt}
  trips: [],        // {id, execId, date:'YYYY-MM-DD', vehicle:'train'|'flight'|'other', no, depCity, depTime, arrCity, arrTime, seat, needCar:1, carBooked:0, status:'active'|'changed'|'cancelled', remark, rawText, createdBy, createdAt, updatedAt}
  sessions: {},     // token -> {userId, createdAt}
  remindLogs: [],   // {id:'day|mode|userId', day, mode, userId, result, at}
  settings: { cronKey: '', weworkHook: '', deadlineTime: '17:00', morningTime: '08:00' },
  seq: 1000,
};

let db = null;
let writeTimer = null;

function load() {
  if (db) return db;
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = Object.assign({}, EMPTY, JSON.parse(raw));
  } catch (e) {
    db = JSON.parse(JSON.stringify(EMPTY));
  }
  return db;
}

function save() {
  // 防抖 200ms 合并写；进程退出前 flush
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, 200);
}

function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[db] save failed:', e.message);
  }
}

process.on('exit', () => { if (db && writeTimer) flush(); });

function nextId(prefix) {
  const d = load();
  d.seq += 1;
  return prefix + d.seq;
}

module.exports = { load, save, flush, nextId, DB_FILE };
