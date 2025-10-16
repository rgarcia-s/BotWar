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
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      channel_id INTEGER NOT NULL,
      checkin_at TEXT NOT NULL,
      checkout_at TEXT,
      duration_minutes INTEGER
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      UNIQUE(guild_id, channel_id)
    );
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions (guild_id, user_id, checkout_at);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_tracked_guild ON tracked_channels (guild_id);`);
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
    [guildId, userId]
  );
}
async function startSession(guildId, user, channelId) {
  await db.run(
    `INSERT INTO sessions (guild_id, user_id, user_name, channel_id, checkin_at)
     VALUES (?, ?, ?, ?, ?)`,
    [guildId, user.id, `${user.displayName ?? user.user?.username}#${user.user?.discriminator ?? '0000'}`, channelId, nowISO()]
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



client.on(Events.InteractionCreate, async (interaction) => {
  console.log('Interaction type:', interaction.type, 'command?', interaction.isChatInputCommand() ? interaction.commandName : null);
  // ...resto do código
});




// tracked channels
async function listTrackedIds(guildId) {
  const rows = await db.all(`SELECT channel_id FROM tracked_channels WHERE guild_id=?`, [guildId]);
  return new Set(rows.map(r => r.channel_id));
}
async function isTracked(guildId, channelId) {
  if (!channelId) return false;
  const row = await db.get(`SELECT 1 FROM tracked_channels WHERE guild_id=? AND channel_id=?`, [guildId, channelId]);
  return !!row;
}
async function addTracked(guildId, channelId) {
  await db.run(`INSERT OR IGNORE INTO tracked_channels (guild_id, channel_id) VALUES (?,?)`, [guildId, channelId]);
}
async function remTracked(guildId, channelId) {
  await db.run(`DELETE FROM tracked_channels WHERE guild_id=? AND channel_id=?`, [guildId, channelId]);
}

// logging
async function sendLog(guild, text) {
  const id = Number(LOG_CHANNEL_ID);
  if (!id) return;
  const ch = guild.channels.cache.get(id);
  if (ch && ch.type === ChannelType.GuildText) {
    try { await ch.send(text); } catch {}
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

async function trySendCheckoutDM(member) {
  try {
    const row = makeCheckoutRowForUser(member.guild.id, member.id);
    await member.send({
      content: [
        '👋 **Check-in iniciado!**',
        'Quando completar o tempo necessario, clique abaixo para fazer checkout.',
        '_Se clicar antes, eu aviso quanto tempo falta._'
      ].join('\n'),
      components: [row]
    });
    return true;
  } catch {
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

    const row = await getOpenSession(guild.id, member.id);

    // moveu entre salas rastreadas
    if (beforeTracked && afterTracked && beforeCh !== afterCh) {
      if (row) await finishSession(row.id, nowISO());
      await startSession(guild.id, member, afterCh);
      await sendLog(guild, `🔁 **Troca de sala**: ${member} de <#${beforeCh}> para <#${afterCh}>`);
      await trySendCheckoutDM(member);

      return;
    }
    // entrou numa sala rastreada
    if (!beforeTracked && afterTracked) {
      if (row) await finishSession(row.id, nowISO());
      await startSession(guild.id, member, afterCh);
      await sendLog(guild, `🟢 **Check-in**: ${member} em <#${afterCh}>`);
      await trySendCheckoutDM(member);

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

let linhas = [];
for (const id of ids) {
  let canal = interaction.guild.channels.cache.get(id);
  if (!canal) {
    try {
      canal = await interaction.guild.channels.fetch(id);
    } catch {}
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

  } catch (e) {
    console.error('Erro em InteractionCreate:', e);
    try { await interaction.reply({ content: '⚠️ Ocorreu um erro.', ephemeral: true }); } catch {}
  }
});

// ===== Ready
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logado como ${c.user.tag} (${c.user.id})`);
});

// ===== Start
await initDb();
client.login(DISCORD_TOKEN);
