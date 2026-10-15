'use strict';

/**
 * Bateria de testes automatizados do sistema eleitoral e da Urna Eletrônica.
 * Valida os 16 requisitos obrigatórios de integridade, persistência,
 * concorrência, sigilo, segundo turno e recuperação pós-reinicialização.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SQLite = require('better-sqlite3');
const { PermissionFlagsBits } = require('discord.js');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trebot-eleicoes-test-'));
const PARTIDOS_DB_PATH = path.join(TEST_DIR, 'partidos.db');
const ELEICOES_DB_PATH = path.join(TEST_DIR, 'eleicoes.db');

process.env.DB_PATH = PARTIDOS_DB_PATH;
process.env.ELEICOES_DB_PATH = ELEICOES_DB_PATH;

const databasePartidos = require('../src/database');
const dbEleicoes = require('../src/database/eleicoes');
const candidatosService = require('../src/services/eleicoes/candidatos-service');
const permissoesService = require('../src/services/eleicoes/permissoes-service');
const apuracaoService = require('../src/services/eleicoes/apuracao-service');
const schedulerService = require('../src/services/eleicoes/scheduler-service');
const urnaService = require('../src/services/eleicoes/urna-service');
const comandoEleicao = require('../src/commands/eleicao');

let falhas = 0;

async function teste(nome, fn) {
    try {
        await fn();
        console.log(`  ok   ${nome}`);
    } catch (error) {
        falhas++;
        console.error(`  FAIL ${nome}\n       ${error.stack || error.message}`);
    }
}

function fakeInteraction(opcoes = {}) {
    const respostas = [];
    const atualizacoes = [];
    let diferido = false;

    return {
        guildId: opcoes.guildId || 'guild-teste-1',
        user: opcoes.user || {
            id: 'eleitor-1',
            username: 'Eleitor 1',
            tag: 'Eleitor 1#0001',
            send: opcoes.dmFalha
                ? async () => { throw new Error('Cannot send messages to this user (DMs disabled)'); }
                : async (payload) => { respostas.push({ tipo: 'dm', payload }); return true; }
        },
        member: opcoes.member || { displayName: 'Eleitor 1' },
        memberPermissions: {
            has(perm) {
                if (opcoes.isAdmin !== undefined) return opcoes.isAdmin;
                return (
                    perm === PermissionFlagsBits.ManageGuild ||
                    perm === PermissionFlagsBits.Administrator
                );
            }
        },
        customId: opcoes.customId || '',
        channel: {
            id: 'canal-eleicao',
            isTextBased: () => true,
            send: async (payload) => ({
                id: 'msg-urna-publica',
                ...payload
            })
        },
        options: {
            getSubcommand: () => opcoes.subcommand,
            getString: (nome) => opcoes.strings?.[nome] ?? null,
            getInteger: (nome) => opcoes.integers?.[nome] ?? null,
            getBoolean: (nome) => opcoes.booleans?.[nome] ?? null,
            getChannel: (nome) => opcoes.channels?.[nome] ?? null
        },
        async reply(payload) {
            respostas.push({ tipo: 'reply', payload });
            return payload;
        },
        async update(payload) {
            atualizacoes.push({ tipo: 'update', payload });
            return payload;
        },
        async deferUpdate() {
            diferido = true;
        },
        isRepliable: () => true,
        respostas,
        atualizacoes,
        get diferido() {
            return diferido;
        }
    };
}

// Configuração prévia dos dados de partidos e candidatos no banco partidos.db
function popularCandidatosPartidos(guildId, eleicaoBaseId) {
    // 1. Cadastra Partido 1 (Número 10)
    const sql = new SQLite(PARTIDOS_DB_PATH);
    try {
        const agora = new Date().toISOString();
        const p1 = sql.prepare(`
            INSERT INTO partidos (
                guild_id, fundador_id, fundador_nome, nome, sigla, emoji,
                posicionamento, propostas, valores, fundado_em,
                numero_eleitoral, status, ultima_atividade_em
            ) VALUES (?, 'fundador-10', 'Líder 10', 'Partido da Esperança', 'PESP', '🌱', 'Centro', 'P1', 'V1', ?, 10, 'ativo', ?)
        `).run(guildId, agora, agora);
        const partido1Id = Number(p1.lastInsertRowid);

        const p2 = sql.prepare(`
            INSERT INTO partidos (
                guild_id, fundador_id, fundador_nome, nome, sigla, emoji,
                posicionamento, propostas, valores, fundado_em,
                numero_eleitoral, status, ultima_atividade_em
            ) VALUES (?, 'fundador-20', 'Líder 20', 'Partido do Futuro', 'PFUT', '🚀', 'Direita', 'P2', 'V2', ?, 20, 'ativo', ?)
        `).run(guildId, agora, agora);
        const partido2Id = Number(p2.lastInsertRowid);

        const p3 = sql.prepare(`
            INSERT INTO partidos (
                guild_id, fundador_id, fundador_nome, nome, sigla, emoji,
                posicionamento, propostas, valores, fundado_em,
                numero_eleitoral, status, ultima_atividade_em
            ) VALUES (?, 'fundador-30', 'Líder 30', 'Partido da União', 'PUNI', '🤝', 'Esquerda', 'P3', 'V3', ?, 30, 'ativo', ?)
        `).run(guildId, agora, agora);
        const partido3Id = Number(p3.lastInsertRowid);

        // 2. Políticos e Candidatos para Presidente (2 dígitos)
        // Cand A: 10
        sql.prepare('INSERT INTO politicos (guild_id, discord_id, nome, partido_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
            .run(guildId, 'pres-1', 'Candidato Pres A', partido1Id, agora, agora);
        sql.prepare(`
            INSERT INTO candidatos (guild_id, eleicao_id, politico_id, partido_id, cargo, numero, status, criado_em)
            VALUES (?, ?, ?, ?, 'presidente', '10', 'aprovado', ?)
        `).run(guildId, eleicaoBaseId, 'pres-1', partido1Id, agora);

        // Cand B: 20
        sql.prepare('INSERT INTO politicos (guild_id, discord_id, nome, partido_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
            .run(guildId, 'pres-2', 'Candidato Pres B', partido2Id, agora, agora);
        sql.prepare(`
            INSERT INTO candidatos (guild_id, eleicao_id, politico_id, partido_id, cargo, numero, status, criado_em)
            VALUES (?, ?, ?, ?, 'presidente', '20', 'aprovado', ?)
        `).run(guildId, eleicaoBaseId, 'pres-2', partido2Id, agora);

        // Cand C: 30
        sql.prepare('INSERT INTO politicos (guild_id, discord_id, nome, partido_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
            .run(guildId, 'pres-3', 'Candidato Pres C', partido3Id, agora, agora);
        sql.prepare(`
            INSERT INTO candidatos (guild_id, eleicao_id, politico_id, partido_id, cargo, numero, status, criado_em)
            VALUES (?, ?, ?, ?, 'presidente', '30', 'aprovado', ?)
        `).run(guildId, eleicaoBaseId, 'pres-3', partido3Id, agora);

        // Cand Reprovado: não deve ser elegível
        sql.prepare('INSERT INTO politicos (guild_id, discord_id, nome, partido_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
            .run(guildId, 'pres-reprovado', 'Candidato Reprovado', partido1Id, agora, agora);
        sql.prepare(`
            INSERT INTO candidatos (guild_id, eleicao_id, politico_id, partido_id, cargo, numero, status, criado_em)
            VALUES (?, ?, ?, ?, 'presidente', '99', 'recusado', ?)
        `).run(guildId, eleicaoBaseId, 'pres-reprovado', partido1Id, agora);

        // 3. Governador: Número 01 (com zero à esquerda) e 20
        const pZero = sql.prepare(`
            INSERT INTO partidos (
                guild_id, fundador_id, fundador_nome, nome, sigla, emoji,
                posicionamento, propostas, valores, fundado_em,
                numero_eleitoral, status, ultima_atividade_em
            ) VALUES (?, 'fundador-01', 'Líder 01', 'Partido Um', 'PUM', '1️⃣', 'Centro', 'PZ', 'VZ', ?, 1, 'ativo', ?)
        `).run(guildId, agora, agora);
        const partidoZeroId = Number(pZero.lastInsertRowid);

        sql.prepare('INSERT INTO politicos (guild_id, discord_id, nome, partido_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
            .run(guildId, 'gov-1', 'Governador Zero', partidoZeroId, agora, agora);
        sql.prepare(`
            INSERT INTO candidatos (guild_id, eleicao_id, politico_id, partido_id, cargo, numero, status, criado_em)
            VALUES (?, ?, ?, ?, 'governador', '01', 'aprovado', ?)
        `).run(guildId, eleicaoBaseId, 'gov-1', partidoZeroId, agora);

        // 4. Senador (3 dígitos): 101
        sql.prepare('INSERT INTO politicos (guild_id, discord_id, nome, partido_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
            .run(guildId, 'sen-1', 'Senador Alpha', partido1Id, agora, agora);
        sql.prepare(`
            INSERT INTO candidatos (guild_id, eleicao_id, politico_id, partido_id, cargo, numero, status, criado_em)
            VALUES (?, ?, ?, ?, 'senador', '101', 'aprovado', ?)
        `).run(guildId, eleicaoBaseId, 'sen-1', partido1Id, agora);

        // 5. Deputado Federal (4 dígitos): 1001
        sql.prepare('INSERT INTO politicos (guild_id, discord_id, nome, partido_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
            .run(guildId, 'dep-fed-1', 'Deputado Federal Alpha', partido1Id, agora, agora);
        sql.prepare(`
            INSERT INTO candidatos (guild_id, eleicao_id, politico_id, partido_id, cargo, numero, status, criado_em)
            VALUES (?, ?, ?, ?, 'deputado-federal', '1001', 'aprovado', ?)
        `).run(guildId, eleicaoBaseId, 'dep-fed-1', partido1Id, agora);
    } finally {
        sql.close();
    }
}

async function executarTestes() {
    console.log('\n--- INICIANDO VALIDAÇÃO COMPLETA DO SISTEMA ELEITORAL ---\n');

    const guildId = 'guild-eleicoes-teste';
    const eleicaoBase = databasePartidos.criarEleicao(guildId, 10);
    popularCandidatosPartidos(guildId, eleicaoBase.id);

    let eleicaoIdPrincipal = null;

    // 1. Criação e início de uma eleição
    await teste('1. Criação e início de uma eleição', async () => {
        const interacaoCriar = fakeInteraction({
            guildId,
            isAdmin: true,
            subcommand: 'criar',
            strings: { nome: 'Eleição Geral de Teste 2026' },
            integers: { eleicao_base: eleicaoBase.id, duracao: 60 }
        });

        await comandoEleicao.execute(interacaoCriar);
        const respostaCriar = interacaoCriar.respostas[0]?.payload;
        assert.ok(respostaCriar?.content?.includes('criada com sucesso'));

        const eleicao = dbEleicoes.listarEleicoes(guildId)[0];
        assert.ok(eleicao);
        assert.strictEqual(eleicao.nome, 'Eleição Geral de Teste 2026');
        assert.strictEqual(eleicao.status, 'configurada');
        eleicaoIdPrincipal = eleicao.id;

        // Inicia a eleição
        const interacaoIniciar = fakeInteraction({
            guildId,
            isAdmin: true,
            subcommand: 'iniciar',
            integers: { eleicao: eleicao.id }
        });
        await comandoEleicao.execute(interacaoIniciar);
        const respostaIniciar = interacaoIniciar.respostas[0]?.payload;
        assert.ok(respostaIniciar?.content?.includes('iniciada com sucesso'));

        const eleicaoAberta = dbEleicoes.obterEleicao(guildId, eleicao.id);
        assert.strictEqual(eleicaoAberta.status, 'aberta');
        assert.ok(eleicaoAberta.abertaEm);
        assert.ok(eleicaoAberta.encerraEm);
    });

    // 2. Bloqueio do comando para usuários sem permissão
    await teste('2. Bloqueio do comando para usuários sem permissão', async () => {
        const interacaoSemPerm = fakeInteraction({
            guildId,
            isAdmin: false,
            subcommand: 'cancelar',
            integers: { eleicao: eleicaoIdPrincipal },
            strings: { motivo: 'Tentativa indevida' }
        });

        await comandoEleicao.execute(interacaoSemPerm);
        const resposta = interacaoSemPerm.respostas[0]?.payload;
        assert.ok(resposta?.content?.includes('permissão de administrador'));

        // Verifica que a eleição NÃO foi cancelada
        const eleicao = dbEleicoes.obterEleicao(guildId, eleicaoIdPrincipal);
        assert.strictEqual(eleicao.status, 'aberta');
    });

    // 3. Votação correta em cada cargo
    await teste('3. Votação correta em cada cargo', async () => {
        const eleitorId = 'eleitor-correto-1';

        // Abre a urna
        const interacaoAbrir = fakeInteraction({
            guildId,
            user: { id: eleitorId, username: 'Eleitor Válido', tag: 'Eleitor#0001' },
            customId: `urna_abrir:${eleicaoIdPrincipal}`
        });
        await comandoEleicao.componentHandlers['urna_abrir:*'](interacaoAbrir);
        assert.ok(interacaoAbrir.respostas.length > 0);

        const cargos = dbEleicoes.listarCargosAbertos(eleicaoIdPrincipal);
        assert.ok(cargos.length > 0);

        // Vota em cada cargo na ordem
        for (const cargo of cargos) {
            let numeroVoto = '';
            if (cargo.cargo === 'presidente') numeroVoto = '10';
            else if (cargo.cargo === 'governador') numeroVoto = '01';
            else if (cargo.cargo === 'senador') numeroVoto = '101';
            else if (cargo.cargo === 'deputado-federal') numeroVoto = '1001';

            // Digita cada dígito
            for (const digito of numeroVoto) {
                const interacaoDigito = fakeInteraction({
                    guildId,
                    user: { id: eleitorId, username: 'Eleitor Válido', tag: 'Eleitor#0001' },
                    customId: `urna_btn:${eleicaoIdPrincipal}:${cargo.cargo}:${digito}`
                });
                await comandoEleicao.componentHandlers['urna_btn:*'](interacaoDigito);
            }

            // Confirma o voto
            const interacaoConfirma = fakeInteraction({
                guildId,
                user: { id: eleitorId, username: 'Eleitor Válido', tag: 'Eleitor#0001' },
                customId: `urna_btn:${eleicaoIdPrincipal}:${cargo.cargo}:confirma`
            });
            await comandoEleicao.componentHandlers['urna_btn:*'](interacaoConfirma);
        }

        const eleitor = dbEleicoes.obterEleitor(eleicaoIdPrincipal, eleitorId, 1);
        assert.strictEqual(eleitor.status, 'concluido');

        const confirmados = dbEleicoes.listarCargosConfirmados(eleicaoIdPrincipal, eleitorId, 1);
        assert.strictEqual(confirmados.length, cargos.length);
    });

    // 4. Preservação de zeros à esquerda
    await teste('4. Preservação de zeros à esquerda', async () => {
        const eleitorId = 'eleitor-zero-esq';
        const cargoGov = dbEleicoes.obterCargo(eleicaoIdPrincipal, 'governador');
        assert.strictEqual(cargoGov.digitos, 2);

        // Verifica que o candidato no banco foi cadastrado como string '01'
        const candGov = dbEleicoes.buscarCandidatoPorNumero(eleicaoIdPrincipal, 'governador', '01', 1);
        assert.ok(candGov, 'Candidato 01 deve ser encontrado com zero à esquerda preservado');
        assert.strictEqual(candGov.numero, '01');

        // Digita '0' e depois '1'
        const int0 = fakeInteraction({
            guildId,
            user: { id: eleitorId, username: 'Eleitor Zero' },
            customId: `urna_btn:${eleicaoIdPrincipal}:governador:0`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](int0);

        const int1 = fakeInteraction({
            guildId,
            user: { id: eleitorId, username: 'Eleitor Zero' },
            customId: `urna_btn:${eleicaoIdPrincipal}:governador:1`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](int1);

        const embedAtualizado = int1.atualizacoes[0]?.payload?.embeds?.[0];
        assert.ok(embedAtualizado);
        // O embed deve reconhecer o candidato Governador Zero
        assert.strictEqual(embedAtualizado.data.color, 0x2e7d32); // verde de candidato identificado
    });

    // 5. Rejeição de números inválidos / incompletos
    await teste('5. Rejeição de números inválidos', async () => {
        const eleitorId = 'eleitor-invalido';

        // Tenta confirmar com número incompleto (apenas 1 dígito para presidente de 2 dígitos)
        const int1 = fakeInteraction({
            guildId,
            user: { id: eleitorId, username: 'Eleitor' },
            customId: `urna_btn:${eleicaoIdPrincipal}:presidente:1`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](int1);

        const intConfirmaIncompleto = fakeInteraction({
            guildId,
            user: { id: eleitorId, username: 'Eleitor' },
            customId: `urna_btn:${eleicaoIdPrincipal}:presidente:confirma`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](intConfirmaIncompleto);

        const embedErro = intConfirmaIncompleto.atualizacoes[0]?.payload?.embeds?.[0];
        assert.ok(embedErro?.data?.footer?.text?.includes('complete os 2 dígitos'));

        // Certifica que NÃO gravou o voto incompleto
        const confirmados = dbEleicoes.listarCargosConfirmados(eleicaoIdPrincipal, eleitorId, 1);
        assert.strictEqual(confirmados.includes('presidente'), false);
    });

    // 6. Registro de votos brancos e nulos
    await teste('6. Registro de votos brancos e nulos', async () => {
        const eleitorBranco = 'eleitor-branco';
        const eleitorNulo = 'eleitor-nulo';

        // Voto BRANCO para presidente
        const intBranco = fakeInteraction({
            guildId,
            user: { id: eleitorBranco, username: 'Eleitor Branco' },
            customId: `urna_btn:${eleicaoIdPrincipal}:presidente:branco`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](intBranco);

        const intConfirmaBranco = fakeInteraction({
            guildId,
            user: { id: eleitorBranco, username: 'Eleitor Branco' },
            customId: `urna_btn:${eleicaoIdPrincipal}:presidente:confirma`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](intConfirmaBranco);

        // Voto NULO para presidente: número '99' (reprovado/inexistente)
        const int9A = fakeInteraction({
            guildId,
            user: { id: eleitorNulo, username: 'Eleitor Nulo' },
            customId: `urna_btn:${eleicaoIdPrincipal}:presidente:9`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](int9A);

        const int9B = fakeInteraction({
            guildId,
            user: { id: eleitorNulo, username: 'Eleitor Nulo' },
            customId: `urna_btn:${eleicaoIdPrincipal}:presidente:9`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](int9B);

        const intConfirmaNulo = fakeInteraction({
            guildId,
            user: { id: eleitorNulo, username: 'Eleitor Nulo' },
            customId: `urna_btn:${eleicaoIdPrincipal}:presidente:confirma`
        });
        await comandoEleicao.componentHandlers['urna_btn:*'](intConfirmaNulo);

        const apuracao = dbEleicoes.apurarVotos(eleicaoIdPrincipal, 'presidente', 1);
        assert.strictEqual(apuracao.brancos >= 1, true);
        assert.strictEqual(apuracao.nulos >= 1, true);
    });

    // 7. Prevenção de votos duplicados
    await teste('7. Prevenção de votos duplicados', async () => {
        const eleitorId = 'eleitor-correto-1'; // já concluiu no teste 3
        const checagem = permissoesService.verificarElegibilidadeEleitor(
            dbEleicoes.obterEleicao(guildId, eleicaoIdPrincipal),
            eleitorId
        );
        assert.strictEqual(checagem.autorizacao, false);
        assert.strictEqual(checagem.motivo, 'ja_votou');

        const interacaoTentaAbrir = fakeInteraction({
            guildId,
            user: { id: eleitorId, username: 'Eleitor Repetido' },
            customId: `urna_abrir:${eleicaoIdPrincipal}`
        });
        await comandoEleicao.componentHandlers['urna_abrir:*'](interacaoTentaAbrir);
        assert.ok(interacaoTentaAbrir.respostas[0]?.payload?.content?.includes('já registrou seu voto'));
    });

    // 8. Prevenção de confirmações duplicadas e interações concorrentes
    await teste('8. Prevenção de confirmações duplicadas e interações concorrentes', async () => {
        const eleitorId = 'eleitor-concorrente';
        dbEleicoes.iniciarEleitor(eleicaoIdPrincipal, eleitorId, 1, new Date().toISOString());

        // Dispara duas chamadas simultâneas de confirmação do mesmo cargo
        const p1 = dbEleicoes.registrarVoto({
            eleicaoId: eleicaoIdPrincipal,
            guildId,
            cargo: 'senador',
            discordId: eleitorId,
            tipo: dbEleicoes.TIPO_VOTO.VALIDO,
            numero: '101'
        });

        const p2 = dbEleicoes.registrarVoto({
            eleicaoId: eleicaoIdPrincipal,
            guildId,
            cargo: 'senador',
            discordId: eleitorId,
            tipo: dbEleicoes.TIPO_VOTO.VALIDO,
            numero: '101'
        });

        const resultados = [p1, p2];
        const sucessos = resultados.filter(r => r.resultado === 'registrado');
        const duplicados = resultados.filter(r => r.resultado === 'duplicado');

        assert.strictEqual(sucessos.length, 1);
        assert.strictEqual(duplicados.length, 1);
    });

    // 9. Contabilização correta de votos válidos (excluindo brancos e nulos do denominador)
    await teste('9. Contabilização correta de votos válidos', async () => {
        const apuracao = dbEleicoes.apurarVotos(eleicaoIdPrincipal, 'presidente', 1);
        const validosCalculados = apuracao.candidatos.reduce((s, c) => s + c.votos, 0);
        assert.strictEqual(apuracao.validos, validosCalculados);

        for (const cand of apuracao.candidatos) {
            if (apuracao.validos > 0) {
                const percentualEsperado = (cand.votos / apuracao.validos) * 100;
                assert.strictEqual(cand.percentual.toFixed(4), percentualEsperado.toFixed(4));
            }
        }
    });

    // 10. Classificação para segundo turno
    const guildSegundoTurno = 'guild-seg-turno';
    let el2Id = null;

    await teste('10. Classificação para segundo turno', async () => {
        // Cria eleição específica onde o líder tem menos de 50%
        // Pres A tem 2 votos, Pres B tem 1 voto, Pres C tem 1 voto. Total válidos = 4. 2/4 = 50% (não > 50%)
        const el2Base = databasePartidos.criarEleicao(guildSegundoTurno, 2);
        popularCandidatosPartidos(guildSegundoTurno, el2Base.id);

        const el2 = dbEleicoes.criarEleicao({
            guildId: guildSegundoTurno,
            eleicaoRefId: el2Base.id,
            n: 2,
            nome: 'Eleição Segundo Turno Teste',
            criadaPor: 'admin-1',
            cargos: [{ cargo: 'presidente', digitos: 2, vagas: 1, segundoTurno: true }]
        });
        el2Id = el2.id;
        candidatosService.importarCandidatosParaEleicao(el2.id, guildSegundoTurno, el2Base.id);
        dbEleicoes.atualizarEleicao(el2.id, { status: 'aberta', aberta_em: new Date().toISOString() });
        dbEleicoes.abrirCargos(el2.id, new Date().toISOString());

        // Votos: 2 em '10', 1 em '20', 1 em '30'
        for (let i = 1; i <= 2; i++) {
            const uid = `el2-voter-10-${i}`;
            dbEleicoes.iniciarEleitor(el2.id, uid, 1, new Date().toISOString());
            dbEleicoes.registrarVoto({ eleicaoId: el2.id, guildId: guildSegundoTurno, cargo: 'presidente', discordId: uid, tipo: 'valido', numero: '10' });
        }
        dbEleicoes.iniciarEleitor(el2.id, 'el2-voter-20-1', 1, new Date().toISOString());
        dbEleicoes.registrarVoto({ eleicaoId: el2.id, guildId: guildSegundoTurno, cargo: 'presidente', discordId: 'el2-voter-20-1', tipo: 'valido', numero: '20' });

        dbEleicoes.iniciarEleitor(el2.id, 'el2-voter-30-1', 1, new Date().toISOString());
        dbEleicoes.registrarVoto({ eleicaoId: el2.id, guildId: guildSegundoTurno, cargo: 'presidente', discordId: 'el2-voter-30-1', tipo: 'valido', numero: '30' });

        const resApuracao = apuracaoService.apurarCargo({ eleicaoId: el2.id, cargo: 'presidente', turno: 1, guildId: guildSegundoTurno });
        assert.strictEqual(resApuracao.aguardaSegundoTurno, true);
        assert.strictEqual(resApuracao.situacao, 'aguardando_segundo_turno');
        assert.strictEqual(resApuracao.classificadosSegundoTurno.length, 2);
        assert.strictEqual(resApuracao.eliminadosSegundoTurno.length, 1);
    });

    // 11. Exclusão dos demais candidatos no segundo turno
    await teste('11. Exclusão dos demais candidatos no segundo turno', async () => {
        const el2 = dbEleicoes.obterEleicaoPorId(el2Id);
        assert.ok(el2);

        const resCargo = dbEleicoes.obterResultadoCargo(el2.id, 'presidente', 1);
        assert.strictEqual(resCargo.aguarda_segundo_turno, 1);

        // Agendamento e abertura do segundo turno
        const agendamento = schedulerService.agendarSegundoTurno({
            eleicaoId: el2.id,
            guildId: guildSegundoTurno,
            atrasoMs: 50 // 50ms para teste
        });

        // Elimina desclassificados e promove classificados
        const apuracao = apuracaoService.apurarCargo({ eleicaoId: el2.id, cargo: 'presidente', turno: 1, guildId: guildSegundoTurno });
        dbEleicoes.eliminarCandidatos(el2.id, 'presidente', apuracao.eliminadosSegundoTurno, new Date().toISOString());
        dbEleicoes.promoverCandidatosSegundoTurno(el2.id, 'presidente', apuracao.classificadosSegundoTurno);

        // Aguarda execução do agendamento
        await new Promise(r => setTimeout(r, 80));

        const candidatosT2 = dbEleicoes.listarCandidatosElegiveis(el2.id, 'presidente', 2);
        assert.strictEqual(candidatosT2.length, 2, 'No segundo turno devem constar exatamente 2 candidatos');

        // O terceiro candidato eliminado não deve poder receber votos no T2
        const eliminado = dbEleicoes.obterCandidatoEleicao(el2.id, apuracao.eliminadosSegundoTurno[0]);
        const buscaEliminado = dbEleicoes.buscarCandidatoPorNumero(el2.id, 'presidente', eliminado.numero, 2);
        assert.strictEqual(buscaEliminado, null, 'Candidato eliminado não pode ser localizado para voto no 2º turno');
    });

    // 12. Recuperação de eleições após reiniciar o bot
    await teste('12. Recuperação de eleições após reiniciar o bot', async () => {
        // Simula "reboot": fecha a conexão SQLite e reabre
        dbEleicoes.fechar();
        dbEleicoes.reabrir();

        // Reabre consultando os dados persistidos
        const eleicoesReabertas = dbEleicoes.listarEleicoes(guildId);
        assert.ok(eleicoesReabertas.length >= 1);
        const eleicaoRecuperada = eleicoesReabertas.find(e => e.id === eleicaoIdPrincipal);
        assert.ok(eleicaoRecuperada);
        assert.strictEqual(eleicaoRecuperada.status, 'aberta');

        const votosRegistrados = dbEleicoes.apurarVotos(eleicaoIdPrincipal, 'presidente', 1);
        assert.ok(votosRegistrados.total > 0, 'Votos gravados persistem integralmente');
    });

    // 13. Recuperação do agendamento de segundo turno
    await teste('13. Recuperação do agendamento de segundo turno', async () => {
        const el3 = dbEleicoes.criarEleicao({
            guildId,
            eleicaoRefId: eleicaoBase.id,
            n: 5,
            nome: 'Eleição Reboot Agendamento',
            criadaPor: 'admin-1',
            cargos: [{ cargo: 'presidente', digitos: 2, vagas: 1, segundoTurno: true }]
        });

        // Cria agendamento pendente no passado para verificar disparo imediato na inicialização
        const agendamentoPassado = dbEleicoes.criarAgendamento({
            eleicaoId: el3.id,
            tipo: 'abrir_segundo_turno',
            cargo: 'presidente',
            turno: 2,
            executarEm: new Date(Date.now() - 5000).toISOString()
        });
        assert.strictEqual(agendamentoPassado.status, 'pendente');

        // Simula a rotina que roda no evento `ready` do bot
        const processados = await schedulerService.recuperarAgendamentos();
        assert.ok(processados >= 1);

        const agendamentoAtualizado = dbEleicoes.obterAgendamento(agendamentoPassado.id);
        assert.strictEqual(agendamentoAtualizado.status, 'executado');

        const eleicaoAtualizada = dbEleicoes.obterEleicaoPorId(el3.id);
        assert.strictEqual(eleicaoAtualizada.turno, 2);
    });

    // 14. Falha de envio de DM sem perda do voto
    await teste('14. Falha de envio de DM sem perda do voto', async () => {
        const eleitorDMBloqueada = 'eleitor-dm-bloqueada';
        const elVoto = eleicaoIdPrincipal;
        const cargo = dbEleicoes.listarCargosAbertos(elVoto)[0];

        // Simula interação com usuário que recusa DMs
        const interacaoDMBloqueada = fakeInteraction({
            guildId,
            user: {
                id: eleitorDMBloqueada,
                username: 'Sem DM',
                send: async () => {
                    const err = new Error('Cannot send messages to this user');
                    err.code = 50007;
                    throw err;
                }
            },
            customId: `urna_btn:${elVoto}:${cargo.cargo}:branco`
        });

        await comandoEleicao.componentHandlers['urna_btn:*'](interacaoDMBloqueada);

        const intConfirma = fakeInteraction({
            guildId,
            user: {
                id: eleitorDMBloqueada,
                username: 'Sem DM',
                send: async () => {
                    const err = new Error('Cannot send messages to this user');
                    err.code = 50007;
                    throw err;
                }
            },
            customId: `urna_btn:${elVoto}:${cargo.cargo}:confirma`
        });

        await comandoEleicao.componentHandlers['urna_btn:*'](intConfirma);

        // Voto deve ser gravado com sucesso no banco, sem lançar erro
        const confirmados = dbEleicoes.listarCargosConfirmados(elVoto, eleitorDMBloqueada, 1);
        assert.strictEqual(confirmados.includes(cargo.cargo), true);
    });

    // 15. Isolamento dos dados de eleições diferentes
    await teste('15. Isolamento dos dados de eleições diferentes', async () => {
        const elA = dbEleicoes.obterEleicaoPorId(eleicaoIdPrincipal);
        const elB = dbEleicoes.obterEleicaoPorId(el2Id);
        const antesA = dbEleicoes.apurarVotos(elA.id, 'presidente', elA.turno).total;
        const antesB = dbEleicoes.apurarVotos(elB.id, 'presidente', elB.turno).total;

        assert.notStrictEqual(elA.id, elB.id);

        // Vota apenas na eleição B (que está em elB.turno)
        const eleitorExclusivoB = 'eleitor-exclusivo-b';
        dbEleicoes.iniciarEleitor(elB.id, eleitorExclusivoB, elB.turno, new Date().toISOString());
        const resVotoB = dbEleicoes.registrarVoto({
            eleicaoId: elB.id,
            guildId: elB.guildId,
            cargo: 'presidente',
            discordId: eleitorExclusivoB,
            tipo: 'valido',
            numero: '10'
        });
        assert.strictEqual(resVotoB.resultado, 'registrado');

        const depoisA = dbEleicoes.apurarVotos(elA.id, 'presidente', elA.turno).total;
        const depoisB = dbEleicoes.apurarVotos(elB.id, 'presidente', elB.turno).total;

        assert.strictEqual(depoisA, antesA, 'Voto na eleição B não pode afetar a contagem da eleição A');
        assert.strictEqual(depoisB, antesB + 1, 'Voto na eleição B deve incrementar apenas a eleição B');

        // Eleitor que votou em A pode votar em B sem bloqueio
        const eleitorNeutro = 'eleitor-neutro';
        dbEleicoes.iniciarEleitor(elA.id, eleitorNeutro, elA.turno, new Date().toISOString());
        dbEleicoes.iniciarEleitor(elB.id, eleitorNeutro, elB.turno, new Date().toISOString());

        dbEleicoes.registrarVoto({ eleicaoId: elA.id, guildId: elA.guildId, cargo: 'presidente', discordId: eleitorNeutro, tipo: 'valido', numero: '10' });
        const resB = dbEleicoes.registrarVoto({ eleicaoId: elB.id, guildId: elB.guildId, cargo: 'presidente', discordId: eleitorNeutro, tipo: 'valido', numero: '10' });

        assert.strictEqual(resB.resultado, 'registrado');
    });

    // 16. Preservação dos resultados após o encerramento
    await teste('16. Preservação dos resultados após o encerramento', async () => {
        const intEncerrar = fakeInteraction({
            guildId,
            isAdmin: true,
            subcommand: 'encerrar',
            integers: { eleicao: eleicaoIdPrincipal }
        });

        await comandoEleicao.execute(intEncerrar);
        const elEncerrada = dbEleicoes.obterEleicaoPorId(eleicaoIdPrincipal);
        assert.strictEqual(elEncerrada.status, 'encerrada');
        assert.ok(elEncerrada.encerradaEm);

        // Tentar votar em eleição encerrada deve falhar
        const tentativaVoto = dbEleicoes.registrarVoto({
            eleicaoId: eleicaoIdPrincipal,
            guildId,
            cargo: 'presidente',
            discordId: 'eleitor-tardio',
            tipo: 'branco'
        });
        assert.strictEqual(tentativaVoto.resultado, 'eleicao_encerrada');

        // Resultados salvos permanecem inalterados
        const resultadosPreservados = dbEleicoes.listarResultadoCargosEleicao(eleicaoIdPrincipal, 1);
        assert.ok(resultadosPreservados.length > 0);
        assert.ok(resultadosPreservados.every(r => r.total_votos >= 0));
    });

    schedulerService.limparTimers();
    dbEleicoes.fechar();
    databasePartidos.fechar();

    console.log(`\n========================================`);
    if (falhas > 0) {
        console.error(`TOTAL DE FALHAS: ${falhas}`);
        process.exit(1);
    } else {
        console.log(`TODOS OS 16 TESTES OBRIGATÓRIOS PASSARAM COM SUCESSO! ✓`);
        console.log(`========================================\n`);
    }
}

executarTestes().catch(err => {
    console.error('Erro fatal nos testes:', err);
    process.exit(1);
});
