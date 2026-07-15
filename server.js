// ================================================================
// GAJAH MAS 2026 - Backend Server
// Node.js + Express + SQLite (better-sqlite3)
// Portable: bisa dijalankan di Replit, Railway, Render, VPS, atau
// laptop sendiri. Semua data disimpan di file data.sqlite di folder
// yang sama, dan tersedia untuk semua perangkat yang login.
// ================================================================
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'data.sqlite');
const SESSION_SECRET_PATH = path.join(DATA_DIR, '.session-secret');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
`);

// Tabel data, satu per "store" yang dulunya ada di Dexie/IndexedDB.
// Disimpan sebagai baris + kolom payload (JSON), supaya fleksibel
// mengikuti struktur data yang sudah ada di aplikasi tanpa perlu
// migrasi skema setiap kali ada field baru.
const TABLES = ['sales', 'cashIncome', 'printHistory', 'trash', 'piutangNotes', 'cashNotes', 'cetakTagihanMap'];
for (const t of TABLES) {
  db.exec(`CREATE TABLE IF NOT EXISTS "${t}" (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)`);
}

// Secret session dibuat sekali dan disimpan ke file, supaya login
// tidak ke-logout terus tiap kali server di-restart.
let sessionSecret;
if (fs.existsSync(SESSION_SECRET_PATH)) {
  sessionSecret = fs.readFileSync(SESSION_SECRET_PATH, 'utf8');
} else {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SESSION_SECRET_PATH, sessionSecret);
}

const app = express();
app.set('trust proxy', 1); // penting kalau dijalankan di belakang proxy/HTTPS (Replit, Railway, dll)
app.use(express.json({ limit: '50mb' }));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.FORCE_SECURE_COOKIE !== 'false',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 hari
  }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ---------------- AUTH ROUTES ----------------

app.get('/api/auth/status', (req, res) => {
  const hasUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
  res.json({
    loggedIn: !!(req.session && req.session.userId),
    setupNeeded: !hasUsers
  });
});

// Hanya bisa dipakai SEKALI, untuk membuat akun admin pertama.
app.post('/api/auth/register', (req, res) => {
  const hasUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
  if (hasUsers) return res.status(403).json({ error: 'Setup sudah pernah dilakukan. Gunakan login biasa.' });
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username & password (min 6 karakter) wajib diisi.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, passwordHash, createdAt) VALUES (?, ?, ?)')
    .run(username, hash, new Date().toISOString());
  req.session.userId = info.lastInsertRowid;
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Username atau password salah.' });
  }
  req.session.userId = user.id;
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Tambah user baru (dipakai admin untuk menambah anggota tim lain).
app.post('/api/auth/adduser', requireAuth, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username & password (min 6 karakter) wajib diisi.' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, passwordHash, createdAt) VALUES (?, ?, ?)')
      .run(username, hash, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Username sudah dipakai.' });
  }
});

// ---------------- DATA ROUTES (generik untuk semua tabel) ----------------

function rowOut(row) {
  const data = JSON.parse(row.payload);
  return Object.assign({ id: row.id }, data);
}

for (const t of TABLES) {
  app.get(`/api/${t}`, requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    res.json(rows.map(rowOut));
  });

  app.get(`/api/${t}/count`, requireAuth, (req, res) => {
    const c = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    res.json({ count: c });
  });

  app.get(`/api/${t}/query`, requireAuth, (req, res) => {
    const { field, value } = req.query;
    if (!field) return res.status(400).json({ error: 'field wajib diisi' });
    const rows = db.prepare(`SELECT * FROM "${t}"`).all().map(rowOut);
    const filtered = rows.filter(r => String(r[field]) === String(value));
    res.json(filtered);
  });

  app.post(`/api/${t}`, requireAuth, (req, res) => {
    const info = db.prepare(`INSERT INTO "${t}" (payload) VALUES (?)`).run(JSON.stringify(req.body || {}));
    res.json({ id: info.lastInsertRowid });
  });

  app.post(`/api/${t}/bulk`, requireAuth, (req, res) => {
    const arr = Array.isArray(req.body) ? req.body : [];
    const insert = db.prepare(`INSERT INTO "${t}" (payload) VALUES (?)`);
    const tx = db.transaction((items) => {
      for (const item of items) insert.run(JSON.stringify(item));
    });
    tx(arr);
    res.json({ ok: true, count: arr.length });
  });

  app.put(`/api/${t}/:id`, requireAuth, (req, res) => {
    const row = db.prepare(`SELECT * FROM "${t}" WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Data tidak ditemukan' });
    const merged = Object.assign(JSON.parse(row.payload), req.body || {});
    db.prepare(`UPDATE "${t}" SET payload = ? WHERE id = ?`).run(JSON.stringify(merged), req.params.id);
    res.json({ ok: true });
  });

  app.delete(`/api/${t}/:id`, requireAuth, (req, res) => {
    db.prepare(`DELETE FROM "${t}" WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  app.delete(`/api/${t}`, requireAuth, (req, res) => {
    db.prepare(`DELETE FROM "${t}"`).run();
    res.json({ ok: true });
  });
}

// ---------------- STATIC FILES + SPA FALLBACK ----------------

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('================================================');
  console.log('  GAJAH MAS 2026 server berjalan di port ' + PORT);
  console.log('  Data disimpan di: ' + DB_PATH);
  console.log('================================================');
});
