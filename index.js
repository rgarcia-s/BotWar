import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, AttachmentBuilder, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { DateTime } from 'luxon';

const {
  DISCORD_TOKEN,
  TIMEZONE = 'America/Sao_Paulo',
  LOG_CHANNEL_ID = '0'
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN no .env');
  process.exit(1);
}

const lastDmAt = new Map(); // chave: `${guildId}:${userId}` -> Date
const MIN_DM_INTERVAL_MINUTES = 120; // mude se quiser outro intervalo

function canSendDm(guildId, userId) {
  const k = `${guildId}:${userId}`;
  const last = lastDmAt.get(k);
  if (!last) return true;
  const diffMin = (Date.now() - last.getTime()) / 60000;
  return diffMin >= MIN_DM_INTERVAL_MINUTES;
}
function markDmSent(guildId, userId) {
  lastDmAt.set(`${guildId}:${userId}`, new Date());
}

const activeEvents = new Map(); // guildId -> { event: row, timer: Timeout | null }


// ===== Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});

// ===== Tempo do bot liberar checkout
const CHECKOUT_MINUTES_REQUIRED = 2;


// ===== DB
const DB_PATH = 'presencas.db';
let db;

async function initDb() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      checkin_at TEXT NOT NULL,
      checkout_at TEXT,
      duration_minutes INTEGER
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      UNIQUE(guild_id, channel_id)
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      expected_end_at TEXT NOT NULL,
      ended_at TEXT
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS event_participations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      duration_minutes INTEGER,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    );
  `);
  await ensureSessionsIdsAreText();
  await ensureTrackedChannelsIdsAreText();
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions (guild_id, user_id, checkout_at);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_tracked_guild ON tracked_channels (guild_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_events_guild_open ON events (guild_id, ended_at);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_event_participations_event ON event_participations (event_id, user_id, left_at);`);
}

async function ensureSessionsIdsAreText() {
  const columns = await db.all(`PRAGMA table_info(sessions);`);
  if (!columns.length) return;
  const needsMigration = columns.some(col =>
    ['guild_id', 'user_id', 'channel_id'].includes(col.name) && col.type.toUpperCase() !== 'TEXT'
  );
  if (!needsMigration) return;

  await db.exec('BEGIN TRANSACTION;');
  try {
    await db.exec('ALTER TABLE sessions RENAME TO sessions_old;');
    await db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        checkin_at TEXT NOT NULL,
        checkout_at TEXT,
        duration_minutes INTEGER
      );
    `);
    await db.exec(`
      INSERT INTO sessions (id, guild_id, user_id, user_name, channel_id, checkin_at, checkout_at, duration_minutes)
      SELECT id,
             printf('%s', guild_id),
             printf('%s', user_id),
             user_name,
             printf('%s', channel_id),
             checkin_at,
             checkout_at,
             duration_minutes
      FROM sessions_old;
    `);
    await db.exec('DROP TABLE sessions_old;');
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    console.error('Falha ao migrar tabela sessions para IDs em texto:', err);
    throw err;
  }
}

async function ensureTrackedChannelsIdsAreText() {
  const columns = await db.all(`PRAGMA table_info(tracked_channels);`);
  if (!columns.length) return;
  const needsMigration = columns.some(col =>
    ['guild_id', 'channel_id'].includes(col.name) && col.type.toUpperCase() !== 'TEXT'
  );
  if (!needsMigration) return;

  await db.exec('BEGIN TRANSACTION;');
  try {
    await db.exec('ALTER TABLE tracked_channels RENAME TO tracked_channels_old;');
    await db.exec(`
      CREATE TABLE tracked_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        UNIQUE(guild_id, channel_id)
      );
    `);
    await db.exec(`
      INSERT INTO tracked_channels (id, guild_id, channel_id)
      SELECT id,
             printf('%s', guild_id),
             printf('%s', channel_id)
      FROM tracked_channels_old;
    `);
    await db.exec('DROP TABLE tracked_channels_old;');
    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    console.error('Falha ao migrar tabela tracked_channels para IDs em texto:', err);
    throw err;
  }
}

function nowISO() {
  return DateTime.now().setZone(TIMEZONE).toISO();
}
function toDT(iso) {
  return DateTime.fromISO(iso, { zone: TIMEZONE });
}

async function getOpenSession(guildId, userId) {
  return db.get(
    `SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND checkout_at IS NULL ORDER BY id DESC LIMIT 1`,
    [String(guildId), String(userId)]
  );
}
async function startSession(guildId, user, channelId) {
  await db.run(
    `INSERT INTO sessions (guild_id, user_id, user_name, channel_id, checkin_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      String(guildId),
      String(user.id),
      `${user.displayName ?? user.user?.username}#${user.user?.discriminator ?? '0000'}`,
      String(channelId),
      nowISO()
    ]
  );
}
async function finishSession(sessionId, whenISO) {
  const row = await db.get(`SELECT checkin_at FROM sessions WHERE id=?`, [sessionId]);
  if (!row) return;
  const start = toDT(row.checkin_at);
  const end = DateTime.fromISO(whenISO, { zone: TIMEZONE });
  const duration = Math.round(end.diff(start, 'minutes').minutes);
  await db.run(
    `UPDATE sessions SET checkout_at=?, duration_minutes=? WHERE id=?`,
    [whenISO, duration, sessionId]
  );
}
function elapsedMinutes(sessionRow) {
  const start = toDT(sessionRow.checkin_at);
  return Math.floor(DateTime.now().setZone(TIMEZONE).diff(start, 'minutes').minutes);
}

// ===== Eventos (rastreamento temporário de sala)

function guildKey(id) {
  return String(id);
}

function displayNameForMember(member) {
  return `${member.displayName ?? member.user?.username}#${member.user?.discriminator ?? '0000'}`;
}

function scheduleEventTimer(eventRow) {
  const expected = DateTime.fromISO(eventRow.expected_end_at, { zone: TIMEZONE });
  const now = DateTime.now().setZone(TIMEZONE);
  const delayMs = Math.max(0, expected.diff(now, 'milliseconds').milliseconds);
  return setTimeout(() => {
    autoStopEvent(eventRow.guild_id).catch((err) => {
      console.error('Falha ao encerrar evento automaticamente:', err);
    });
  }, delayMs);
}

function storeActiveEvent(eventRow) {
  const key = guildKey(eventRow.guild_id);
  const current = activeEvents.get(key);
  if (current?.timer) {
    clearTimeout(current.timer);
  }
  const timer = scheduleEventTimer(eventRow);
  activeEvents.set(key, { event: eventRow, timer });
}

function getActiveEvent(guildId) {
  const entry = activeEvents.get(guildKey(guildId));
  return entry?.event ?? null;
}

async function createEvent(guildId, channelId, name, durationMinutes) {
  const started = nowISO();
  const expected = DateTime.now().setZone(TIMEZONE).plus({ minutes: durationMinutes }).toISO();
  const result = await db.run(
    `INSERT INTO events (guild_id, name, channel_id, started_at, expected_end_at) VALUES (?,?,?,?,?)`,
    [guildKey(guildId), name, String(channelId), started, expected]
  );
  const row = await db.get(`SELECT * FROM events WHERE id=?`, [result.lastID]);
  storeActiveEvent(row);
  return row;
}

async function autoStopEvent(guildId) {
  const key = guildKey(guildId);
  const entry = activeEvents.get(key);
  if (!entry) return null;
  activeEvents.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  const endIso = entry.event.expected_end_at;
  const finished = await finalizeEvent(entry.event, endIso);
  let guild = null;
  try {
    guild = client.guilds.cache.get(key) ?? await client.guilds.fetch(key);
  } catch (err) {
    console.error('Falha ao obter guild ao encerrar evento automaticamente:', err);
  }
  if (guild) {
    try {
      await sendLog(guild, `⏹️ **Evento encerrado automaticamente** (${entry.event.id}): ${entry.event.name}`);
    } catch (err) {
      console.error('Falha ao notificar encerramento automático do evento:', err);
    }
    await sendEventDocToOwner(guild, finished);
  }
  return finished;
}

async function stopActiveEvent(guildId, endIso = nowISO()) {
  const key = guildKey(guildId);
  const entry = activeEvents.get(key);
  if (!entry) return null;
  activeEvents.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  return finalizeEvent(entry.event, endIso);
}

async function finalizeEvent(eventRow, endIso) {
  const end = endIso ?? nowISO();
  await db.run(`UPDATE events SET ended_at=? WHERE id=?`, [end, eventRow.id]);
  const open = await db.all(
    `SELECT id FROM event_participations WHERE event_id=? AND left_at IS NULL`,
    [eventRow.id]
  );
  for (const row of open) {
    await finishEventParticipation(row.id, end);
  }
  return { ...eventRow, ended_at: end };
}

async function getOpenEventParticipation(eventId, userId) {
  return db.get(
    `SELECT * FROM event_participations WHERE event_id=? AND user_id=? AND left_at IS NULL ORDER BY id DESC LIMIT 1`,
    [eventId, guildKey(userId)]
  );
}

async function startEventParticipation(eventRow, member) {
  const existing = await getOpenEventParticipation(eventRow.id, member.id);
  if (existing) return existing;
  const joinedAt = nowISO();
  await db.run(
    `INSERT INTO event_participations (event_id, user_id, user_name, joined_at) VALUES (?,?,?,?)`,
    [eventRow.id, guildKey(member.id), displayNameForMember(member), joinedAt]
  );
  return db.get(`SELECT * FROM event_participations WHERE event_id=? AND user_id=? AND joined_at=?`, [
    eventRow.id,
    guildKey(member.id),
    joinedAt
  ]);
}

async function finishEventParticipation(participationId, endIso) {
  const row = await db.get(`SELECT joined_at FROM event_participations WHERE id=?`, [participationId]);
  if (!row) return;
  const start = toDT(row.joined_at);
  const end = DateTime.fromISO(endIso, { zone: TIMEZONE });
  const duration = Math.max(0, Math.round(end.diff(start, 'minutes').minutes));
  await db.run(
    `UPDATE event_participations SET left_at=?, duration_minutes=? WHERE id=?`,
    [endIso, duration, participationId]
  );
}

async function stopParticipationForMember(eventRow, member, endIso = nowISO()) {
  const participation = await getOpenEventParticipation(eventRow.id, member.id);
  if (!participation) return;
  await finishEventParticipation(participation.id, endIso);
}

async function bootstrapEventParticipants(eventRow, guild) {
  try {
    const channel = await guild.channels.fetch(eventRow.channel_id);
    if (!channel || channel.type !== ChannelType.GuildVoice) return;
    for (const member of channel.members.values()) {
      if (member.user?.bot) continue;
      await startEventParticipation(eventRow, member);
    }
  } catch (err) {
    console.error('Falha ao sincronizar membros do evento ativo:', err);
  }
}

async function restoreActiveEvents(client) {
  const rows = await db.all(`SELECT * FROM events WHERE ended_at IS NULL ORDER BY started_at ASC`);
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.guild_id)) {
      const finished = await finalizeEvent(row, row.expected_end_at);
      try {
        const guild = client.guilds.cache.get(row.guild_id) ?? await client.guilds.fetch(row.guild_id);
        if (guild) {
          await sendEventDocToOwner(guild, finished);
        }
      } catch (err) {
        console.error('Falha ao enviar relatório de evento restaurado automaticamente:', err);
      }
      continue;
    }
    seen.add(row.guild_id);
    storeActiveEvent(row);
    const guild = client.guilds.cache.get(row.guild_id);
    if (guild) {
      await bootstrapEventParticipants(row, guild);
    }
  }
}

function formatEventTimeLeft(eventRow) {
  const expected = DateTime.fromISO(eventRow.expected_end_at, { zone: TIMEZONE });
  const now = DateTime.now().setZone(TIMEZONE);
  const minutesTotal = Math.max(0, Math.round(expected.diff(now, 'minutes').minutes));
  if (minutesTotal <= 0) return 'encerrando agora';
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}min`);
  return parts.join(' ');
}

async function buildEventReport(eventId, includeInProgress = true) {
  const rows = await db.all(
    `SELECT user_id, user_name, duration_minutes, joined_at
     FROM event_participations
     WHERE event_id=?`,
    [eventId]
  );
  if (!rows.length) return [];

  const totals = new Map();
  for (const row of rows) {
    const key = row.user_id;
    const info = totals.get(key) ?? { name: row.user_name, minutes: 0 };
    if (row.duration_minutes != null) {
      info.minutes += row.duration_minutes;
    } else if (includeInProgress) {
      const start = toDT(row.joined_at);
      const now = DateTime.now().setZone(TIMEZONE);
      info.minutes += Math.max(0, Math.round(now.diff(start, 'minutes').minutes));
    }
    totals.set(key, info);
  }

  return [...totals.values()].sort((a, b) => b.minutes - a.minutes);
}

function formatDocDate(iso) {
  if (!iso) return '—';
  try {
    return toDT(iso).toFormat('dd/LL/yyyy HH:mm');
  } catch (err) {
    console.error('Falha ao formatar data para relatório do evento:', err);
    return '—';
  }
}

async function generateEventDocData(eventRow) {
  const report = await buildEventReport(eventRow.id, false);
  const start = formatDocDate(eventRow.started_at);
  const end = formatDocDate(eventRow.ended_at ?? eventRow.expected_end_at);
  const expected = formatDocDate(eventRow.expected_end_at);

  const lines = [
    `Evento: ${eventRow.name}`,
    `ID: ${eventRow.id}`,
    `Sala de voz (ID): ${eventRow.channel_id}`,
    `Início: ${start}`,
    `Fim real: ${end}`,
    `Fim previsto: ${expected}`,
    '',
    'Participantes:'
  ];

  if (report.length) {
    report.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item.name} — ${item.minutes} min`);
    });
  } else {
    lines.push('Nenhum participante registrou presença durante o evento.');
  }

  const content = `${lines.join('\r\n')}\r\n`;
  return {
    buffer: Buffer.from(content, 'utf-8'),
    filename: `relatorio_evento_${eventRow.id}.doc`,
    participantCount: report.length
  };
}

async function sendEventDocToOwner(guild, eventRow, docData, skipUserId = null) {
  try {
    const owner = await guild.fetchOwner();
    if (!owner) return false;
    if (skipUserId && owner.id === skipUserId) return false;
    const data = docData ?? await generateEventDocData(eventRow);
    const attachment = new AttachmentBuilder(data.buffer, { name: data.filename });
    await owner.send({
      content: `📄 Relatório final do evento **${eventRow.name}** (ID ${eventRow.id}).`,
      files: [attachment]
    });
    return true;
  } catch (err) {
    console.error('Falha ao enviar relatório do evento ao administrador:', err);
    return false;
  }
}



client.on(Events.InteractionCreate, async (interaction) => {
  console.log('Interaction type:', interaction.type, 'command?', interaction.isChatInputCommand() ? interaction.commandName : null);
  // ...resto do código
});




// tracked channels
async function listTrackedIds(guildId) {
  const rows = await db.all(`SELECT channel_id FROM tracked_channels WHERE guild_id=?`, [String(guildId)]);
  return new Set(rows.map(r => String(r.channel_id)));
}
async function isTracked(guildId, channelId) {
  if (!channelId) return false;
  const row = await db.get(
    `SELECT 1 FROM tracked_channels WHERE guild_id=? AND channel_id=?`,
    [String(guildId), String(channelId)]
  );
  return !!row;
}
async function addTracked(guildId, channelId) {
  await db.run(
    `INSERT OR IGNORE INTO tracked_channels (guild_id, channel_id) VALUES (?,?)`,
    [String(guildId), String(channelId)]
  );
}
async function remTracked(guildId, channelId) {
  await db.run(
    `DELETE FROM tracked_channels WHERE guild_id=? AND channel_id=?`,
    [String(guildId), String(channelId)]
  );
}

// logging
async function resolveLogChannel(guild) {
  const id = LOG_CHANNEL_ID?.trim();
  if (!id) return null;

  let channel = guild.channels.cache.get(id);
  if (!channel) {
    try {
      channel = await guild.channels.fetch(id);
    } catch (err) {
      console.error(`Falha ao buscar o canal de log (${id})`, err);
      return null;
    }
  }

  if (!channel || channel.type !== ChannelType.GuildText) {
    console.error(`Canal de log (${id}) não é um canal de texto válido.`);
    return null;
  }

  return channel;
}

async function sendLog(guild, text) {
  const channel = await resolveLogChannel(guild);
  if (!channel) return;
  try {
    await channel.send(text);
  } catch (err) {
    console.error('Falha ao enviar mensagem para o canal de log.', err);
  }
}

// ===== UI helpers (botões)

function buildCheckoutButtonCustomId(guildId, userId) {
  return `checkout:${guildId}:${userId}`;
}
function buildRefreshButtonCustomId(authorId) {
  return `refresh_panel:${authorId}`;
}

function makeCheckoutRowForUser(guildId, userId, label = '✅ Fazer Checkout') {
  const btn = new ButtonBuilder()
    .setCustomId(buildCheckoutButtonCustomId(guildId, userId))
    .setLabel(label)
    .setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder().addComponents(btn);
}

async function trySendCheckoutNotification(member) {
  const guild = member.guild;
  if (!guild) return false;

  if (!canSendDm(guild.id, member.id)) {
    return false;
  }

  try {
    const row = makeCheckoutRowForUser(member.guild.id, member.id);
    await member.send({
      content: [
        `👋 Olá, ${member.displayName ?? member.user?.username}!`,
        'Seu check-in começou agora há pouco.',
        'Quando completar o tempo necessário, clique abaixo para fazer checkout.',
        '_Se clicar antes, eu aviso quanto tempo falta._'
      ].join('\n'),
      components: [row]
    });
    markDmSent(guild.id, member.id);
    return true;
  } catch (err) {
    console.error('Falha ao enviar DM de checkout para o usuário.', err);
    return false;
  }
}

// ===== Painel avançado

async function getActiveCheckinsByChannel(guild) {
  const result = {};
  const tracked = await listTrackedIds(guild.id);
  if (!tracked.size) return result;

  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== ChannelType.GuildVoice) continue;
    if (!tracked.has(ch.id)) continue;

    const members = [];
    for (const m of ch.members.values()) {
      if (m.user?.bot) continue;
      const row = await getOpenSession(guild.id, m.id);
      if (!row) continue;
      members.push({
        member: m,
        minutes: elapsedMinutes(row),
        session_id: row.id
      });
    }
    if (members.length) result[ch.id] = members;
  }
  return result;
}

async function postCheckoutPanel(channel, guild, authorMember) {
  const grouped = await getActiveCheckinsByChannel(guild);
  if (!Object.keys(grouped).length) {
    await channel.send('📭 Ninguém com check-in aberto nas salas rastreadas.');
    return;
  }

  // corpo de texto
  const lines = [];
  for (const cid of Object.keys(grouped).sort((a,b)=>String(a).localeCompare(String(b)))) {
    lines.push(`**🎧 <#${cid}>**`);
    const members = grouped[cid].slice().sort((a,b)=>a.member.displayName.localeCompare(b.member.displayName, 'pt-BR', { sensitivity: 'base' }));
    for (const info of members) {
      lines.push(` • ${info.member.displayName} — ${info.minutes} min`);
    }
  }
  const content = `🧾 **Painel de Checkout**\n${lines.join('\n')}`;

  // botões (até 24 de checkout + 1 refresh)
  const rows = [];
  let count = 0;
  for (const cid of Object.keys(grouped)) {
    for (const info of grouped[cid]) {
      if (count >= 24) break;
      const btn = new ButtonBuilder()
        .setCustomId(buildCheckoutButtonCustomId(guild.id, info.member.id))
        .setLabel(`${info.member.displayName} (${info.minutes} min)`)
        .setStyle(ButtonStyle.Primary);
      rows.push(btn);
      count++;
    }
    if (count >= 24) break;
  }

  const refreshBtn = new ButtonBuilder()
    .setCustomId(buildRefreshButtonCustomId(authorMember.id))
    .setLabel('♻️ Atualizar Painel')
    .setStyle(ButtonStyle.Secondary);

  // organizar em ActionRows (máx 5 botões por linha, máx 5 linhas)
  const actionRows = [];
  const allBtns = [...rows, refreshBtn];
  for (let i=0; i<allBtns.length; i += 5) {
    actionRows.push(new ActionRowBuilder().addComponents(...allBtns.slice(i, i+5)));
    if (actionRows.length >= 5) break;
  }

  await channel.send({ content, components: actionRows });
}

// ===== Voice events (check-in/out)

client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
  try {
    const guild = newS.guild ?? oldS.guild;
    if (!guild) return;

    const beforeCh = oldS.channelId ?? null;
    const afterCh  = newS.channelId ?? null;

    const beforeTracked = beforeCh ? await isTracked(guild.id, beforeCh) : false;
    const afterTracked  = afterCh ? await isTracked(guild.id, afterCh) : false;

    const member = newS.member ?? oldS.member;
    if (!member || member.user?.bot) return;

    const event = getActiveEvent(guild.id);
    if (event) {
      if (beforeCh !== event.channel_id && afterCh === event.channel_id) {
        await startEventParticipation(event, member);
      } else if (beforeCh === event.channel_id && afterCh !== event.channel_id) {
        await stopParticipationForMember(event, member);
      }
    }

    const row = await getOpenSession(guild.id, member.id);

    // moveu entre salas rastreadas
    if (beforeTracked && afterTracked && beforeCh !== afterCh) {
      if (row) await finishSession(row.id, nowISO());
      await startSession(guild.id, member, afterCh);
      await sendLog(guild, `🔁 **Troca de sala**: ${member} de <#${beforeCh}> para <#${afterCh}>`);
      await trySendCheckoutNotification(member);

      return;
    }
    // entrou numa sala rastreada
    if (!beforeTracked && afterTracked) {
      if (row) await finishSession(row.id, nowISO());
      await startSession(guild.id, member, afterCh);
      await sendLog(guild, `🟢 **Check-in**: ${member} em <#${afterCh}>`);
      await trySendCheckoutNotification(member);

      return;
    }
    // saiu de sala rastreada
    if (beforeTracked && !afterTracked) {
      if (row) {
        await finishSession(row.id, nowISO());
        await sendLog(guild, `🔴 **Saída**: ${member} de <#${beforeCh}>`);
      }
      return;
    }
  } catch (e) {
    console.error('Erro em VoiceStateUpdate:', e);
  }
});

// ===== Interactions (slash + botões)

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Botões
    if (interaction.isButton()) {
      const id = interaction.customId;

      // Checkout button: checkout:<guildId>:<userId>
      if (id.startsWith('checkout:')) {
        const [, gId, uId] = id.split(':');
        if (interaction.user.id !== uId) {
          await interaction.reply({ content: '❌ Este botão não é para você.', ephemeral: true });
          return;
        }
        const row = await getOpenSession(gId, uId);
        if (!row) {
          await interaction.reply({ content: 'ℹ️ Você não tem um check-in aberto.', ephemeral: true });
          return;
        }
        const elapsed = elapsedMinutes(row);
        if (elapsed < CHECKOUT_MINUTES_REQUIRED) {
          await interaction.reply({ content: `⏳ Ainda não deu 1 hora do seu check-in. Faltam **${CHECKOUT_MINUTES_REQUIRED - elapsed} min**.`, ephemeral: true });
          return;
        }
        await finishSession(row.id, nowISO());
        await interaction.reply({ content: '✅ **Checkout concluído!** Sua presença foi contabilizada. 🙌', ephemeral: true });
        return;
      }

      // Refresh panel: refresh_panel:<authorId>
      if (id.startsWith('refresh_panel:')) {
        const [, authorId] = id.split(':');
        const isAuthor = interaction.user.id === authorId;
        const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAuthor && !isAdmin) {
          await interaction.reply({ content: '⚠️ Somente o autor ou admins podem atualizar.', ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        if (interaction.channel?.type === ChannelType.GuildText) {
          await postCheckoutPanel(interaction.channel, interaction.guild, interaction.member);
          await interaction.editReply('🔄 Painel atualizado!');
        } else {
          await interaction.editReply('❌ Não consegui atualizar aqui.');
        }
        return;
      }
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;

    if (name === 'add_sala_voz') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '❌ Você precisa da permissão **Gerenciar Servidor**.', ephemeral: true });
        return;
      }
      const ch = interaction.options.getChannel('canal', true);
      if (ch.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ Selecione um canal de **voz**.', ephemeral: true });
        return;
      }
      await addTracked(interaction.guildId, ch.id);
      await interaction.reply({ content: `✅ Sala adicionada: <#${ch.id}>`, ephemeral: true });
      return;
    }

    if (name === 'rem_sala_voz') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '❌ Você precisa da permissão **Gerenciar Servidor**.', ephemeral: true });
        return;
      }
      const ch = interaction.options.getChannel('canal', true);
      if (ch.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ Selecione um canal de **voz**.', ephemeral: true });
        return;
      }
      await remTracked(interaction.guildId, ch.id);
      await interaction.reply({ content: `🗑️ Sala removida: <#${ch.id}>`, ephemeral: true });
      return;
    }

    if (name === 'canais_alvo') {
      const ids = await listTrackedIds(interaction.guildId);
      if (!ids.size) {
        await interaction.reply({ content: 'ℹ️ Nenhuma sala rastreada.', ephemeral: true });
        return;
      }

      const linhas = [];
      for (const id of ids) {
        let canal = interaction.guild.channels.cache.get(id);
        if (!canal) {
          try {
            canal = await interaction.guild.channels.fetch(id);
          } catch (err) {
            console.error(`Falha ao buscar canal ${id} listado em /canais_alvo`, err);
          }
        }
        if (canal && canal.type === ChannelType.GuildVoice) {
          linhas.push(`• 🎧 ${canal.name}`);
        } else {
          linhas.push(`• ❓ desconhecido (ID: ${id})`);
        }
      }

      await interaction.reply({
        content: `🎯 **Salas rastreadas:**\n${linhas.join('\n')}`,
        ephemeral: true
      });
      return;
    }

    if (name === 'status') {
      const row = await getOpenSession(interaction.guildId, interaction.user.id);
      if (!row) {
        await interaction.reply({ content: 'ℹ️ Você não tem um check-in aberto.', ephemeral: true });
        return;
      }
      const elapsed = elapsedMinutes(row);
      const started = toDT(row.checkin_at).toFormat('dd/LL HH:mm');
      const components = [ makeCheckoutRowForUser(interaction.guildId, interaction.user.id) ];
      await interaction.reply({
        content: `🕒 Check-in desde **${started}** — **${elapsed} min** decorridos.\nUse o botão abaixo quando completar 1 hora.`,
        components,
        ephemeral: true
      });
      return;
    }

    if (name === 'checkout') {
      const row = await getOpenSession(interaction.guildId, interaction.user.id);
      if (!row) {
        await interaction.reply({ content: '⚠️ Você não tem um check-in aberto em salas rastreadas.', ephemeral: true });
        return;
      }
      const elapsed = elapsedMinutes(row);
      if (elapsed < 60) {
        await interaction.reply({ content: `⏳ Ainda não deu 1 hora do seu check-in. Faltam **${60 - elapsed} min**.`, ephemeral: true });
        return;
      }
      await finishSession(row.id, nowISO());
      await interaction.reply({ content: '✅ **Checkout concluído!** Sua presença foi contabilizada. 🙌', ephemeral: true });
      return;
    }

    if (name === 'relatorio') {
      const inicio = interaction.options.getString('inicio', true);
      const fim = interaction.options.getString('fim', true);
      const parse = (s) => DateTime.fromFormat(s, 'dd/LL/yyyy', { zone: TIMEZONE });
      const start = parse(inicio);
      const end = parse(fim).endOf('day');
      if (!start.isValid || !end.isValid) {
        await interaction.reply({ content: '❌ Formato de data inválido. Use **dd/mm/aaaa**.', ephemeral: true });
        return;
      }
      const rows = await db.all(
        `SELECT user_name, user_id, channel_id, checkin_at, checkout_at, duration_minutes
         FROM sessions
         WHERE guild_id=?
           AND datetime(checkin_at) >= datetime(?)
           AND datetime(COALESCE(checkout_at, checkin_at)) <= datetime(?)
         ORDER BY checkin_at ASC`,
        [interaction.guildId, start.toISO(), end.toISO()]
      );
      if (!rows.length) {
        await interaction.reply({ content: `📭 Sem registros entre **${inicio}** e **${fim}**.`, ephemeral: true });
        return;
      }
      const lines = rows.slice(0, 50).map(r => {
        const ci = toDT(r.checkin_at).toFormat('dd/LL HH:mm');
        const co = r.checkout_at ? toDT(r.checkout_at).toFormat('dd/LL HH:mm') : '—';
        const dur = (r.duration_minutes ?? '—') + (r.duration_minutes != null ? ' min' : '');
        return `• **${r.user_name}** — Sala: <#${r.channel_id}> | In: ${ci} | Out: ${co} | Dur: ${dur}`;
      });
      let msg = `📒 **Participações** (${inicio} → ${fim})\n${lines.join('\n')}`;
      if (rows.length > 50) msg += `\n… e mais ${rows.length - 50} linhas.`;
      await interaction.reply({ content: msg, ephemeral: true });
      return;
    }

    if (name === 'exportar_csv') {
      const inicio = interaction.options.getString('inicio', true);
      const fim = interaction.options.getString('fim', true);
      const parse = (s) => DateTime.fromFormat(s, 'dd/LL/yyyy', { zone: TIMEZONE });
      const start = parse(inicio);
      const end = parse(fim).endOf('day');
      if (!start.isValid || !end.isValid) {
        await interaction.reply({ content: '❌ Formato de data inválido. Use **dd/mm/aaaa**.', ephemeral: true });
        return;
      }
      const rows = await db.all(
        `SELECT user_name, user_id, channel_id, checkin_at, checkout_at, duration_minutes
         FROM sessions
         WHERE guild_id=?
           AND datetime(checkin_at) >= datetime(?)
           AND datetime(COALESCE(checkout_at, checkin_at)) <= datetime(?)
         ORDER BY checkin_at ASC`,
        [interaction.guildId, start.toISO(), end.toISO()]
      );
      if (!rows.length) {
        await interaction.reply({ content: `📭 Sem registros entre **${inicio}** e **${fim}**.`, ephemeral: true });
        return;
      }
      const header = ['user_name','user_id','channel_id','checkin_at_iso','checkout_at_iso','duration_minutes'];
      const csvLines = [
        header.join(',')
      ];
      for (const r of rows) {
        const row = [
          `"${String(r.user_name).replace(/"/g, '""')}"`,
          r.user_id,
          r.channel_id,
          r.checkin_at ?? '',
          r.checkout_at ?? '',
          (r.duration_minutes ?? '')
        ];
        csvLines.push(row.join(','));
      }
      const buffer = Buffer.from(csvLines.join('\n'), 'utf-8');
      const file = new AttachmentBuilder(buffer, { name: `relatorio_${inicio}_a_${fim}.csv` });
      await interaction.reply({ content: '📎 Aqui está o CSV:', files: [file], ephemeral: true });
      return;
    }

    if (name === 'painel_checkout') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '❌ Você precisa da permissão **Gerenciar Servidor**.', ephemeral: true });
        return;
      }
      const canal = interaction.options.getChannel('canal') ?? interaction.channel;
      if (canal.type !== ChannelType.GuildText) {
        await interaction.reply({ content: '❌ Informe um canal de **texto** válido.', ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      await postCheckoutPanel(canal, interaction.guild, interaction.member);
      await interaction.editReply(`✅ Painel postado em ${canal}.`);
      return;
    }

    if (name === 'evento_iniciar') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '❌ Você precisa da permissão **Gerenciar Servidor**.', ephemeral: true });
        return;
      }
      const canal = interaction.options.getChannel('sala', true);
      if (canal.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ Escolha uma sala de **voz** válida.', ephemeral: true });
        return;
      }
      const nome = interaction.options.getString('nome', true).trim();
      const duracao = interaction.options.getInteger('duracao_min', true);
      if (!nome.length) {
        await interaction.reply({ content: '❌ Informe um nome para o evento.', ephemeral: true });
        return;
      }
      if (duracao <= 0) {
        await interaction.reply({ content: '❌ A duração deve ser um número positivo de minutos.', ephemeral: true });
        return;
      }
      if (getActiveEvent(interaction.guildId)) {
        await interaction.reply({ content: '⚠️ Já existe um evento ativo. Encerre-o antes de iniciar outro.', ephemeral: true });
        return;
      }
      const evento = await createEvent(interaction.guildId, canal.id, nome, duracao);
      await bootstrapEventParticipants(evento, interaction.guild);
      await interaction.reply({
        content: `🎉 Evento **${nome}** iniciado!\n• ID: **${evento.id}**\n• Sala: <#${evento.channel_id}>\n• Termina em: ${formatEventTimeLeft(evento)}`,
        ephemeral: true
      });
      await sendLog(interaction.guild, `🟢 **Evento iniciado** (${evento.id}): ${nome} em <#${canal.id}>`);
      return;
    }

    if (name === 'evento_status') {
      const evento = getActiveEvent(interaction.guildId);
      if (!evento) {
        await interaction.reply({ content: 'ℹ️ Nenhum evento ativo no momento.', ephemeral: true });
        return;
      }
      const inicio = toDT(evento.started_at).toFormat('dd/LL HH:mm');
      await interaction.reply({
        content: `📊 **Evento ativo:** ${evento.name} (ID ${evento.id})\n• Sala: <#${evento.channel_id}>\n• Início: ${inicio}\n• Tempo restante: ${formatEventTimeLeft(evento)}`,
        ephemeral: true
      });
      return;
    }

    if (name === 'evento_parar') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: '❌ Você precisa da permissão **Gerenciar Servidor**.', ephemeral: true });
        return;
      }
      const evento = getActiveEvent(interaction.guildId);
      if (!evento) {
        await interaction.reply({ content: 'ℹ️ Não há evento ativo para encerrar.', ephemeral: true });
        return;
      }
      const finished = await stopActiveEvent(interaction.guildId);
      let files;
      let docData;
      let extraLine = '';
      if (finished) {
        docData = await generateEventDocData(finished);
        files = [new AttachmentBuilder(docData.buffer, { name: docData.filename })];
        extraLine = docData.participantCount
          ? '\n📄 Relatório anexado.'
          : '\n📄 Relatório anexado (sem participações registradas).';
      }
      await interaction.reply({
        content: `⏹️ Evento **${evento.name}** (ID ${evento.id}) encerrado.${extraLine}`,
        files,
        ephemeral: true
      });
      await sendLog(interaction.guild, `⏹️ **Evento encerrado** (${evento.id}): ${evento.name}`);
      if (finished) {
        await sendEventDocToOwner(interaction.guild, finished, docData, interaction.user.id);
      }
      return;
    }

    if (name === 'evento_relatorio') {
      const requestedId = interaction.options.getInteger('id');
      let evento;
      if (requestedId != null) {
        evento = await db.get(`SELECT * FROM events WHERE id=? AND guild_id=?`, [requestedId, guildKey(interaction.guildId)]);
        if (!evento) {
          await interaction.reply({ content: `❌ Evento com ID **${requestedId}** não encontrado.`, ephemeral: true });
          return;
        }
      } else {
        evento = getActiveEvent(interaction.guildId);
        if (!evento) {
          await interaction.reply({ content: 'ℹ️ Nenhum evento ativo. Informe o ID de um evento finalizado.', ephemeral: true });
          return;
        }
      }

      const report = await buildEventReport(evento.id, !evento.ended_at);
      if (!report.length) {
        await interaction.reply({ content: '📭 Nenhuma participação registrada para este evento.', ephemeral: true });
        return;
      }
      const inicio = toDT(evento.started_at).toFormat('dd/LL HH:mm');
      const fim = (evento.ended_at ? toDT(evento.ended_at) : DateTime.fromISO(evento.expected_end_at, { zone: TIMEZONE })).toFormat('dd/LL HH:mm');
      const status = evento.ended_at ? 'Encerrado' : 'Em andamento';
      const linhas = report.slice(0, 25).map((item, idx) => `• ${idx + 1}. **${item.name}** — ${item.minutes} min`);
      if (report.length > 25) {
        linhas.push(`… e mais ${report.length - 25} participantes.`);
      }
      await interaction.reply({
        content: `📝 **Relatório do evento** ${evento.name} (ID ${evento.id})\n• Status: ${status}\n• Sala: <#${evento.channel_id}>\n• Início: ${inicio}\n• Fim previsto/real: ${fim}\n\n${linhas.join('\n')}`,
        ephemeral: true
      });
      return;
    }

  } catch (e) {
    console.error('Erro em InteractionCreate:', e);
    try { await interaction.reply({ content: '⚠️ Ocorreu um erro.', ephemeral: true }); } catch {}
  }
});

// ===== Ready
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logado como ${c.user.tag} (${c.user.id})`);
  try {
    await restoreActiveEvents(c);
  } catch (err) {
    console.error('Falha ao restaurar eventos ativos:', err);
  }
});

// ===== Start
await initDb();
client.login(DISCORD_TOKEN);
