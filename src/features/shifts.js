// src/features/shifts.js
import { all, get, run } from '../db.js';

/* ──────────────────────────────────────────────────────────────
   Internal: make sure shift_events exists + pre-mark helpers
   ────────────────────────────────────────────────────────────── */

async function ensureEventTable() {
  // Safe to call frequently; NOOP if table exists
  await run(`CREATE TABLE IF NOT EXISTS shift_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    kind TEXT NOT NULL,      -- 'remind' | 'start' | 'latefine'
    fired_iso TEXT NOT NULL,
    UNIQUE(shift_id, kind)
  )`);
}

async function preMarkRemindAndStart(shiftId, whenISO) {
  await ensureEventTable();
  // If scheduler hasn’t fired yet, these inserts will prevent future pings.
  await run(
    `INSERT OR IGNORE INTO shift_events (shift_id, kind, fired_iso) VALUES (?, 'remind', ?)`,
    [shiftId, whenISO]
  );
  await run(
    `INSERT OR IGNORE INTO shift_events (shift_id, kind, fired_iso) VALUES (?, 'start', ?)`,
    [shiftId, whenISO]
  );
}

/* ──────────────────────────────────────────────────────────────
   Public API (unchanged signatures)
   ────────────────────────────────────────────────────────────── */

export async function insertShift({ guildId, userId, channelId, startISO, endISO, tz, model, voiceChannelId }) {
  const r = await run(
    `INSERT INTO shifts (guild_id, user_id, channel_id, start_iso, end_iso, tz, model, voice_channel_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, userId, channelId, startISO, endISO, tz, model, voiceChannelId || null]
  );
  const id = r.lastID;
  await run(`INSERT INTO attendance (user_id, shift_id) VALUES (?, ?)`, [userId, id]);
  return id;
}

export async function removeShift(id) {
  const r = await run(`DELETE FROM shifts WHERE id = ?`, [id]);
  return r.changes;
}

export async function getUpcomingShifts(days = 7) {
  const nowISO = new Date().toISOString();
  const futureISO = new Date(Date.now() + days * 864e5).toISOString();
  return all(
    `SELECT * FROM shifts WHERE start_iso BETWEEN ? AND ? ORDER BY start_iso ASC`,
    [nowISO, futureISO]
  );
}

export async function getShiftsForBoard(days = 7) {
  const nowISO = new Date().toISOString();
  const futureISO = new Date(Date.now() + days * 864e5).toISOString();
  return all(
    `SELECT * FROM shifts
      WHERE start_iso BETWEEN ? AND ? AND model IS NOT NULL
      ORDER BY start_iso ASC`,
    [nowISO, futureISO]
  );
}

export async function getNearestShiftToday(userId, nowISO) {
  return get(
    `SELECT sh.id FROM shifts sh
     LEFT JOIN attendance a ON a.shift_id = sh.id
     WHERE sh.user_id = ? AND date(sh.start_iso) = date(?)
     ORDER BY ABS(strftime('%s', sh.start_iso) - strftime('%s', ?)) ASC LIMIT 1`,
    [userId, nowISO, nowISO]
  );
}

export async function getShiftById(id) {
  return get(`SELECT * FROM shifts WHERE id = ?`, [id]);
}

export async function markClockIn(shiftId, whenISO) {
  await run(`UPDATE attendance SET clockin_iso = ? WHERE shift_id = ?`, [whenISO, shiftId]);
  // NEW: pre-mark reminders so the scheduler won’t ping after clock-in
  await preMarkRemindAndStart(shiftId, whenISO);
}

export async function markClockOut(shiftId, whenISO) {
  await run(`UPDATE attendance SET clockout_iso = ? WHERE shift_id = ?`, [whenISO, shiftId]);
}

export async function getAttendanceState(shiftId) {
  return get(
    `SELECT clockin_iso, clockout_iso
       FROM attendance
      WHERE shift_id = ?
   ORDER BY id DESC
      LIMIT 1`,
    [shiftId]
  );
}
