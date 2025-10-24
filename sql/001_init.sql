PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  start_iso TEXT NOT NULL,
  end_iso TEXT,
  tz TEXT NOT NULL,
  model TEXT,
  voice_channel_id TEXT,
  created_iso TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  shift_id INTEGER NOT NULL,
  clockin_iso TEXT,
  clockout_iso TEXT,
  FOREIGN KEY(shift_id) REFERENCES shifts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  issued_iso TEXT NOT NULL,
  shift_id INTEGER,
  model TEXT
);

-- idempotent defaults
INSERT OR IGNORE INTO settings(key, value) VALUES
 ('default_tz', 'Europe/Zagreb'),
 ('fine_eur', '20'),
 ('schedule_message_id', ''),
 ('schedule_channel_id', ''),
 ('shift_logs_channel_id', '');
