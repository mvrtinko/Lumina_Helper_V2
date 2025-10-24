import { DateTime } from 'luxon';
import { Settings } from '../settings.js';

export async function logShiftEvent(client, { type, userId, shift, whenISO, extra }) {
  const logsChannelId = await Settings.logsChannelId();
  if (!logsChannelId) return;
  try {
    const ch = await client.channels.fetch(logsChannelId);
    const tz = await Settings.defaultTZ();
    const when = DateTime.fromISO(whenISO).setZone(tz).toFormat('yyyy-LL-dd HH:mm');
    const lines = [
      type === 'in' ? '✅ **Clock IN**' : '❌ **Clock OUT**',
      `• Worker: <@${userId}>`,
      `• Model: ${shift?.model || 'Model'}`,
      `• Channel: <#${shift?.channel_id}>`,
      `• Time: ${when} (${tz})`,
    ];
    if (extra) lines.push(`• ${extra}`);
    await ch.send(lines.join('\n'));
  } catch (e) {
    console.error('logShiftEvent failed', e);
  }
}
