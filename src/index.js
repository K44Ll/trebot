'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
    ChannelType,
    Client,
    GatewayIntentBits,
    Collection
} = require('discord.js');

require('dotenv').config();

const database = require('./database');
const databaseEleicoes = require('./database/eleicoes');
const { iniciarPainel } = require('./web/admin');
const { animarInicializacao } = require('./ui/console');

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.animacaoInicializacao = animarInicializacao();
client.adminPanel = null;

client.commands = new Collection();
// customId -> handler, montado a partir de `componentHandlers` de cada comando.
client.componentHandlers = new Collection();

// __dirname já é a pasta src/, então os caminhos são relativos a ela.
const commandsPath = path.join(__dirname, 'commands');
const eventsPath = path.join(__dirname, 'events');

function carregarComandos() {
    if (!fs.existsSync(commandsPath)) {
        console.warn(`[AVISO] Pasta de comandos não encontrada: ${commandsPath}`);
        return;
    }

    const commandFiles = fs
        .readdirSync(commandsPath)
        .filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);

        let command;
        try {
            command = require(filePath);
        } catch (error) {
            console.error(`[ERRO] Falha ao carregar ${file}:`, error);
            continue;
        }

        if (!command.data || typeof command.execute !== 'function') {
            console.warn(`[AVISO] ${file} não possui data ou execute.`);
            continue;
        }

        client.commands.set(command.data.name, command);
        console.log(`[COMANDO] ${command.data.name}`);

        for (const [customId, handler] of Object.entries(
            command.componentHandlers ?? {}
        )) {
            if (typeof handler !== 'function') {
                console.warn(
                    `[AVISO] Handler inválido para "${customId}" em ${file}.`
                );
                continue;
            }

            if (client.componentHandlers.has(customId)) {
                console.warn(`[AVISO] customId duplicado: ${customId} (${file})`);
            }

            client.componentHandlers.set(customId, handler);
        }
    }
}

function carregarEventos() {
    if (!fs.existsSync(eventsPath)) {
        console.warn(`[AVISO] Pasta de eventos não encontrada: ${eventsPath}`);
        return;
    }

    const eventFiles = fs
        .readdirSync(eventsPath)
        .filter(file => file.endsWith('.js'));

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);

        let event;
        try {
            event = require(filePath);
        } catch (error) {
            console.error(`[ERRO] Falha ao carregar ${file}:`, error);
            continue;
        }

        if (!event.name || typeof event.execute !== 'function') {
            console.warn(`[AVISO] Evento inválido: ${file}`);
            continue;
        }

        const registrar = event.once
            ? client.once.bind(client)
            : client.on.bind(client);

        registrar(event.name, (...args) => event.execute(...args, client));
        console.log(`[EVENTO] ${event.name}`);
    }
}

carregarComandos();
carregarEventos();

client.on('error', error => console.error('[CLIENT ERROR]', error));

process.on('unhandledRejection', error => {
    console.error('[UNHANDLED REJECTION]', error);
});

const expirados = database.limparRascunhosExpirados();
if (expirados > 0) {
    console.log(`[DB] ${expirados} rascunho(s) expirado(s) removido(s).`);
}

const token = process.env.TOKEN;

if (!token) {
    console.error(
        '[ERRO] TOKEN não definido. Copie .env.example para .env e preencha.'
    );
    process.exit(1);
}

const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
    console.log(
        '[ADMIN PANEL] Desativado. Defina ADMIN_PASSWORD (mínimo de 16 caracteres) para habilitá-lo.'
    );
} else {
    const host = process.env.ADMIN_HOST || '127.0.0.1';
    const port = Number(process.env.ADMIN_PORT || 3000);
    client.adminPanel = {
        host,
        port,
        cookieSecure: process.env.ADMIN_COOKIE_SECURE !== 'false',
        server: null,
        error: null
    };
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error('[ADMIN PANEL] ADMIN_PORT deve ser entre 1 e 65535.');
        client.adminPanel.error = new Error(
            'ADMIN_PORT deve ser entre 1 e 65535.'
        );
    } else {
        try {
            const painel = iniciarPainel({
                password: adminPassword,
                host,
                port,
                cookieSecure: client.adminPanel.cookieSecure,
                publicOrigin: process.env.ADMIN_PUBLIC_ORIGIN,
                database,
                getGuilds: () => client.guilds.cache.values(),
                getTextChannel: async (guildId, channelId) => {
                    const guild = client.guilds.cache.get(guildId);
                    if (!guild) return null;
                    const channel = await guild.channels.fetch(channelId);
                    if (
                        !channel ||
                        channel.guildId !== guildId ||
                        ![
                            ChannelType.GuildText,
                            ChannelType.GuildAnnouncement
                        ].includes(channel.type)
                    ) {
                        return null;
                    }
                    return channel;
                }
            });
            client.adminPanel.server = painel;
            painel.on('error', error => {
                client.adminPanel.error = error;
                console.error('[ADMIN PANEL] Falha ao iniciar o servidor web:', error);
            });
        } catch (error) {
            client.adminPanel.error = error;
            console.error('[ADMIN PANEL] Painel não iniciado:', error.message);
        }
    }
}

client.login(token).catch(error => {
    console.error('[ERRO] Falha ao autenticar com o Discord:', error.message);
    process.exit(1);
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, () => {
        console.log(`\n[${sinal}] Encerrando...`);
        client.adminPanel?.server?.close();
        client.destroy();
        database.fechar();
        databaseEleicoes.fechar();
        process.exit(0);
    });
}

