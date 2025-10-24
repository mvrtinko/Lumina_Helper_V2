// src/db.js (ESM)
import sqlite3 from 'sqlite3';

export const db = new sqlite3.Database('./bot.db');

// ───────── Promisified helpers ─────────
export function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
export function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
export function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// ───────── One-time schema init (call from bot.js) ─────────
export async function ensureSchema() {
  await run(`PRAGMA journal_mode = WAL;`);
  await run(`PRAGMA foreign_keys = ON;`);

  await run(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    start_iso TEXT NOT NULL,
    end_iso   TEXT,
    tz TEXT NOT NULL,
    model TEXT,
    voice_channel_id TEXT,
    created_iso TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  TEXT NOT NULL,
    shift_id INTEGER NOT NULL,
    clockin_iso  TEXT,
    clockout_iso TEXT,
    FOREIGN KEY(shift_id) REFERENCES shifts(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS fines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    amount   REAL NOT NULL,
    reason   TEXT NOT NULL,
    issued_iso TEXT NOT NULL,
    shift_id INTEGER,
    model TEXT
  )`);

  // defaults (idempotent)
  await run(
    `INSERT OR IGNORE INTO settings(key,value) VALUES
     ('default_tz','Europe/Zagreb'),
     ('fine_eur','20'),
     ('schedule_message_id',''),
     ('schedule_channel_id',''),
     ('shift_logs_channel_id','')`
  );
}
