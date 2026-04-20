import sqlite3 from 'sqlite3';
import path from 'path';
import bcrypt from 'bcrypt';

const PROJECT_ROOT = __dirname.endsWith(`${path.sep}dist`) ? path.join(__dirname, '..') : __dirname;
const dbPath = path.join(PROJECT_ROOT, 'doomsgame.db');
const sqlite3Verbose = sqlite3.verbose();

type QueryParams = unknown[];

interface PromisifiedDatabase extends sqlite3.Database {
  getAsync<T = unknown>(query: string, params?: QueryParams): Promise<T | undefined>;
  allAsync<T = unknown>(query: string, params?: QueryParams): Promise<T[]>;
  runAsync(query: string, params?: QueryParams): Promise<sqlite3.RunResult>;
}

const db = new sqlite3Verbose.Database(dbPath) as PromisifiedDatabase;

 db.getAsync = function <T = unknown>(query: string, params: QueryParams = []) {
  return new Promise<T | undefined>((resolve, reject) => {
    this.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row as T | undefined);
    });
  });
};

 db.allAsync = function <T = unknown>(query: string, params: QueryParams = []) {
  return new Promise<T[]>((resolve, reject) => {
    this.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
};

 db.runAsync = function (query: string, params: QueryParams = []) {
  return new Promise<sqlite3.RunResult>((resolve, reject) => {
    this.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

// Initialize tables
 db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      embed_code TEXT,
      category TEXT,
      tags TEXT,
      is_published INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT,
      category TEXT,
      tags TEXT,
      is_published INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queryKey TEXT,
      responseContent TEXT,
      type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS editor_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      type TEXT,
      last_scraped DATETIME
    )
  `);

  db.run('ALTER TABLE games ADD COLUMN is_published INTEGER DEFAULT 0', () => {
    // Ignore error if column already exists
  });

  db.run('ALTER TABLE posts ADD COLUMN is_published INTEGER DEFAULT 1', () => {
    // Ignore error if column already exists
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT UNIQUE,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pending_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT,
      content_id INTEGER,
      user_message TEXT,
      ai_response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.get("SELECT * FROM settings WHERE key = 'autonomous_timer'", (_err, row) => {
    if (!row) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['autonomous_timer', '0 9 * * *']);
    }
  });

  db.get("SELECT * FROM settings WHERE key = 'auto_pilot_enabled'", (_err, row) => {
    if (!row) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['auto_pilot_enabled', '0']);
    }
  });

  db.run('ALTER TABLE posts ADD COLUMN quality_score INTEGER DEFAULT 0', () => {
    // ignore
  });
  db.run('ALTER TABLE games ADD COLUMN quality_score INTEGER DEFAULT 0', () => {
    // ignore
  });

  db.run('ALTER TABLE games ADD COLUMN category TEXT', () => {});
  db.run('ALTER TABLE games ADD COLUMN tags TEXT', () => {});
  db.run('ALTER TABLE posts ADD COLUMN category TEXT', () => {});
  db.run('ALTER TABLE posts ADD COLUMN tags TEXT', () => {});

  db.get('SELECT * FROM users WHERE username = ?', ['admin'], (_err, row) => {
    if (!row) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run('INSERT INTO users (username, password) VALUES (?, ?)', ['admin', hashedPassword]);
    }
  });
});

export default db;
