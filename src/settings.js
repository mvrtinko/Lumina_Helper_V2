import { get, run } from './db.js';

export async function getSetting(key, fallback = '') {
  const row = await get(`SELECT value FROM settings WHERE key = ?`, [key]);
  return row?.value ?? fallback;
}
export async function setSetting(key, value) {
  await run(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

export const Settings = {
  defaultTZ: () => getSetting('default_tz', 'Europe/Zagreb'),
  fineEUR: () => getSetting('fine_eur', '20').then(Number),
  scheduleMessageId: () => getSetting('schedule_message_id', ''),
  scheduleChannelId: () => getSetting('schedule_channel_id', ''),
  logsChannelId: () => getSetting('shift_logs_channel_id', ''),
  setScheduleMessageId: (v) => setSetting('schedule_message_id', v),
  setScheduleChannelId: (v) => setSetting('schedule_channel_id', v),
  setLogsChannelId: (v) => setSetting('shift_logs_channel_id', v),
};
