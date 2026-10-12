'use strict';

require('dotenv').config();

const { REST, Routes } = require('discord.js');

const fs = require('node:fs');
const path = require('node:path');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const C = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    gray: '\x1b[90m',
    bold: '\x1b[1m'
};

function log(text) {
    console.log(`${C.cyan}  [TRE]${C.reset} ${text}`);
}

async function loading(text) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    for (let i = 0; i < 15; i++) {
        process.stdout.write(
            `\r${C.cyan}  ${frames[i % frames.length]} ${text}${C.reset}   `
        );
        await sleep(80);
    }

    process.stdout.write('\r');
}

function coletarComandos() {
    if (!fs.existsSync(commandsPath)) {
        throw new Error(`Pasta de comandos não encontrada: ${commandsPath}`);
    }

    const files = fs
        .readdirSync(commandsPath)
        .filter(file => file.endsWith('.js'));

    for (const file of files) {
        const command = require(path.join(commandsPath, file));

        if (!command.data || typeof command.execute !== 'function') {
            log(`${C.yellow}IGNORADO${C.reset} ${file} (formato inválido)`);
            continue;
        }

        commands.push(command.data.toJSON());
        log(`${C.green}✓${C.reset} Comando detectado: ${command.data.name}`);
    }

    return files.length;
}

async function main() {
    console.clear();

    console.log(`${C.red}${C.bold}
  ████████╗██████╗ ███████╗
  ╚══██╔══╝██╔══██╗██╔════╝
     ██║   ██████╔╝█████╗
     ██║   ██╔══██╗██╔══╝
     ██║   ██║  ██║███████╗
     ╚═╝   ╚═╝  ╚═╝╚══════╝
${C.reset}`);

    console.log(`${C.gray}  ┌────────────────────────────────────┐
  │       TRE BOT • COMMAND DEPLOY      │
  └────────────────────────────────────┘${C.reset}\n`);

    const token = process.env.TOKEN;
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.GUILD_ID; // Opcional: deploy no servidor de teste

    if (!token || !clientId) {
        throw new Error('Defina TOKEN e CLIENT_ID no arquivo .env.');
    }

    log(`${C.yellow}Inicializando sistema de deploy...${C.reset}`);
    await loading('Verificando arquivos');

    coletarComandos();

    console.log();

    const rest = new REST({ version: '10' }).setToken(token);

    await loading('Conectando à API do Discord');
    log(`${C.green}✓${C.reset} API preparada`);

    await loading(`Registrando ${commands.length} comandos`);

    const route = guildId
        ? Routes.applicationGuildCommands(clientId, guildId)
        : Routes.applicationCommands(clientId);

    await rest.put(route, { body: commands });

    console.log();
    console.log(`${C.green}${C.bold}
  ╔════════════════════════════════════╗
  ║        DEPLOY CONCLUÍDO! ✓         ║
  ╚════════════════════════════════════╝${C.reset}`);

    log(`Comandos registrados: ${C.green}${commands.length}${C.reset}`);
    log(`Escopo: ${guildId ? 'Servidor de teste' : 'Global'}`);
    log(`${C.gray}TRE BOT • Sistema eleitoral iniciado.${C.reset}\n`);
}

main().catch(error => {
    console.error(`\n${C.red}${C.bold}  ✖ FALHA NO DEPLOY${C.reset}`);
    console.error(`  ${C.red}${error.message}${C.reset}`);
    process.exitCode = 1;
});
