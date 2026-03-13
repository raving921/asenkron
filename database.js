const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kolektif.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      nick TEXT,
      profile_photo TEXT,
      role TEXT DEFAULT 'user',
      badge TEXT,
      telegram_chat_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '🐾',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category_id INTEGER,
      image_path TEXT,
      caption TEXT,
      song_url TEXT,
      is_birthday_post INTEGER DEFAULT 0,
      share_token TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      song_url TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deliver_at DATETIME NOT NULL,
      read_at DATETIME,
      status TEXT DEFAULT 'in_transit',
      notification_sent INTEGER DEFAULT 0,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (receiver_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS letter_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      letter_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reaction TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(letter_id, user_id),
      FOREIGN KEY (letter_id) REFERENCES letters(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      attempts INTEGER DEFAULT 0,
      locked_until DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS telegram_auth (
      chat_id TEXT PRIMARY KEY,
      user_id INTEGER,
      attempts INTEGER DEFAULT 0,
      locked_until DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Seed default site settings
  const settingsDefaults = [
    ['site_name', 'kolektif zihin yapısı'],
    ['site_subtitle', 'raving ❤ almila'],
    ['site_welcome', 'hoş geldin'],
    ['birthday_theme', '1'],
    ['theme', 'default'],
    ['site_url', 'http://localhost:3000'],
    ['delivery_min_hours', '2'],
    ['delivery_max_hours', '3'],
  ];

  const insertSetting = db.prepare(`INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of settingsDefaults) {
    insertSetting.run(key, value);
  }

  // Seed admin user (key: 1727)
  const adminExists = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get();
  if (!adminExists) {
    const adminHash = bcrypt.hashSync('1727', 10);
    db.prepare(`INSERT OR IGNORE INTO users (key_hash, username, nick, role, badge) VALUES (?, ?, ?, ?, ?)`)
      .run(adminHash, 'raving', 'raving', 'admin', 'allahın premium kulu');
  }

  // Seed Almila user (key: 7979)
  const almilaExists = db.prepare(`SELECT id FROM users WHERE username = 'almila'`).get();
  if (!almilaExists) {
    const almilaHash = bcrypt.hashSync('7979', '10');
    db.prepare(`INSERT OR IGNORE INTO users (key_hash, username, nick, role) VALUES (?, ?, ?, ?)`)
      .run(almilaHash, 'almila', 'almila', 'user');
  }

  console.log('✅ Veritabanı hazır.');
}

module.exports = { getDb, initDb };
