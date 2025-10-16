# BotWar – Bot de Check-in para Discord

Este repositório contém um bot do Discord que acompanha a presença em canais de voz, permite que membros finalizem o check-in e gera relatórios. Siga as etapas abaixo para configurá-lo no seu próprio servidor.

## 1. Pré-requisitos
- Node.js 18 ou superior (exigido pelo discord.js v14).
- Uma conta Discord com permissão para criar aplicações e gerenciar comandos *slash*.

## 2. Crie e configure a aplicação no Discord
1. Acesse o [Discord Developer Portal](https://discord.com/developers/applications) e crie uma **New Application**.
2. Adicione um usuário **Bot** à aplicação e copie o **token**. Guarde-o em segredo.
3. Em **Privileged Gateway Intents**, habilite **Server Members Intent** e **Presence Intent**. Eventos de voz também exigem os intents **Guilds** e **Guild Voice States**, que já vêm ativos por padrão.
4. Use **OAuth2 → URL Generator** para criar um link de convite com os escopos `bot` e `applications.commands`, concedendo a permissão `Manage Guild`. Utilize a URL gerada para convidar o bot ao seu servidor.

## 3. Configure as variáveis de ambiente
Crie um arquivo `.env` na raiz do projeto com as variáveis abaixo:

```env
DISCORD_TOKEN=your_bot_token_here
GUILD_ID=optional_guild_id_for_fast_command_registration
LOG_CHANNEL_ID=optional_text_channel_id_for_logs
TIMEZONE=America/Sao_Paulo
```

- `DISCORD_TOKEN` é obrigatório tanto para o bot (`index.js`) quanto para o script de registro de comandos (`register-commands.js`).【F:index.js†L9-L17】【F:register-commands.js†L5-L13】
- `GUILD_ID` (opcional) limita o registro dos comandos *slash* a um único servidor e faz com que novos comandos apareçam imediatamente.【F:register-commands.js†L69-L88】
- `LOG_CHANNEL_ID` (opcional) permite que o bot envie logs de entrada/saída para um canal de texto.【F:index.js†L94-L105】
- `TIMEZONE` ajusta os carimbos de data ao salvar check-ins; se omitido, o padrão é `America/Sao_Paulo`.【F:index.js†L9-L43】

## 4. Instale as dependências
```bash
npm install
```

## 5. Registre os comandos *slash*
Execute o script de registro uma vez (e sempre que alterar a lista de comandos):
```bash
npm run register-commands
```
Se `GUILD_ID` estiver definido, os comandos são registrados imediatamente para esse servidor; caso contrário, tornam-se globais e podem levar até uma hora para aparecer.【F:register-commands.js†L69-L90】

## 6. Inicie o bot
```bash
npm start
```
O bot inicializa o banco SQLite (`presencas.db`) e realiza o login com o token configurado.【F:index.js†L49-L67】【F:index.js†L389-L394】

## 7. Gerencie os canais de voz monitorados
Use os comandos *slash* para administrar os canais monitorados e os check-ins:
- `/add_sala_voz` – adiciona um canal de voz à lista monitorada (requer *Manage Server*).【F:register-commands.js†L14-L36】【F:index.js†L353-L375】
- `/rem_sala_voz` – remove um canal de voz da monitoração.【F:register-commands.js†L26-L37】【F:index.js†L377-L394】
- `/canais_alvo` – lista os canais monitorados.【F:register-commands.js†L38-L41】【F:index.js†L396-L427】
- `/painel_checkout` – publica um painel de checkout em um canal de texto (apenas administradores).【F:register-commands.js†L58-L68】【F:index.js†L494-L523】
- Membros podem ver seu status com `/status` e finalizar o check-in pelo botão em DM ou pelo comando `/checkout`.【F:register-commands.js†L42-L55】【F:index.js†L429-L470】

Comandos adicionais permitem que administradores gerem relatórios de presença, exportem CSVs e administrem eventos temporários (`/evento_*`).【F:register-commands.js†L70-L113】【F:index.js†L470-L523】

## 8. Localização do banco de dados
Os dados de presença são armazenados no arquivo SQLite `presencas.db`, localizado na raiz do projeto. Faça backup antes de reimplantar o bot.【F:index.js†L49-L87】

Com essas etapas concluídas, o bot estará ativo no seu servidor Discord e pronto para gerenciar a presença nos canais de voz.
