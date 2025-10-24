import { DateTime } from 'luxon';
import { all, get, run } from './db.js';
import { Settings } from './settings.js';

/**
 * We don’t create one cron per shift anymore. Instead, every 30s we:
 *  - find shifts in a 2h past → 24h future window
 *  - compute T-15, T+0, T+15 moments
 *  - check a small event log table (created on demand) to avoid duplicates
 *  - fire reminders/pings/fines exactly once even across restarts
 */

async function ensureEventTable() {
  await run(`CREATE TABLE IF NOT EXISTS shift_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    kind TEXT NOT NULL, -- 'remind','start','latefine'
    fired_iso TEXT NOT NULL,
    UNIQUE(shift_id, kind)
  )`);
}

async function eventFired(shiftId, kind) {
  const row = await get(`SELECT id FROM shift_events WHERE shift_id = ? AND kind = ?`, [shiftId, kind]);
  return !!row;
}
async function markFired(shiftId, kind) {
  await run(
    `INSERT OR IGNORE INTO shift_events (shift_id, kind, fired_iso) VALUES (?, ?, ?)`,
    [shiftId, kind, new Date().toISOString()]
  );
}

// NEW: quick attendance check used to suppress reminders if already clocked in
async function hasClockedIn(shiftId) {
  const a = await get(
    `SELECT clockin_iso FROM attendance WHERE shift_id = ? ORDER BY id DESC LIMIT 1`,
    [shiftId]
  );
  return !!(a && a.clockin_iso);
}

export function startScheduler(client) {
  ensureEventTable();

  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const now = DateTime.now();
      const from = now.minus({ hours: 2 }).toISO();
      const to   = now.plus({ hours: 24 }).toISO();

      const shifts = await all(
        `SELECT * FROM shifts WHERE start_iso BETWEEN ? AND ? ORDER BY start_iso ASC`,
        [from, to]
      );

      for (const s of shifts) {
        const tz = s.tz;
        const start = DateTime.fromISO(s.start_iso, { zone: tz });
        const remindAt = start.minus({ minutes: 15 });
        const startAt  = start;
        const lateAt   = start.plus({ minutes: 15 });

        // T-15 reminder (skip if already clocked in; still mark as fired)
        if (now >= remindAt && !(await eventFired(s.id, 'remind'))) {
          if (await hasClockedIn(s.id)) {
            await markFired(s.id, 'remind');
          } else {
            try {
              const ch = await client.channels.fetch(s.channel_id);
              await ch.send(
                `<@${s.user_id}> shift for **${s.model || 'your model'}** starts in 15 minutes. Please /clockin.`
              );
            } catch { /* ignore */ }
            await markFired(s.id, 'remind');
          }
        }

        // T+0 start ping (skip if already clocked in; still mark as fired)
        if (now >= startAt && !(await eventFired(s.id, 'start'))) {
          if (await hasClockedIn(s.id)) {
            await markFired(s.id, 'start');
          } else {
            try {
              const ch = await client.channels.fetch(s.channel_id);
              await ch.send(`⏰ <@${s.user_id}> your shift **${s.model || ''}** starts NOW. Please /clockin.`);
            } catch { /* ignore */ }
            await markFired(s.id, 'start');
          }
        }

        // T+15 late fine (only if still not clocked in)
        if (now >= lateAt && !(await eventFired(s.id, 'latefine'))) {
          const clocked = await hasClockedIn(s.id);
          if (!clocked) {
            const fine = await Settings.fineEUR();
            const reason = `Late for shift starting ${s.start_iso}`;
            const issued = DateTime.now().toISO();

            try {
              const user = await client.users.fetch(s.user_id);
              await user.send(`You've been fined €${fine} for not clocking in on time. (${reason})`);
            } catch {
              try {
                const ch = await client.channels.fetch(s.channel_id);
                await ch.send(`<@${s.user_id}> fined €${fine} for missing clock-in. (${reason})`);
              } catch {}
            }

            await run(
              `INSERT INTO fines (guild_id, user_id, amount, reason, issued_iso, shift_id, model)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [s.guild_id, s.user_id, fine, reason, issued, s.id, s.model || null]
            );
          }
          await markFired(s.id, 'latefine');
        }
      }
    } catch (e) {
      console.error('scheduler tick error', e);
    } finally {
      ticking = false;
    }
  }, 30_000);
}
