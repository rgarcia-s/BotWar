import 'dotenv/config';
import { REST, Routes, ApplicationCommandOptionType, ChannelType } from 'discord.js';

const {
  DISCORD_TOKEN,
  GUILD_ID
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN no .env');
  process.exit(1);
}

const commands = [
  {
    name: 'add_sala_voz',
    description: 'Adicionar sala de VOZ para rastrear presenças.',
    default_member_permissions: '0', // só admin (vamos validar no código também)
    options: [
      {
        name: 'canal',
        description: 'Selecione o canal de voz',
        type: ApplicationCommandOptionType.Channel,
        channel_types: [ChannelType.GuildVoice],
        required: true
      }
    ]
  },
  
  {
    name: 'rem_sala_voz',
    description: 'Remover sala de VOZ das rastreadas.',
    default_member_permissions: '0',
    options: [
      {
        name: 'canal',
        description: 'Selecione o canal de voz',
        type: ApplicationCommandOptionType.Channel,
        channel_types: [ChannelType.GuildVoice],
        required: true
      }
    ]
  },
  {
    name: 'canais_alvo',
    description: 'Lista todas as salas de VOZ rastreadas neste servidor.'
  },
  {
    name: 'status',
    description: 'Veja há quanto tempo seu check-in está ativo (com botão).'
  },
  {
    name: 'checkout',
    description: '(Opcional) Finaliza sua presença se já deu 1h.'
  },
  {
    name: 'relatorio',
    description: 'Lista participações por período (formato: dd/mm/aaaa).',
    options: [
      { name: 'inicio', description: 'Data inicial (dd/mm/aaaa)', type: ApplicationCommandOptionType.String, required: true },
      { name: 'fim', description: 'Data final (dd/mm/aaaa)', type: ApplicationCommandOptionType.String, required: true }
    ]
  },
  {
    name: 'exportar_csv',
    description: 'Exporta CSV do período (dd/mm/aaaa).',
    options: [
      { name: 'inicio', description: 'Data inicial (dd/mm/aaaa)', type: ApplicationCommandOptionType.String, required: true },
      { name: 'fim', description: 'Data final (dd/mm/aaaa)', type: ApplicationCommandOptionType.String, required: true }
    ]
  },
  {
    name: 'painel_checkout',
    description: '(Admin) Cria um painel de checkout agrupado por sala rastreada.',
    default_member_permissions: '0',
    options: [
      {
        name: 'canal',
        description: 'Canal de texto onde postar o painel (opcional)',
        type: ApplicationCommandOptionType.Channel,
        channel_types: [ChannelType.GuildText],
        required: false
      }
    ]
  },
  {
  name: 'evento_iniciar',
  description: '(Admin) Inicia um evento e conta tempo até o fim.',
  default_member_permissions: '0',
  options: [
    { name: 'nome', description: 'Nome do evento', type: 3, required: true },
    { name: 'duracao_min', description: 'Duração em minutos', type: 4, required: true }
  ]
},
{
  name: 'evento_status',
  description: 'Mostra o evento ativo (se houver).'
},
{
  name: 'evento_parar',
  description: '(Admin) Encerra o evento ativo agora.',
  default_member_permissions: '0'
},
{
  name: 'evento_relatorio',
  description: 'Relatório apenas do evento ativo ou de um evento finalizado.',
  options: [
    { name: 'id', description: 'ID do evento (opcional). Se vazio, usa o ativo.', type: 4, required: false }
  ]
}

];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function run() {
  try {
    if (GUILD_ID) {
      // Registro por GUILD (rápido)
      const data = await rest.put(
        Routes.applicationGuildCommands((await rest.get(Routes.oauth2CurrentApplication())).id, GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Registrados ${data.length} comandos no guild ${GUILD_ID}`);
    } else {
      // Registro global (pode demorar a aparecer)
      const app = await rest.get(Routes.oauth2CurrentApplication());
      const data = await rest.put(
        Routes.applicationCommands(app.id),
        { body: commands }
      );
      console.log(`✅ Registrados ${data.length} comandos globais`);
    }
  } catch (err) {
    console.error('Erro registrando comandos:', err);
    process.exit(1);
  }
}

run();
