import { DateTime } from 'luxon';
import { get, run } from '../db.js';

export async function isChannelActive(channelId) {
  const row = await get(
    `SELECT 1
       FROM attendance a
       JOIN shifts s ON s.id = a.shift_id
      WHERE s.channel_id = ?
        AND a.clockin_iso IS NOT NULL
        AND a.clockout_iso IS NULL
      LIMIT 1`,
    [channelId]
  );
  return !!row;
}

export async function createAdHocShift({ guildId, userId, channelId, tz }) {
  const startISO = DateTime.now().setZone(tz).toISO();
  const r1 = await run(
    `INSERT INTO shifts (guild_id, user_id, channel_id, start_iso, end_iso, tz, model, voice_channel_id)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL)`,
    [guildId, userId, channelId, startISO, tz]
  );
  const shiftId = r1.lastID;
  await run(
    `INSERT INTO attendance (user_id, shift_id, clockin_iso) VALUES (?, ?, ?)`,
    [userId, shiftId, startISO]
  );
  return { id: shiftId, start_iso: startISO };
}
