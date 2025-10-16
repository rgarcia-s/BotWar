import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const APP = await rest.get(Routes.oauth2CurrentApplication());
const guildId = process.env.GUILD_ID;

if (!guildId) {
  const cmds = await rest.get(Routes.applicationCommands(APP.id));
  console.log('Comandos GLOBAIS:', cmds.map(c => c.name));
} else {
  const cmds = await rest.get(Routes.applicationGuildCommands(APP.id, guildId));
  console.log('Comandos no guild', guildId, ':', cmds.map(c => c.name));
}
