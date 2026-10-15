'use strict';

const { ROTAS_ADMIN } = require('../web/admin');

const USE_COLOR = Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined);
const RESET = USE_COLOR ? '\x1b[0m' : '';
const CYAN = USE_COLOR ? '\x1b[36m' : '';
const BLUE = USE_COLOR ? '\x1b[34m' : '';
const GREEN = USE_COLOR ? '\x1b[32m' : '';
const YELLOW = USE_COLOR ? '\x1b[33m' : '';
const GRAY = USE_COLOR ? '\x1b[90m' : '';
const BOLD = USE_COLOR ? '\x1b[1m' : '';
const BOX_WIDTH = 78;
const BOX_BORDER = `+${'-'.repeat(BOX_WIDTH - 2)}+`;

function titleRow(text) {
    const content = ` ${text}`;
    return `|${content}${' '.repeat(BOX_WIDTH - content.length - 3)} |`;
}

const LOGO = [
    ' _______  ______   ______  ____   ______',
    '|__   __||  ____| |  ____|/ __ \\ |  _  \\',
    '   | |   | |__    | |__  | |  | || |_) |',
    '   | |   |  __|   |  __| | |  | ||  _ <',
    '   | |   | |____  | |    | |__| || |_) |',
    '   |_|   |______| |_|     \\____/ |____/',
    '                 SISTEMA ELEITORAL'
];

const SPINNERS = ['[    ]', '[=   ]', '[==  ]', '[=== ]', '[ ===]', '[  ==]', '[   =]', '[    ]'];

function pause(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function animarInicializacao({
    write = text => process.stdout.write(text),
    isTTY = Boolean(process.stdout.isTTY && process.env.TERM !== 'dumb'),
    delay = pause
} = {}) {
    if (!isTTY) {
        write(`${LOGO.join('\n')}\n`);
        return;
    }

    write('\x1b[2J\x1b[H');
    for (let index = 0; index < SPINNERS.length; index++) {
        const color = index % 2 === 0 ? CYAN : BLUE;
        write(
            `\x1b[H\x1b[J${color}${BOLD}${LOGO.join('\n')}${RESET}\n\n` +
                `${YELLOW}${SPINNERS[index]}${RESET}  ` +
                `${GRAY}inicializando sistema eleitoral${RESET}`
        );
        await delay(85);
    }
    write('\x1b[0m\n');
}

function compact(value, maxLength = 52) {
    const text = String(value ?? '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
}

function renderDashboard({
    client,
    database,
    version,
    uptimeSeconds = process.uptime(),
    write = text => process.stdout.write(text)
}) {
    const seconds = Math.floor(uptimeSeconds);
    const uptime = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
    const guildCount = client.guilds.cache.size;
    const commandCount = client.commands.size;
    const databasePath = process.env.DB_PATH || 'src/database/partidos.db';
    const panel = client.adminPanel;
    const panelReady = Boolean(panel?.server?.listening);
    const panelAddress = panel?.server?.address();
    const displayHost =
        ['0.0.0.0', '127.0.0.1', '::1'].includes(panel?.host)
            ? 'localhost'
            : panel?.host;
    const panelUrl = panelReady
        ? `http://${displayHost}:${panelAddress.port}`
        : null;
    const lines = [];
    const addLine = (label, value, color = GREEN) =>
        lines.push(`  ${CYAN}${label.padEnd(16)}${RESET} ${color}${value}${RESET}`);

    lines.push(
        '',
        `${CYAN}${BOLD}${BOX_BORDER}${RESET}`,
        `${CYAN}${BOLD}${titleRow('TRE BOT • painel eleitoral')}${RESET}`,
        `${CYAN}${BOLD}${BOX_BORDER}${RESET}`
    );
    addLine('Bot', client.user?.tag ?? client.user?.username ?? 'conectando');
    addLine('Discord', `${guildCount} servidor(es) conectados`);
    addLine('Comandos', `${commandCount} slash command(s) carregados`);
    addLine('Versao', version);
    addLine('Node.js', process.version);
    addLine('Uptime', uptime);
    addLine('Banco local', compact(databasePath));
    lines.push(`${CYAN}  ${'-'.repeat(55)}${RESET}`);

    if (panelReady) {
        addLine('Painel web', `${panelUrl}  [ONLINE]`);
        addLine('Interface', `${panel.host}:${panelAddress.port}`);
        addLine(
            'Protecao',
            `senha + sessao${panel.cookieSecure ? ' + cookie Secure' : ''}`,
            GREEN
        );
        if (panel.host === '0.0.0.0' || panel.host === '::') {
            addLine(
                'Aviso',
                'escuta em todas as interfaces; proteja com HTTPS/firewall',
                YELLOW
            );
        }
        lines.push(
            `${BOLD}  ROTAS HTTP${RESET} ${GRAY}(rotas nao listadas retornam 404)${RESET}`
        );
        for (const route of ROTAS_ADMIN) {
            const endpoint = `${route.method.padEnd(4)} ${route.path}`;
            lines.push(
                `  ${YELLOW}${endpoint.padEnd(22)}${RESET}[${route.access}] ${GRAY}${route.description}${RESET}`
            );
        }
    } else if (panel?.error) {
        addLine('Painel web', 'FALHA ao abrir a porta', YELLOW);
        addLine('Detalhe', compact(panel.error.message), YELLOW);
    } else {
        addLine(
            'Painel web',
            panel ? 'iniciando...' : 'desativado (ADMIN_PASSWORD ausente)',
            YELLOW
        );
        if (panel) {
            lines.push(
                `${BOLD}  ROTAS CONFIGURADAS${RESET} ${GRAY}(disponiveis quando a porta abrir)${RESET}`
            );
            for (const route of ROTAS_ADMIN) {
                lines.push(
                    `  ${YELLOW}${`${route.method.padEnd(4)} ${route.path}`.padEnd(22)}${RESET}[${route.access}] ${GRAY}${route.description}${RESET}`
                );
            }
        }
    }

    lines.push(
        `${CYAN}${BOLD}${BOX_BORDER}${RESET}`,
        `${GRAY}  Ctrl+C para encerrar${RESET}`,
        ''
    );
    write(lines.join('\n'));
}

module.exports = { animarInicializacao, renderDashboard };
