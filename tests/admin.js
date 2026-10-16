'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trebot-admin-test-'));
process.env.DB_PATH = path.join(DB_DIR, 'partidos.db');

const database = require('../src/database');
const { ROTAS_ADMIN, createAdminServer } = require('../src/web/admin');
const { animarInicializacao, renderDashboard } = require('../src/ui/console');

async function main() {
    let banner = '';
    await animarInicializacao({
        write: text => {
            banner += text;
        },
        isTTY: false
    });
    assert.match(banner, /SISTEMA ELEITORAL/);
    assert.doesNotMatch(banner, /[\u0080-\uFFFF]/);

    let frameCount = 0;
    await animarInicializacao({
        write: () => {},
        isTTY: true,
        delay: async () => {
            frameCount++;
        }
    });
    assert.equal(frameCount, 8);

    let dashboard = '';
    const consoleGuilds = new Map([['server-1', {}]]);
    const consoleCommands = new Map([
        ['config', {}],
        ['fundar-partido', {}]
    ]);
    renderDashboard({
        client: {
            user: { tag: 'TREBot#1234' },
            guilds: { cache: consoleGuilds },
            commands: consoleCommands,
            adminPanel: {
                host: '127.0.0.1',
                cookieSecure: true,
                server: {
                    listening: true,
                    address: () => ({ port: 3000 })
                }
            }
        },
        version: '1.0.0',
        uptimeSeconds: 123,
        write: text => {
            dashboard += text;
        }
    });
    for (const route of ROTAS_ADMIN) {
        assert.ok(
            dashboard.includes(`${route.method.padEnd(4)} ${route.path}`),
            `console lists ${route.method} ${route.path}`
        );
        assert.ok(dashboard.includes(route.access));
    }
    assert.match(dashboard, /localhost:3000/);
    assert.match(dashboard, /1 servidor\(es\)/);
    assert.match(dashboard, /2 slash command\(s\)/);
    assert.match(dashboard, /cookie Secure/);

    const guild = { id: '12345678901234567', name: '<Servidor teste>' };
    const channel = { id: '23456789012345678' };
    const browserOrigin = 'https://painel.example.test';
    const server = createAdminServer({
        password: 'uma-senha-segura-de-teste',
        database,
        getGuilds: function* () {
            yield guild;
        },
        getTextChannel: async (guildId, channelId) =>
            guildId === guild.id && channelId === channel.id
                ? { id: channelId }
                : null,
        cookieSecure: false,
        publicOrigin: browserOrigin,
        logger: { error: error => console.error(error) }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let proxyServer;
    let fetchMetadataServer;
    const post = (pathName, values, cookie, origin = browserOrigin) =>
        fetch(`${baseUrl}${pathName}`, {
            method: 'POST',
            redirect: 'manual',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                ...(cookie ? { Cookie: cookie } : {}),
                ...(origin ? { Origin: origin } : {})
            },
            body: new URLSearchParams(values)
        });

    try {
        assert.throws(
            () =>
                createAdminServer({
                    password: 'curta',
                    database,
                    getGuilds: () => [],
                    getTextChannel: async () => null
                }),
            /pelo menos 16 caracteres/
        );
        assert.throws(
            () =>
                createAdminServer({
                    password: 'uma-senha-segura-de-teste',
                    publicOrigin: 'https://painel.example.test/admin',
                    database,
                    getGuilds: () => [],
                    getTextChannel: async () => null
                }),
            /sem caminho/
        );

        proxyServer = createAdminServer({
            password: 'uma-senha-segura-de-teste',
            database,
            getGuilds: () => [],
            getTextChannel: async () => null,
            cookieSecure: false
        });
        await new Promise((resolve, reject) => {
            proxyServer.once('error', reject);
            proxyServer.listen(0, '127.0.0.1', resolve);
        });
        const proxyAddress = proxyServer.address();
        const forwardedLogin = await fetch(
            `http://127.0.0.1:${proxyAddress.port}/login`,
            {
                method: 'POST',
                redirect: 'manual',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Origin: 'https://forwarded.example.test',
                    'X-Forwarded-Host': 'forwarded.example.test'
                },
                body: new URLSearchParams({
                    action: 'login',
                    password: 'uma-senha-segura-de-teste'
                })
            }
        );
        assert.equal(
            forwardedLogin.status,
            303,
            'proxy origin matches the forwarded public host'
        );
        const mismatchedForwardedLogin = await fetch(
            `http://127.0.0.1:${proxyAddress.port}/login`,
            {
                method: 'POST',
                redirect: 'manual',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Origin: 'https://attacker.example.test',
                    'X-Forwarded-Host': 'forwarded.example.test'
                },
                body: new URLSearchParams({
                    action: 'login',
                    password: 'uma-senha-segura-de-teste'
                })
            }
        );
        assert.equal(mismatchedForwardedLogin.status, 403);

        fetchMetadataServer = createAdminServer({
            password: 'uma-senha-segura-de-teste',
            database,
            getGuilds: () => [],
            getTextChannel: async () => null,
            cookieSecure: false
        });
        await new Promise((resolve, reject) => {
            fetchMetadataServer.once('error', reject);
            fetchMetadataServer.listen(0, '127.0.0.1', resolve);
        });
        const fetchMetadataAddress = fetchMetadataServer.address();
        const forwardedBrowserLogin = await fetch(
            `http://127.0.0.1:${fetchMetadataAddress.port}/login`,
            {
                method: 'POST',
                redirect: 'manual',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Origin: 'https://dashboard.example.test',
                    'Sec-Fetch-Site': 'same-origin'
                },
                body: new URLSearchParams({
                    action: 'login',
                    password: 'uma-senha-segura-de-teste'
                })
            }
        );
        assert.equal(
            forwardedBrowserLogin.status,
            303,
            'same-origin browser login is accepted when the proxy rewrites Host'
        );
        const crossSiteLogin = await fetch(
            `http://127.0.0.1:${fetchMetadataAddress.port}/login`,
            {
                method: 'POST',
                redirect: 'manual',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Origin: 'https://attacker.example.test',
                    'Sec-Fetch-Site': 'cross-site'
                },
                body: new URLSearchParams({
                    action: 'login',
                    password: 'uma-senha-segura-de-teste'
                })
            }
        );
        assert.equal(crossSiteLogin.status, 403);

        const publicPage = await fetch(`${baseUrl}/`);
        assert.equal(publicPage.status, 200);
        assert.match(await publicPage.text(), /Painel administrativo/);

        const badLogin = await post('/login', {
            action: 'login',
            password: 'senha-incorreta'
        });
        assert.equal(badLogin.status, 401);
        assert.equal(badLogin.headers.get('set-cookie'), null);

        const login = await post('/login', {
            action: 'login',
            password: 'uma-senha-segura-de-teste'
        });
        assert.equal(login.status, 303);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const cookieHeader = login.headers.get('set-cookie');
        assert.match(cookieHeader, /HttpOnly/);
        assert.match(cookieHeader, /SameSite=Strict/);

        const proxyPost = await post(
            '/login',
            {
                action: 'login',
                password: 'uma-senha-segura-de-teste'
            },
            null,
            browserOrigin
        );
        assert.equal(
            proxyPost.status,
            303,
            'public browser origin is accepted when proxy host differs from local Host'
        );

        const dashboardResponse = await fetch(`${baseUrl}/`, {
            headers: { Cookie: cookie }
        });
        assert.equal(dashboardResponse.status, 200);
        const dashboard = await dashboardResponse.text();
        assert.match(dashboard, /Configuração eleitoral/);
        assert.match(dashboard, /&lt;Servidor teste&gt;/);
        const csrf = dashboard.match(/name="csrf" value="([a-f0-9]+)"/)[1];

        const missingCsrf = await post(
            '/config',
            {
                action: '',
                guildId: guild.id,
                canalApoioId: channel.id,
                minimoApoios: '3'
            },
            cookie
        );
        assert.equal(missingCsrf.status, 403);

        const wrongOrigin = await post(
            '/config',
            {
                action: '',
                csrf,
                guildId: guild.id,
                canalApoioId: channel.id,
                minimoApoios: '3'
            },
            cookie,
            'https://attacker.example'
        );
        assert.equal(wrongOrigin.status, 403);

        const saved = await post(
            '/config',
            {
                action: '',
                csrf,
                guildId: guild.id,
                canalApoioId: channel.id,
                minimoApoios: '3'
            },
            cookie
        );
        assert.equal(saved.status, 303);
        assert.equal(database.obterConfiguracao(guild.id).canalApoioId, channel.id);
        assert.equal(database.obterConfiguracao(guild.id).minimoApoios, 3);

        const invalidChannel = await post(
            '/config',
            {
                action: '',
                csrf,
                guildId: guild.id,
                canalApoioId: '34567890123456789',
                minimoApoios: '4'
            },
            cookie
        );
        assert.equal(invalidChannel.status, 400);
        const invalidHtml = await invalidChannel.text();
        assert.match(invalidHtml, /O canal informado não é um canal de texto/);
        assert.match(invalidHtml, /Painel eleitoral/);
        assert.equal(database.obterConfiguracao(guild.id).minimoApoios, 3);

        database.salvarIdentidade({
            fundadorId: '34567890123456789',
            fundadorNome: 'Teste',
            guildId: guild.id,
            nome: '<script>alert(1)</script>',
            sigla: 'XSS',
            emoji: '🗳️'
        });
        database.salvarPrograma('34567890123456789', {
            guildId: guild.id,
            propostas: 'Programa',
            valores: 'Valores',
            posicionamento: 'Centro'
        });
        const safeDashboard = await fetch(`${baseUrl}/`, {
            headers: { Cookie: cookie }
        });
        const safeHtml = await safeDashboard.text();
        assert.match(safeHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.doesNotMatch(safeHtml, /<script>alert\(1\)<\/script>/);

        const logout = await post('/logout', { csrf }, cookie);
        assert.equal(logout.status, 303);
        const revoked = await fetch(`${baseUrl}/`, {
            headers: { Cookie: cookie }
        });
        assert.match(await revoked.text(), /Painel administrativo/);

        for (let attempt = 0; attempt < 6; attempt++) {
            await post('/login', {
                action: 'login',
                password: 'senha-incorreta'
            });
        }
        const rateLimited = await post('/login', {
            action: 'login',
            password: 'senha-incorreta'
        });
        assert.equal(rateLimited.status, 429);

        console.log('Painel administrativo OK');
    } finally {
        if (fetchMetadataServer) {
            await new Promise(resolve => fetchMetadataServer.close(resolve));
        }
        if (proxyServer) {
            await new Promise(resolve => proxyServer.close(resolve));
        }
        await new Promise(resolve => server.close(resolve));
        database.fechar();
        fs.rmSync(DB_DIR, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
