// src/bot.js
import 'dotenv/config';
import pino from 'pino';
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
  StringSelectMenuBuilder
} from 'discord.js';
import { DateTime } from 'luxon';

// DB + schema (single source of truth)
import { db, get, all, run, ensureSchema } from './db.js';

// ───────── Simple Settings wrapper ─────────
async function getSetting(key, fallback = '') {
  const row = await get(`SELECT value FROM settings WHERE key = ?`, [key]);
  return row?.value ?? fallback;
}
async function setSetting(key, value) {
  await run(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}
const Settings = {
  defaultTZ: () => getSetting('default_tz', 'Europe/Zagreb'),
  fineEUR: () => getSetting('fine_eur', '20').then(Number),
  scheduleMessageId: () => getSetting('schedule_message_id', ''),
  scheduleChannelId: () => getSetting('schedule_channel_id', ''),
  logsChannelId: () => getSetting('shift_logs_channel_id', ''),
  setScheduleMessageId: (v) => setSetting('schedule_message_id', v),
  setScheduleChannelId: (v) => setSetting('schedule_channel_id', v),
  setLogsChannelId: (v) => setSetting('shift_logs_channel_id', v),
  setDefaultTZ: (v) => setSetting('default_tz', v),
  setFineEUR: (v) => setSetting('fine_eur', String(v)),
};

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DEFAULT_TZ = 'Europe/Zagreb';
const schedulerSessions = new Map();
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID');
  process.exit(1);
}

// ───────── Ensure schema BEFORE anything touches the DB ─────────
await ensureSchema();

// ───────── Client ─────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

// ───────── Helpers: shifts, voice, logs ─────────
async function insertShift({ guildId, userId, channelId, startISO, endISO, tz, model, voiceChannelId }) {
  const r = await run(
    `INSERT INTO shifts (guild_id, user_id, channel_id, start_iso, end_iso, tz, model, voice_channel_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, userId, channelId, startISO, endISO, tz, model, voiceChannelId || null]
  );
  const id = r.lastID;
  await run(`INSERT INTO attendance (user_id, shift_id) VALUES (?, ?)`, [userId, id]);
  return id;
}
async function removeShift(id) {
  const r = await run(`DELETE FROM shifts WHERE id = ?`, [id]);
  return r.changes;
}
async function getNearestShiftToday(userId, nowISO) {
  return get(
    `SELECT sh.id FROM shifts sh
     LEFT JOIN attendance a ON a.shift_id = sh.id
     WHERE sh.user_id = ? AND date(sh.start_iso) = date(?)
     ORDER BY ABS(strftime('%s', sh.start_iso) - strftime('%s', ?)) ASC LIMIT 1`,
    [userId, nowISO, nowISO]
  );
}
async function getShiftById(id) {
  return get(`SELECT * FROM shifts WHERE id = ?`, [id]);
}
async function getAttendanceState(shiftId) {
  return get(`SELECT clockin_iso, clockout_iso FROM attendance WHERE shift_id = ? ORDER BY id DESC LIMIT 1`, [shiftId]);
}
async function ensureShiftEventsTable() {
  await run(`CREATE TABLE IF NOT EXISTS shift_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    fired_iso TEXT NOT NULL,
    UNIQUE(shift_id, kind)
  )`);
}
async function markShiftEvent(shiftId, kind, firedISO) {
  await ensureShiftEventsTable();
  await run(
    `INSERT OR IGNORE INTO shift_events (shift_id, kind, fired_iso) VALUES (?, ?, ?)`,
    [shiftId, kind, firedISO]
  );
}
async function markClockIn(shiftId, whenISO) {
  await run(`UPDATE attendance SET clockin_iso = ? WHERE shift_id = ?`, [whenISO, shiftId]);
  await markShiftEvent(shiftId, 'remind', whenISO);
  await markShiftEvent(shiftId, 'start', whenISO);
}
async function markClockOut(shiftId, whenISO) {
  await run(`UPDATE attendance SET clockout_iso = ? WHERE shift_id = ?`, [whenISO, shiftId]);
}
async function hasClockedIn(shiftId) {
  const row = await get(
    `SELECT clockin_iso FROM attendance WHERE shift_id = ? ORDER BY id DESC LIMIT 1`,
    [shiftId]
  );
  return !!row?.clockin_iso;
}
async function findVoiceAndModelForTextChannel(textChannelId, fallbackModel='Model') {
  try {
    const textCh = await client.channels.fetch(textChannelId);
    if (!textCh || !('parentId' in textCh)) return { voiceChannelId: null, modelName: fallbackModel };

    const guild = await client.guilds.fetch(textCh.guildId);
    const parentId = textCh.parentId || null;
    const modelName =
      (parentId && (await guild.channels.fetch(parentId))?.name) ||
      (textCh.name.includes('-') ? textCh.name.split('-')[0] : textCh.name) ||
      fallbackModel;

    if (!parentId) return { voiceChannelId: null, modelName };
    const allCh = await guild.channels.fetch();
    const voice = [...allCh.values()].find(c => c && c.type === 2 && c.parentId === parentId);
    return { voiceChannelId: voice?.id ?? null, modelName };
  } catch {
    return { voiceChannelId: null, modelName: fallbackModel };
  }
}
async function ensureShiftVoiceChannel(shiftId, voiceChannelId) {
  if (!voiceChannelId) return;
  await run(`UPDATE shifts SET voice_channel_id = ? WHERE id = ?`, [voiceChannelId, shiftId]);
}
async function ensureShiftModel(shiftId, model) {
  if (!model) return;
  await run(`UPDATE shifts SET model = ? WHERE id = ?`, [model, shiftId]);
}
async function getActiveVoiceParticipants(voiceChannelId) {
  return all(
    `SELECT a.user_id, s.model
       FROM attendance a
       JOIN shifts s ON s.id = a.shift_id
      WHERE s.voice_channel_id = ?
        AND a.clockin_iso IS NOT NULL
        AND a.clockout_iso IS NULL`,
    [voiceChannelId]
  );
}
async function refreshVoiceChannelName(voiceChannelId, fallbackModel='Model') {
  if (!voiceChannelId) return;
  try {
    const participants = await getActiveVoiceParticipants(voiceChannelId);
    const guild = await client.guilds.fetch(GUILD_ID);
    const names = await Promise.all(
      participants.map(async ({ user_id: userId }) => {
        try {
          const member = await guild.members.fetch(userId);
          return member.displayName || member.user.username;
        } catch {
          return null;
        }
      })
    );
    const filtered = [...new Set(names.filter(Boolean))];
    const modelLabel =
      participants.find((p) => p.model)?.model ||
      fallbackModel ||
      'Model';
    const vc = await client.channels.fetch(voiceChannelId);
    if (vc?.manageable && vc.setName) {
      const newName = filtered.length ? `${modelLabel} - ${filtered.join(', ')}` : modelLabel;
      await vc.setName(newName);
    }
  } catch (e) {
    log.warn({ e }, 'voice rename failed');
  }
}
async function logShiftEvent({ type, userId, shift, whenISO, extra }) {
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
  } catch {}
}

// ───────── Deterministic scheduler tick (every 30s) ─────────
async function schedulerTick() {
  const now = DateTime.now();
  const from = now.minus({ hours: 2 }).toISO();
  const to   = now.plus({ hours: 24 }).toISO();

  await ensureShiftEventsTable();

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

    const fired = async (kind) => !!(await get(`SELECT 1 FROM shift_events WHERE shift_id=? AND kind=?`, [s.id, kind]));
    const mark  = async (kind) => markShiftEvent(s.id, kind, DateTime.now().toISO());
    if (now >= remindAt && !(await fired('remind'))) {
      if (!(await hasClockedIn(s.id))) {
        try {
          const ch = await client.channels.fetch(s.channel_id);
          await ch.send(`<@${s.user_id}> shift for **${s.model || 'your model'}** starts in 15 minutes. Please /clockin.`);
        } catch {}
      }
      await mark('remind');
    }

    if (now >= startAt && !(await fired('start'))) {
      if (!(await hasClockedIn(s.id))) {
        try {
          const ch = await client.channels.fetch(s.channel_id);
          await ch.send(`⏰ <@${s.user_id}> your shift **${s.model || ''}** starts NOW. Please /clockin.`);
        } catch {}
      }
      await mark('start');
    }

    if (now >= lateAt && !(await fired('latefine'))) {
      await mark('latefine');
    }
  }
}
setInterval(() => schedulerTick().catch(e => log.error(e, 'scheduler tick error')), 30_000);

// ───────── Schedule board ─────────
async function getShiftsForBoard(days = 7) {
  const nowISO = new Date().toISOString();
  const futureISO = new Date(Date.now() + days*864e5).toISOString();
  return all(
    `SELECT * FROM shifts
     WHERE start_iso BETWEEN ? AND ? AND model IS NOT NULL
     ORDER BY start_iso ASC`,
    [nowISO, futureISO]
  );
}
async function renderScheduleText(rows) {
  const defaultTZ = await Settings.defaultTZ();
  const byDay = {};
  for (const s of rows) {
    const start = DateTime.fromISO(s.start_iso, { zone: s.tz }).setZone(defaultTZ);
    const end = s.end_iso ? DateTime.fromISO(s.end_iso, { zone: s.tz }).setZone(defaultTZ) : null;
    const dayKey = start.toFormat('ccc dd.LL');
    const line =
      `• **${start.toFormat('HH:mm')}–${end ? end.toFormat('HH:mm') : '??'}** • ${s.model || 'Model'} • <@${s.user_id}> • <#${s.channel_id}>` +
      (s.voice_channel_id ? ` • VC: <#${s.voice_channel_id}>` : '');
    (byDay[dayKey] ||= []).push(line);
  }
  const order = Object.keys(byDay).sort((a,b) =>
    DateTime.fromFormat(a, 'ccc dd.LL') - DateTime.fromFormat(b, 'ccc dd.LL')
  );
  const todayKey = DateTime.now().setZone(defaultTZ).toFormat('ccc dd.LL');
  const todayCount = byDay[todayKey]?.length || 0;

  let text = `**📅 Schedule (auto) — TZ: ${defaultTZ}**\n> Today: **${todayCount}** shift(s)\n\n`;
  for (const k of order) text += `__${k}__\n${byDay[k].join('\n')}\n\n`;
  if (!order.length) text += '_No scheduled shifts._';
  return text.trim();
}
async function updateScheduleBoard() {
  try {
    const channelId = await Settings.scheduleChannelId();
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return;

    const rows = await getShiftsForBoard(7);
    const text = await renderScheduleText(rows);
    const msgId = await Settings.scheduleMessageId();

    if (msgId) {
      try {
        const msg = await channel.messages.fetch(msgId);
        await msg.edit(text);
        return;
      } catch {/* fallthrough */}
    }
    const sent = await channel.send(text);
    await Settings.setScheduleMessageId(sent.id);
  } catch (e) {
    log.error(e, 'updateScheduleBoard failed');
  }
}

// ───────── Interactive scheduler helpers ─────────
function createSchedulerSessionKey() {
  return Math.random().toString(36).slice(2, 10);
}
function schedulerSummary(session) {
  const tzLabel = DEFAULT_TZ;
  const dateLabel = session.date
    ? DateTime.fromISO(session.date).setZone(DEFAULT_TZ).toFormat('ccc dd LLL')
    : '—';
  const timeLabel = session.hour !== null && session.minute !== null
    ? `${String(session.hour).padStart(2, '0')}:${String(session.minute).padStart(2, '0')} ${tzLabel}`
    : '—';
  const durationLabel = session.durationMinutes ? `${session.durationMinutes} min` : '—';
  const lines = [
    `Worker: <@${session.userId}>`,
    `Channel: <#${session.channelId}>`,
    `Voice: ${session.voiceChannelId ? `<#${session.voiceChannelId}>` : 'Auto-detect'}`,
    `Model: ${session.model ?? 'Auto-detect'}`,
    `Date: ${dateLabel}`,
    `Start: ${timeLabel}`,
    `Duration: ${durationLabel}`,
  ];
  return [
    '**Interactive scheduler** (Europe/Zagreb)',
    ...lines,
    '',
    'Select date, hour, minute, duration, then press **Create shift**.'
  ].join('\n');
}
function buildSchedulerComponents(sessionKey, session) {
  const dateStart = DateTime.now().setZone(DEFAULT_TZ).startOf('day');
  const dateOptions = Array.from({ length: 7 }).map((_, idx) => {
    const d = dateStart.plus({ days: idx });
    const value = d.toISODate();
    return {
      label: d.toFormat('ccc dd LLL'),
      value,
      description: idx === 0 ? 'Today' : undefined,
      default: session.date === value,
    };
  });
  const hourOptions = Array.from({ length: 24 }).map((_, hour) => ({
    label: `${String(hour).padStart(2, '0')}:00`,
    value: String(hour),
    default: session.hour === hour,
  }));
  const minuteValues = [0, 15, 30, 45];
  const minuteOptions = minuteValues.map((m) => ({
    label: `:${String(m).padStart(2, '0')}`,
    value: String(m),
    default: session.minute === m,
  }));
  const durationOptions = [
    { label: '1h', value: '60' },
    { label: '1h 30m', value: '90' },
    { label: '2h', value: '120' },
    { label: '3h', value: '180' },
  ].map((opt) => ({
    ...opt,
    default: session.durationMinutes === Number(opt.value),
  }));

  const dateRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`scheduler-date:${sessionKey}`)
      .setPlaceholder('Select date')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(dateOptions)
  );
  const hourRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`scheduler-hour:${sessionKey}`)
      .setPlaceholder('Select hour')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(hourOptions)
  );
  const minuteRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`scheduler-minute:${sessionKey}`)
      .setPlaceholder('Select minutes')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(minuteOptions)
  );
  const durationRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`scheduler-duration:${sessionKey}`)
      .setPlaceholder('Select duration')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(durationOptions)
  );
  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`scheduler-confirm:${sessionKey}`)
      .setLabel('Create shift')
      .setStyle(ButtonStyle.Primary)
  );
  return [dateRow, hourRow, minuteRow, durationRow, confirmRow];
}
function buildSchedulerMessage(sessionKey, session) {
  return {
    content: schedulerSummary(session),
    components: buildSchedulerComponents(sessionKey, session),
  };
}
function parseSchedulerCustomId(customId) {
  if (!customId.startsWith('scheduler-')) return null;
  const [actionPart, sessionKey] = customId.split(':');
  if (!sessionKey) return null;
  const action = actionPart.replace('scheduler-', '');
  return { action, sessionKey };
}
async function handleSchedulerSelect(interaction) {
  const parsed = parseSchedulerCustomId(interaction.customId);
  if (!parsed) return;
  const session = schedulerSessions.get(parsed.sessionKey);
  if (!session) {
    await interaction.reply({ content: 'That scheduler session expired. Run `/schedule_shift` again.', ephemeral: true });
    return;
  }
  if (session.ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'This scheduler belongs to another admin.', ephemeral: true });
    return;
  }

  const value = interaction.values?.[0];
  if (parsed.action === 'date') session.date = value;
  if (parsed.action === 'hour') session.hour = Number(value);
  if (parsed.action === 'minute') session.minute = Number(value);
  if (parsed.action === 'duration') session.durationMinutes = Number(value);
  schedulerSessions.set(parsed.sessionKey, session);
  await interaction.update(buildSchedulerMessage(parsed.sessionKey, session));
}
async function handleSchedulerButton(interaction) {
  const parsed = parseSchedulerCustomId(interaction.customId);
  if (!parsed) return;
  const session = schedulerSessions.get(parsed.sessionKey);
  if (!session) {
    await interaction.reply({ content: 'That scheduler session expired. Run `/schedule_shift` again.', ephemeral: true });
    return;
  }
  if (session.ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'This scheduler belongs to another admin.', ephemeral: true });
    return;
  }
  if (parsed.action !== 'confirm') return;

  if (session.hour === null || session.minute === null || !session.date) {
    await interaction.reply({ content: 'Please pick a date, hour, and minutes before creating the shift.', ephemeral: true });
    return;
  }

  const start = DateTime.fromISO(`${session.date}T00:00`, { zone: DEFAULT_TZ })
    .set({ hour: session.hour, minute: session.minute, second: 0, millisecond: 0 });
  const end = start.plus({ minutes: session.durationMinutes || 60 });
  const tz = DEFAULT_TZ;

  let voiceChannelId = session.voiceChannelId;
  let model = session.model;
  if (!voiceChannelId || !model) {
    const { voiceChannelId: derivedVoice, modelName: derivedModel } =
      await findVoiceAndModelForTextChannel(session.channelId, model || 'Model');
    if (!voiceChannelId && derivedVoice) voiceChannelId = derivedVoice;
    if (!model && derivedModel) model = derivedModel;
  }

  const shiftId = await insertShift({
    guildId: GUILD_ID,
    userId: session.userId,
    channelId: session.channelId,
    startISO: start.toISO(),
    endISO: end.toISO(),
    tz,
    model,
    voiceChannelId,
  });

  schedulerSessions.delete(parsed.sessionKey);
  updateScheduleBoard().catch((e) => log.warn({ e }, 'schedule board refresh failed'));

  await interaction.update({
    content:
      `Shift #${shiftId} created for <@${session.userId}> in <#${session.channelId}>.\n` +
      `${start.toFormat('yyyy-LL-dd HH:mm')} → ${end.toFormat('HH:mm')} (${tz})` +
      (model ? ` • Model: ${model}` : ''),
    components: [],
  });
}

// ───────── Slash commands ─────────
const commands = [
  { name: 'clockin', description: 'Clock in for your nearest shift today (or ad-hoc if free)' },
  { name: 'clockout', description: 'Clock out of your active shift' },
  { name: 'schedule', description: 'Show upcoming shifts (next 24h)' },
  {
    name: 'sync',
    description: 'Refresh schedule board',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
  },
  {
    name: 'set_fine',
    description: 'Set fine amount in EUR',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [{ name: 'amount', description: 'Fine amount', type: 10, required: true }],
  },
  {
    name: 'set_default_tz',
    description: 'Set default timezone',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [{ name: 'tz', description: 'IANA TZ (e.g. Europe/Zagreb)', type: 3, required: true }],
  },
  {
    name: 'set_schedule_channel',
    description: 'Set channel for schedule board',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [{ name: 'channel', description: 'Text channel', type: 7, required: true }],
  },
  {
    name: 'set_logs_channel',
    description: 'Set channel for shift logs',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [{ name: 'channel', description: 'Text channel', type: 7, required: true }],
  },
  {
    name: 'schedule_shift',
    description: 'Interactive scheduler (Zagreb time)',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      { name: 'user', description: 'Worker', type: 6, required: true },
      { name: 'channel', description: 'Work text channel', type: 7, required: true },
      { name: 'voice_channel', description: 'Voice channel (optional)', type: 7, required: false },
      { name: 'model', description: 'Model label override', type: 3, required: false },
    ],
  },
  {
    name: 'add_shift',
    description: 'Add a shift',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      { name: 'user', description: 'Worker', type: 6, required: true },
      { name: 'channel', description: 'Work text channel', type: 7, required: true },
      { name: 'start', description: 'Start ISO (YYYY-MM-DDTHH:mm)', type: 3, required: true },
      { name: 'end', description: 'End ISO (YYYY-MM-DDTHH:mm)', type: 3, required: true },
      { name: 'timezone', description: 'IANA TZ (e.g. Europe/Zagreb)', type: 3, required: false },
      { name: 'model', description: 'Model label', type: 3, required: false },
      { name: 'voice_channel', description: 'Voice channel to rename', type: 7, required: false },
    ],
  },
  {
    name: 'remove_shift',
    description: 'Remove a shift by ID',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [{ name: 'id', description: 'Shift ID', type: 4, required: true }],
  },
  {
    name: 'fines',
    description: 'View fines (yours or target)',
    options: [{ name: 'user', description: 'Target user', type: 6, required: false }],
  },
  {
    name: 'pardon',
    description: 'Delete a fine by ID',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [{ name: 'id', description: 'Fine ID', type: 4, required: true }],
  }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const app = await client.application.fetch();
  await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: commands });
}

// ───────── Ready ─────────
client.once('ready', async () => {
  log.info(`Logged in as ${client.user.tag}`);
  await registerCommands();
  updateScheduleBoard();
});

// ───────── Interactions ─────────
client.on('interactionCreate', async (i) => {
  if (i.isStringSelectMenu() && i.customId.startsWith('scheduler-')) {
    await handleSchedulerSelect(i);
    return;
  }
  if (i.isButton() && i.customId.startsWith('scheduler-')) {
    await handleSchedulerButton(i);
    return;
  }
  if (!i.isChatInputCommand()) return;
  const name = i.commandName;

  // Settings
  if (name === 'set_schedule_channel') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return i.reply({ content: 'Admins only.', ephemeral: true });
    const ch = i.options.getChannel('channel', true);
    await Settings.setScheduleChannelId(ch.id);
    await Settings.setScheduleMessageId('');
    await i.reply({ content: `Schedule channel set to <#${ch.id}>.`, ephemeral: true });
    updateScheduleBoard();
    return;
  }
  if (name === 'set_logs_channel') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return i.reply({ content: 'Admins only.', ephemeral: true });
    const ch = i.options.getChannel('channel', true);
    await Settings.setLogsChannelId(ch.id);
    return i.reply({ content: `Shift logs channel set to <#${ch.id}>.`, ephemeral: true });
  }
  if (name === 'schedule_shift') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return i.reply({ content: 'Admins only.', ephemeral: true });
    const worker = i.options.getUser('user', true);
    const channel = i.options.getChannel('channel', true);
    if (!channel?.isTextBased?.())
      return i.reply({ content: 'Please pick a text-based channel for the shift.', ephemeral: true });
    const voice = i.options.getChannel('voice_channel');
    if (voice && ![2, 13].includes(voice.type))
      return i.reply({ content: 'Voice channel must be a voice or stage channel.', ephemeral: true });
    const model = i.options.getString('model');
    const sessionKey = createSchedulerSessionKey();
    const session = {
      ownerId: i.user.id,
      userId: worker.id,
      channelId: channel.id,
      voiceChannelId: voice?.id ?? null,
      model: model ?? null,
      date: DateTime.now().setZone(DEFAULT_TZ).toISODate(),
      hour: null,
      minute: 0,
      durationMinutes: 60,
    };
    schedulerSessions.set(sessionKey, session);
    setTimeout(() => schedulerSessions.delete(sessionKey), 15 * 60 * 1000);
    return i.reply({ ephemeral: true, ...buildSchedulerMessage(sessionKey, session) });
  }
  if (name === 'set_fine') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return i.reply({ content: 'Admins only.', ephemeral: true });
    const amt = i.options.getNumber('amount', true);
    await Settings.setFineEUR(amt);
    return i.reply({ content: `Fine set to €${amt}.`, ephemeral: true });
  }
  if (name === 'set_default_tz') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return i.reply({ content: 'Admins only.', ephemeral: true });
    const tz = i.options.getString('tz', true);
    try { DateTime.now().setZone(tz); } catch { return i.reply({ content: 'Invalid timezone.', ephemeral: true }); }
    await Settings.setDefaultTZ(tz);
    return i.reply({ content: `Default timezone set to ${tz}.`, ephemeral: true });
  }

  // Add/remove
  if (name === 'add_shift') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return i.reply({ content: 'Admins only.', ephemeral: true });

    await i.deferReply({ ephemeral: true });
    const user = i.options.getUser('user', true);
    const ch   = i.options.getChannel('channel', true);
    const startStr = i.options.getString('start', true);
    const endStr   = i.options.getString('end', true);
    const tz = i.options.getString('timezone') || await Settings.defaultTZ();
    const model = i.options.getString('model') || null;
    const voice = i.options.getChannel('voice_channel');

    let tzOk = true; try { DateTime.now().setZone(tz); } catch { tzOk = false; }
    if (!tzOk) return i.editReply('Invalid timezone.');

    const start = DateTime.fromISO(startStr, { zone: tz });
    const end   = DateTime.fromISO(endStr,   { zone: tz });
    if (!start.isValid || !end.isValid) return i.editReply('Times must be ISO like 2025-08-23T14:00');
    if (end <= start) return i.editReply('End must be after start.');

    const id = await insertShift({
      guildId: GUILD_ID,
      userId: user.id,
      channelId: ch.id,
      startISO: start.toISO(),
      endISO: end.toISO(),
      tz, model,
      voiceChannelId: voice ? voice.id : null
    });

    await i.editReply(
      `Shift #${id} added for ${user} • ${start.toFormat('yyyy-LL-dd HH:mm')} → ${end.toFormat('HH:mm')} (${tz}).` +
      (voice ? ` Voice: <#${voice.id}>` : '')
    );
    updateScheduleBoard();
    return;
  }
  if (name === 'remove_shift') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return i.reply({ content: 'Admins only.', ephemeral: true });
    const id = i.options.getInteger('id', true);
    const changed = await removeShift(id);
    if (!changed) return i.reply({ content: 'Shift not found.', ephemeral: true });
    await i.reply({ content: `Shift #${id} removed.`, ephemeral: true });
    updateScheduleBoard();
    return;
  }

  // Info
  if (name === 'schedule') {
    await i.deferReply({ ephemeral: true });
    const now = DateTime.now();
    const until = now.plus({ days: 1 });
    const rows = await all(
      `SELECT * FROM shifts WHERE start_iso BETWEEN ? AND ? ORDER BY start_iso ASC`,
      [now.toISO(), until.toISO()]
    );
    if (!rows.length) return i.editReply('No upcoming shifts in next 24h.');
    const defaultTZ = await Settings.defaultTZ();
    const embed = new EmbedBuilder().setTitle('Upcoming Shifts (next 24h)').setColor(0x00AE86);
    for (const s of rows) {
      const start = DateTime.fromISO(s.start_iso, { zone: s.tz }).setZone(defaultTZ);
      const end = DateTime.fromISO(s.end_iso, { zone: s.tz }).setZone(defaultTZ);
      embed.addFields({
        name: `${s.model || 'Model'} • <@${s.user_id}>`,
        value:
          `${start.toFormat('yyyy-LL-dd HH:mm')} → ${end.toFormat('HH:mm')} • ` +
          `<#${s.channel_id}>` +
          (s.voice_channel_id ? ` • VC: <#${s.voice_channel_id}>` : ''),
      });
    }
    return i.editReply({ embeds: [embed] });
  }

  // Clock in (scheduled first; else ad-hoc if channel free)
  if (name === 'clockin') {
    const userId = i.user.id;
    const now = DateTime.now();
    await i.deferReply({ ephemeral: true });

    const nearest = await getNearestShiftToday(userId, now.toISO());
    if (nearest) {
      const attendance = await getAttendanceState(nearest.id);
      if (attendance?.clockin_iso) return i.editReply('Already clocked in.');

      await markClockIn(nearest.id, now.toISO());
      const s = await getShiftById(nearest.id);

      try { const textCh = await client.channels.fetch(s.channel_id); await textCh.send(`<@${userId}> clocked in ✅`); } catch {}
      try {
        let voiceChannelId = s.voice_channel_id;
        let modelName = s.model;

        if (!voiceChannelId || !modelName) {
          const { voiceChannelId: foundVoice, modelName: derivedModel } =
            await findVoiceAndModelForTextChannel(s.channel_id, modelName || 'Model');
          if (!voiceChannelId && foundVoice) {
            voiceChannelId = foundVoice;
            await ensureShiftVoiceChannel(s.id, voiceChannelId);
            s.voice_channel_id = voiceChannelId;
          }
          if (!modelName && derivedModel) {
            modelName = derivedModel;
            await ensureShiftModel(s.id, modelName);
            s.model = modelName;
          }
        }

        if (voiceChannelId) {
          await refreshVoiceChannelName(voiceChannelId, modelName || 'Model');
        }
      } catch (e) {
        log.warn({ e }, 'voice channel refresh failed on clock-in');
      }
      await logShiftEvent({
        type: 'in',
        userId,
        shift: s,
        whenISO: now.toISO(),
        extra: (() => {
          const start = DateTime.fromISO(s.start_iso, { zone: s.tz });
          const mins = Math.floor((now.toMillis() - start.toMillis()) / 60000);
          return mins > 0 ? `Late: ${mins} min` : 'On time';
        })()
      });
      const tz = await Settings.defaultTZ();
      return i.editReply(`Clocked in at ${now.setZone(tz).toFormat('HH:mm')} ${tz}.`);
    }

    // Ad-hoc: only if channel has no active chatter
    try {
      const tz = await Settings.defaultTZ();
      const workChannel = i.channel;
      if (!workChannel?.isTextBased?.()) return i.editReply('Run `/clockin` inside the model’s text channel.');

      const active = await get(
        `SELECT 1 FROM attendance a
           JOIN shifts s ON s.id = a.shift_id
          WHERE s.channel_id = ? AND a.clockin_iso IS NOT NULL AND a.clockout_iso IS NULL
          LIMIT 1`,
        [workChannel.id]
      );
      if (active) return i.editReply('Someone is already clocked in in this channel.');

      // create ad-hoc row
      const startISO = now.setZone(tz).toISO();
      const r1 = await run(
        `INSERT INTO shifts (guild_id, user_id, channel_id, start_iso, end_iso, tz, model, voice_channel_id)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL)`,
        [GUILD_ID, userId, workChannel.id, startISO, tz]
      );
      const shiftId = r1.lastID;
      await run(`INSERT INTO attendance (user_id, shift_id, clockin_iso) VALUES (?, ?, ?)`, [userId, shiftId, startISO]);

      try { await workChannel.send(`<@${userId}> clocked in ✅ *(unscheduled/ad-hoc)*`); } catch {}
      try {
        const { voiceChannelId, modelName } = await findVoiceAndModelForTextChannel(workChannel.id);
        if (modelName) await ensureShiftModel(shiftId, modelName);
        if (voiceChannelId) {
          await ensureShiftVoiceChannel(shiftId, voiceChannelId);
          await refreshVoiceChannelName(voiceChannelId, modelName || 'Model');
        }
        await logShiftEvent({
          type: 'in',
          userId,
          shift: { id: shiftId, channel_id: workChannel.id, model: modelName, tz },
          whenISO: now.toISO(),
          extra: 'Ad-hoc (unscheduled) clock-in'
        });
      } catch (e) {
        log.warn({ e }, 'ad-hoc clockin voice update failed');
      }

      const tz2 = await Settings.defaultTZ();
      return i.editReply(`Clocked in (ad-hoc) at ${now.setZone(tz2).toFormat('HH:mm')} ${tz2}.`);
    } catch (e) {
      log.error(e, 'Ad-hoc clockin error');
      return i.editReply('Could not clock you in ad-hoc. Ask an admin.');
    }
  }

  // Clock out (with early confirmation)
  if (name === 'clockout') {
    const userId = i.user.id;
    const now = DateTime.now();
    await i.deferReply({ ephemeral: true });

    const shift = await get(
      `SELECT sh.* FROM shifts sh
       JOIN attendance a ON a.shift_id = sh.id
       WHERE sh.user_id = ? AND a.clockin_iso IS NOT NULL AND a.clockout_iso IS NULL
       ORDER BY sh.start_iso DESC LIMIT 1`,
      [userId]
    );
    if (!shift) return i.editReply('No active shift found or not clocked in.');

    const endTime = shift.end_iso ? DateTime.fromISO(shift.end_iso, { zone: shift.tz }) : null;
    const nowLocal = now.setZone(shift.tz);

    if (endTime && nowLocal < endTime) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('clockout_confirm').setLabel('Confirm clock out').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('clockout_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
      );

      const msg = await i.followUp({
        content: `⚠️ You are scheduled until **${endTime.toFormat('HH:mm')}** (${shift.tz}).\nClocking out early may result in a fine.\nChoose an option:`,
        components: [row],
        ephemeral: true,
        fetchReply: true,
      });

      try {
        const click = await msg.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: 30_000,
          filter: (btnI) => btnI.user.id === userId,
        });

        await click.update({
          components: [new ActionRowBuilder().addComponents(
            ButtonBuilder.from(row.components[0]).setDisabled(true),
            ButtonBuilder.from(row.components[1]).setDisabled(true),
          )],
        });

        if (click.customId === 'clockout_confirm') {
          await markClockOut(shift.id, now.toISO());
          try { const textCh = await client.channels.fetch(shift.channel_id); await textCh.send(`<@${userId}> clocked out ❌`); } catch {}
          try {
            let voiceChannelId = shift.voice_channel_id;
            let modelName = shift.model;
            if (!voiceChannelId || !modelName) {
              const { voiceChannelId: foundVoice, modelName: derivedModel } =
                await findVoiceAndModelForTextChannel(shift.channel_id, modelName || 'Model');
              if (!voiceChannelId && foundVoice) {
                voiceChannelId = foundVoice;
                await ensureShiftVoiceChannel(shift.id, voiceChannelId);
                shift.voice_channel_id = voiceChannelId;
              }
              if (!modelName && derivedModel) {
                modelName = derivedModel;
                await ensureShiftModel(shift.id, modelName);
                shift.model = modelName;
              }
            }
            if (voiceChannelId) {
              await refreshVoiceChannelName(voiceChannelId, modelName || 'Model');
            }
          } catch (e) {
            log.warn({ e }, 'voice channel refresh failed on clock-out');
          }
          await logShiftEvent({ type: 'out', userId, shift, whenISO: now.toISO() });
          const tz = await Settings.defaultTZ();
          await i.followUp({ content: `Clocked out at ${now.setZone(tz).toFormat('HH:mm')} ${tz}.`, ephemeral: true });
        } else {
          await i.followUp({ content: '❌ Clock-out cancelled.', ephemeral: true });
        }
      } catch {
        await i.followUp({ content: '⌛ Clock-out request timed out.', ephemeral: true });
      }
      return;
    }

    // normal clock out
    await markClockOut(shift.id, now.toISO());
    try { const textCh = await client.channels.fetch(shift.channel_id); await textCh.send(`<@${userId}> clocked out ❌`); } catch {}
    try {
      let voiceChannelId = shift.voice_channel_id;
      let modelName = shift.model;
      if (!voiceChannelId || !modelName) {
        const { voiceChannelId: foundVoice, modelName: derivedModel } =
          await findVoiceAndModelForTextChannel(shift.channel_id, modelName || 'Model');
        if (!voiceChannelId && foundVoice) {
          voiceChannelId = foundVoice;
          await ensureShiftVoiceChannel(shift.id, voiceChannelId);
          shift.voice_channel_id = voiceChannelId;
        }
        if (!modelName && derivedModel) {
          modelName = derivedModel;
          await ensureShiftModel(shift.id, modelName);
          shift.model = modelName;
        }
      }
      if (voiceChannelId) {
        await refreshVoiceChannelName(voiceChannelId, modelName || 'Model');
      }
    } catch (e) {
      log.warn({ e }, 'voice channel refresh failed on clock-out');
    }
    await logShiftEvent({ type: 'out', userId, shift, whenISO: now.toISO() });
    const tz = await Settings.defaultTZ();
    return i.editReply(`Clocked out at ${now.setZone(tz).toFormat('HH:mm')} ${tz}.`);
  }

  // Fines
  if (name === 'fines') {
    const target = i.options.getUser('user') || i.user;
    const isAdmin = i.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (target.id !== i.user.id && !isAdmin)
      return i.reply({ content: 'You can only view your own fines.', ephemeral: true });

    await i.deferReply({ ephemeral: true });
    const rows = await all(
      `SELECT id, amount, reason, issued_iso FROM fines WHERE user_id = ? ORDER BY id DESC LIMIT 25`,
      [target.id]
    );
    if (!rows.length) return i.editReply(`${target.tag ?? target.username} has no fines.`);
    const tz = await Settings.defaultTZ();
    const lines = rows.map(
      (r) => `#${r.id} • €${r.amount} • ${DateTime.fromISO(r.issued_iso).setZone(tz).toFormat('yyyy-LL-dd HH:mm')} • ${r.reason}`
    );
    return i.editReply(`Latest fines for ${target}:\n` + lines.join('\n'));
  }

  if (name === 'pardon') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
      return i.reply({ content: 'Admins only.', ephemeral: true });
    const id = i.options.getInteger('id', true);
    const r = await run(`DELETE FROM fines WHERE id = ?`, [id]);
    if (!r.changes) return i.reply({ content: 'Fine not found.', ephemeral: true });
    return i.reply({ content: `Fine #${id} pardoned.`, ephemeral: true });
  }

  if (name === 'sync') {
    updateScheduleBoard();
    return i.reply({ content: 'Schedule board refreshed.', ephemeral: true });
  }
});

client.once('error', (e) => log.error(e, 'Client error'));
client.login(DISCORD_TOKEN);
