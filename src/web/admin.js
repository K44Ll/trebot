'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { ChannelType } = require('discord.js');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_BODY_BYTES = 12 * 1024;
const SESSION_COOKIE = 'trebot_admin';
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const ROTAS_ADMIN = [
    { method: 'GET', path: '/login', access: 'público', description: 'formulário de acesso' },
    { method: 'POST', path: '/login', access: 'público + limite de tentativas', description: 'autenticação' },
    { method: 'GET', path: '/', access: 'sessão administrativa', description: 'painel e dados eleitorais' },
    { method: 'POST', path: '/config', access: 'sessão + CSRF', description: 'salvar configurações' },
    { method: 'POST', path: '/logout', access: 'sessão + CSRF', description: 'encerrar sessão' }
];

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => {
        const entities = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return entities[character];
    });
}

function cookieValue(header, name) {
    for (const item of (header ?? '').split(';')) {
        const separator = item.indexOf('=');
        if (separator < 0) continue;
        if (item.slice(0, separator).trim() === name) {
            return item.slice(separator + 1).trim();
        }
    }
    return null;
}

function passwordHash(password) {
    return crypto.createHash('sha256').update(password).digest();
}

function parsePublicOrigin(value) {
    if (!value) return null;
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('ADMIN_PUBLIC_ORIGIN deve ser uma origem HTTP ou HTTPS válida.');
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    ) {
        throw new Error(
            'ADMIN_PUBLIC_ORIGIN deve conter apenas esquema, host e porta, sem caminho.'
        );
    }
    return url.origin;
}

function samePassword(candidate, expectedHash) {
    return crypto.timingSafeEqual(passwordHash(candidate), expectedHash);
}

function serializeForm(body) {
    const form = new URLSearchParams(body);
    return {
        action: form.get('action') ?? '',
        password: form.get('password') ?? '',
        csrf: form.get('csrf') ?? '',
        guildId: form.get('guildId') ?? '',
        canalApoioId: form.get('canalApoioId') ?? '',
        minimoApoios: form.get('minimoApoios') ?? ''
    };
}

function page(title, content) {
    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | TRE BOT</title>
  <style>
    :root{color-scheme:light;--ink:#16233b;--muted:#63718a;--blue:#2457a7;--line:#dce3ed;--paper:#f3f6fb;--white:#fff;--green:#16794a;--amber:#97610a}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
    header{background:#172b4d;color:#fff;padding:20px max(24px,calc((100% - 1120px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px}
    header strong{font-size:18px;letter-spacing:.04em}header span{color:#d7e2f3;font-size:13px}
    main{width:min(1120px,calc(100% - 32px));margin:28px auto 64px}.stack{display:grid;gap:20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
    .card{background:var(--white);border:1px solid var(--line);border-radius:12px;padding:20px;box-shadow:0 4px 18px #16233b0a}
    h1{font-size:25px;margin:0 0 5px}h2{font-size:18px;margin:0 0 14px}.muted,.hint{color:var(--muted)}.hint{font-size:13px;margin:6px 0 0}
    .metric{font-size:28px;font-weight:700}.metric-label{color:var(--muted);font-size:13px}
    form{margin:0}.controls{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.field{display:grid;gap:6px;min-width:180px;flex:1}
    label{font-size:13px;font-weight:650}input,select{font:inherit;color:var(--ink);background:white;border:1px solid #b8c4d4;border-radius:7px;padding:10px 11px;width:100%}
    button{border:0;background:var(--blue);color:white;font:inherit;font-weight:650;border-radius:7px;padding:10px 15px;cursor:pointer}button:hover{filter:brightness(.92)}.secondary{background:#e8edf5;color:var(--ink)}
    .topline{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.topline p{margin:0}
    .table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:650px}th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}td small{display:block;color:var(--muted);margin-top:2px}
    .pill{display:inline-block;border-radius:999px;background:#fff0d2;color:#744900;padding:3px 9px;font-size:12px;font-weight:650}.pill.green{background:#e0f5e9;color:#17633e}
    .bar{height:7px;background:#e8edf5;border-radius:999px;margin-top:7px;overflow:hidden}.bar span{display:block;height:100%;background:#3478d4}
    .alert{border-radius:8px;padding:11px 13px;margin-bottom:16px;background:#fff0d2;color:#744900}.login{width:min(420px,calc(100% - 32px));margin:9vh auto}
    footer{color:var(--muted);font-size:12px;margin-top:22px}
    @media(max-width:600px){header{padding:16px}main{margin-top:18px}.topline{align-items:flex-start;flex-direction:column}.card{padding:16px}}
  </style>
</head>
<body>
  <header><strong>TRE BOT <span>• PAINEL ADMINISTRATIVO</span></strong><span>Sistema eleitoral</span></header>
  ${content}
</body>
</html>`;
}

function loginPage(message = '') {
    return page(
        'Entrar',
        `<main class="login"><section class="card">
          <h1>Painel administrativo</h1>
          <p class="muted">Entre com a senha administrativa configurada no servidor.</p>
          ${message ? `<div class="alert" role="alert">${escapeHtml(message)}</div>` : ''}
          <form method="post" action="/login">
            <input type="hidden" name="action" value="login">
            <div class="field"><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus></div>
            <p><button type="submit">Entrar</button></p>
          </form>
        </section></main>`
    );
}

function proposalsTable(proposals, minimum) {
    if (!proposals.length) {
        return '<p class="muted">Nenhuma proposta neste servidor ainda.</p>';
    }

    const rows = proposals
        .map(proposal => {
            const founded = proposal.status === 'Partido fundado';
            const progress =
                founded || minimum < 1
                    ? 100
                    : Math.min(100, Math.round((proposal.totalApoios / minimum) * 100));
            return `<tr>
              <td><strong>${escapeHtml(proposal.emoji)} ${escapeHtml(proposal.nome)} (${escapeHtml(proposal.sigla)})</strong><small>Fundador: ${escapeHtml(proposal.fundadorNome)} · ${escapeHtml(proposal.fundadorId)}</small></td>
              <td>${escapeHtml(proposal.posicionamento || '—')}</td>
              <td><span class="pill${founded ? ' green' : ''}">${escapeHtml(proposal.status)}</span></td>
              <td>${escapeHtml(proposal.totalApoios)} / ${escapeHtml(minimum)}<div class="bar"><span style="width:${progress}%"></span></div></td>
            </tr>`;
        })
        .join('');

    return `<div class="table-wrap"><table>
      <thead><tr><th>Proposta</th><th>Posicionamento</th><th>Status</th><th>Apoios</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function partiesTable(parties) {
    if (!parties.length) {
        return '<p class="muted">Nenhum partido fundado ainda.</p>';
    }

    const rows = parties
        .map(
            party => `<tr>
              <td><strong>${escapeHtml(party.emoji)} ${escapeHtml(party.nome)} (${escapeHtml(party.sigla)})</strong><small>Fundador: ${escapeHtml(party.fundador_nome)}</small></td>
              <td>${escapeHtml(party.posicionamento)}</td>
              <td>${escapeHtml(new Date(party.fundado_em).toLocaleString('pt-BR'))}</td>
            </tr>`
        )
        .join('');

    return `<div class="table-wrap"><table>
      <thead><tr><th>Partido</th><th>Posicionamento</th><th>Fundado em</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function dashboardPage({ guilds, selectedGuild, config, proposals, parties, csrf, message = '' }) {
    const options = guilds
        .map(
            guild =>
                `<option value="${escapeHtml(guild.id)}"${guild.id === selectedGuild.id ? ' selected' : ''}>${escapeHtml(guild.name)} (${escapeHtml(guild.id)})</option>`
        )
        .join('');
    const pending = proposals.filter(
        proposal => proposal.status === 'Aguardando apoiadores'
    ).length;

    return page(
        'Administração',
        `<main class="stack">
          <div class="topline"><div><h1>Painel eleitoral</h1><p class="muted">Configurações e acompanhamento por servidor do Discord.</p></div>
            <form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Sair</button></form>
          </div>
          ${message ? `<div class="alert" role="status">${escapeHtml(message)}</div>` : ''}
          <section class="card">
            <form method="get" action="/">
              <div class="controls"><div class="field"><label for="guildId">Servidor</label><select id="guildId" name="guildId">${options}</select></div><button type="submit">Abrir servidor</button></div>
            </form>
          </section>
          <section class="grid">
            <div class="card"><div class="metric">${proposals.length}</div><div class="metric-label">Propostas registradas</div></div>
            <div class="card"><div class="metric">${pending}</div><div class="metric-label">Aguardando apoios</div></div>
            <div class="card"><div class="metric">${parties.length}</div><div class="metric-label">Partidos fundados</div></div>
          </section>
          <section class="card"><h2>Configuração eleitoral</h2>
            <form method="post" action="/config">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="guildId" value="${escapeHtml(selectedGuild.id)}">
              <div class="controls">
                <div class="field"><label for="canalApoioId">ID do canal de apoio</label><input id="canalApoioId" name="canalApoioId" inputmode="numeric" pattern="[0-9]{17,20}" value="${escapeHtml(config.canalApoioId || '')}" placeholder="ID do canal no Discord" required></div>
                <div class="field"><label for="minimoApoios">Apoios necessários</label><input id="minimoApoios" name="minimoApoios" type="number" min="1" max="500" value="${escapeHtml(config.minimoApoios)}" required></div>
                <button type="submit">Salvar configuração</button>
              </div>
              <p class="hint">O bot precisa ter permissão para ver e enviar mensagens no canal escolhido.</p>
            </form>
          </section>
          <section class="card"><h2>Propostas e apoios</h2>${proposalsTable(proposals, config.minimoApoios)}</section>
          <section class="card"><h2>Partidos fundados</h2>${partiesTable(parties)}</section>
          <footer>A sessão expira 8 horas após o login. Valores exibidos correspondem ao banco de dados local do bot.</footer>
        </main>`
    );
}

function createAdminServer({
    password,
    database,
    getGuilds,
    getTextChannel,
    cookieSecure = true,
    publicOrigin = '',
    logger = console
}) {
    if (typeof password !== 'string' || password.length < 16) {
        throw new Error('ADMIN_PASSWORD deve conter pelo menos 16 caracteres.');
    }

    const expectedPasswordHash = passwordHash(password);
    const expectedPublicOrigin = parsePublicOrigin(publicOrigin);
    const sessions = new Map();
    const loginAttempts = new Map();

    function send(response, status, body, headers = {}) {
        response.writeHead(status, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            ...headers
        });
        response.end(body);
    }

    function redirect(response, location, headers = {}) {
        response.writeHead(303, {
            Location: location,
            'Cache-Control': 'no-store',
            ...headers
        });
        response.end();
    }

    function secureCookie(value, maxAge) {
        return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSecure ? '; Secure' : ''}`;
    }

    function sessionFor(request) {
        const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
        if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
        const session = sessions.get(token);
        if (!session) return null;
        if (session.expiresAt <= Date.now()) {
            sessions.delete(token);
            return null;
        }
        return { token, session };
    }

    function getAvailableGuilds() {
        return Array.from(
            getGuilds(),
            guild => ({ id: String(guild.id), name: String(guild.name) })
        )
            .filter(guild => SNOWFLAKE_PATTERN.test(guild.id))
            .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    }

    function validOrigin(request) {
        const origin = request.headers.origin;
        if (!origin) return true;
        try {
            const parsedOrigin = new URL(origin);
            if (
                parsedOrigin.origin === 'null' ||
                !['http:', 'https:'].includes(parsedOrigin.protocol)
            ) {
                return false;
            }
            if (expectedPublicOrigin) {
                return parsedOrigin.origin === expectedPublicOrigin;
            }
            const forwardedHost =
                typeof request.headers['x-forwarded-host'] === 'string'
                    ? request.headers['x-forwarded-host']
                          .split(',')[0]
                          .trim()
                    : '';
            if ([request.headers.host, forwardedHost].includes(
                parsedOrigin.host
            )) {
                return true;
            }

            // O proxy pode substituir Host sem encaminhar o hostname público.
            // A validação CSRF continua exigindo sessão e token nas rotas privadas.
            return ['same-origin', 'same-site', 'none'].includes(
                request.headers['sec-fetch-site']
            );
        } catch {
            return false;
        }
    }

    function readForm(request) {
        return new Promise((resolve, reject) => {
            let body = '';
            let tooLarge = false;
            request.setEncoding('utf8');
            request.on('data', chunk => {
                if (tooLarge) return;
                body += chunk;
                if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
                    tooLarge = true;
                    reject(Object.assign(new Error('Corpo da requisição muito grande.'), { status: 413 }));
                }
            });
            request.on('end', () => {
                if (!tooLarge) resolve(serializeForm(body));
            });
            request.on('error', reject);
        });
    }

    function loginLimit(ip) {
        const now = Date.now();
        let attempt = loginAttempts.get(ip);
        if (!attempt || attempt.resetAt <= now) {
            attempt = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
            loginAttempts.set(ip, attempt);
        }
        if (loginAttempts.size > 1000) {
            const oldestIp = loginAttempts.keys().next().value;
            loginAttempts.delete(oldestIp);
        }
        if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
            return Math.ceil((attempt.resetAt - now) / 1000);
        }
        attempt.count++;
        return 0;
    }

    function resolveGuild(guildId) {
        if (!SNOWFLAKE_PATTERN.test(guildId)) return null;
        return getAvailableGuilds().find(guild => guild.id === guildId) ?? null;
    }

    async function handle(request, response) {
        const url = new URL(request.url, 'http://localhost');

        if (request.method === 'GET' && url.pathname === '/login') {
            return send(response, 200, loginPage());
        }

        if (request.method === 'GET' && url.pathname === '/') {
            const authenticated = sessionFor(request);
            if (!authenticated) {
                return send(response, 200, loginPage());
            }
            const guilds = getAvailableGuilds();
            if (!guilds.length) {
                return send(
                    response,
                    200,
                    page('Aguardando Discord', '<main><section class="card"><h1>Conectando ao Discord</h1><p class="muted">Ainda não há servidores disponíveis. Aguarde o bot conectar e atualize esta página.</p></section></main>')
                );
            }

            const requestedGuildId = url.searchParams.get('guildId');
            const selectedGuild =
                (requestedGuildId && resolveGuild(requestedGuildId)) ||
                guilds[0];
            const config = database.obterConfiguracao(selectedGuild.id);
            const proposals = database.listarPropostas(selectedGuild.id);
            const parties = database.listarPartidos(selectedGuild.id);
            return send(
                response,
                200,
                dashboardPage({
                    guilds,
                    selectedGuild,
                    config,
                    proposals,
                    parties,
                    csrf: authenticated.session.csrf,
                    message: url.searchParams.get('saved')
                        ? 'Configuração salva.'
                        : ''
                })
            );
        }

        if (request.method !== 'POST') {
            return send(response, 404, page('Não encontrado', '<main><h1>Não encontrado</h1></main>'));
        }
        if (
            request.headers['content-type']?.split(';')[0] !==
            'application/x-www-form-urlencoded'
        ) {
            return send(response, 415, page('Requisição inválida', '<main><h1>Tipo de formulário inválido.</h1></main>'));
        }
        if (!validOrigin(request)) {
            return send(response, 403, page('Acesso negado', '<main><h1>Origem da requisição inválida.</h1></main>'));
        }

        let form;
        try {
            form = await readForm(request);
        } catch (error) {
            if (response.headersSent || response.destroyed) return;
            return send(
                response,
                error.status ?? 400,
                page('Requisição inválida', '<main><h1>Não foi possível ler o formulário.</h1></main>')
            );
        }

        if (url.pathname === '/login' && form.action === 'login') {
            const retryAfter = loginLimit(request.socket.remoteAddress ?? 'unknown');
            if (retryAfter > 0) {
                return send(
                    response,
                    429,
                    loginPage('Muitas tentativas. Aguarde e tente novamente.'),
                    { 'Retry-After': String(retryAfter) }
                );
            }
            if (!samePassword(form.password, expectedPasswordHash)) {
                return send(response, 401, loginPage('Senha incorreta.'));
            }

            loginAttempts.delete(request.socket.remoteAddress ?? 'unknown');
            for (const [sessionToken, session] of sessions) {
                if (session.expiresAt <= Date.now()) sessions.delete(sessionToken);
            }
            if (sessions.size >= 2000) {
                const oldestToken = sessions.keys().next().value;
                sessions.delete(oldestToken);
            }
            const token = crypto.randomBytes(32).toString('hex');
            sessions.set(token, {
                csrf: crypto.randomBytes(32).toString('hex'),
                expiresAt: Date.now() + SESSION_TTL_MS
            });
            return redirect(response, '/', {
                'Set-Cookie': secureCookie(token, SESSION_TTL_MS / 1000)
            });
        }

        const authenticated = sessionFor(request);
        if (
            !authenticated ||
            !/^[a-f0-9]{64}$/.test(form.csrf) ||
            !crypto.timingSafeEqual(
                Buffer.from(form.csrf),
                Buffer.from(authenticated.session.csrf)
            )
        ) {
            return send(response, 403, loginPage('Sessão expirada. Entre novamente.'));
        }

        if (url.pathname === '/logout' && form.action === '') {
            sessions.delete(authenticated.token);
            return redirect(response, '/login', {
                'Set-Cookie': secureCookie('', 0)
            });
        }

        if (url.pathname === '/config' && form.action === '') {
            const guild = resolveGuild(form.guildId);
            const minimoApoios = Number(form.minimoApoios);
            if (
                !guild ||
                !Number.isInteger(minimoApoios) ||
                minimoApoios < 1 ||
                minimoApoios > 500 ||
                !SNOWFLAKE_PATTERN.test(form.canalApoioId)
            ) {
                return send(
                    response,
                    400,
                    loginPage('Servidor, canal ou número de apoios inválido. Reabra o painel e tente novamente.')
                );
            }

            const channel = await getTextChannel(guild.id, form.canalApoioId);
            if (!channel) {
                return send(
                    response,
                    400,
                    loginPage('O canal informado não é um canal de texto acessível do servidor selecionado.')
                );
            }

            database.configurarEleitoral(guild.id, channel.id, minimoApoios);
            return redirect(response, `/?guildId=${encodeURIComponent(guild.id)}&saved=1`);
        }

        return send(response, 404, page('Não encontrado', '<main><h1>Não encontrado</h1></main>'));
    }

    return http.createServer((request, response) => {
        Promise.resolve(handle(request, response)).catch(error => {
            logger.error('[ADMIN PANEL] Erro ao processar requisição:', error);
            if (!response.headersSent && !response.destroyed) {
                send(
                    response,
                    500,
                    page('Erro', '<main><h1>Erro interno</h1><p class="muted">A requisição não pôde ser concluída.</p></main>')
                );
            }
        });
    });
}

function iniciarPainel({ password, host, port, ...options }) {
    const server = createAdminServer({ password, ...options });
    server.listen(port, host, () => {
        if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
            console.warn(
                '[ADMIN PANEL] Está escutando em interface de rede; proteja o acesso com HTTPS e controle de rede.'
            );
        }
    });
    return server;
}

module.exports = { ROTAS_ADMIN, createAdminServer, iniciarPainel };
