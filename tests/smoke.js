'use strict';

/**
 * Testes de fumaça: exercitam builders de modal, validação, roteamento por
 * customId e a camada de banco — sem conectar ao Discord.
 *
 *   npm test
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trebot-test-'));
process.env.DB_PATH = path.join(DB_DIR, 'partidos.db');

const SRC = path.join(__dirname, '..', 'src');

const { ComponentType, MessageFlags } = require('discord.js');
const database = require(path.join(SRC, 'database'));

let falhas = 0;

async function teste(nome, fn) {
    try {
        await fn();
        console.log(`  ok   ${nome}`);
    } catch (error) {
        falhas++;
        console.log(`  FAIL ${nome}\n       ${error.message}`);
    }
}

/** Interação falsa que registra o que o handler tentou fazer. */
function fakeInteraction(extra = {}) {
    const capturado = {};
    const canalPublicado = {
        id: 'c1',
        isTextBased: () => true,
        send(payload) {
            capturado.publicado = payload;
            return Promise.resolve({
                id: 'm1',
                delete() {
                    capturado.mensagemRemovida = true;
                    return Promise.resolve();
                }
            });
        }
    };
    const interaction = {
        guildId: '1',
        user: { id: 'u1', username: 'tester' },
        memberPermissions: { has: () => true },
        guild: {
            channels: {
                fetch: () => Promise.resolve(canalPublicado)
            }
        },
        channelId: 'c1',
        message: { id: 'm1' },
        options: {
            getSubcommand: () => 'ver',
            getChannel: () => ({ id: 'c1', type: 0 }),
            getInteger: () => 2
        },
        fields: {},
        showModal(modal) {
            capturado.modal = modal;
            return Promise.resolve();
        },
        reply(payload) {
            capturado.reply = payload;
            return Promise.resolve();
        },
        update(payload) {
            capturado.update = payload;
            return Promise.resolve();
        },
        followUp(payload) {
            capturado.followUp = payload;
            return Promise.resolve();
        },
        ...extra
    };
    return { interaction, capturado };
}

const fields = valores => ({
    getCheckboxGroup: id => valores[id],
    getTextInputValue: id => valores[id],
    getRadioGroup: id => valores[id]
});

async function main() {
    console.log('\n[1] Comandos carregam');
    const comandos = {};
    for (const file of fs.readdirSync(path.join(SRC, 'commands'))) {
        if (!file.endsWith('.js')) continue;
        const cmd = require(path.join(SRC, 'commands', file));
        comandos[cmd.data.name] = cmd;
    }
    await teste('ping registrado', () => assert.ok(comandos.ping));
    await teste('fundar-partido registrado', () =>
        assert.ok(comandos['fundar-partido'])
    );
    await teste('config registrado', () => assert.ok(comandos.config));

    console.log('\n[2] Slash commands serializam');
    for (const [nome, cmd] of Object.entries(comandos)) {
        await teste(`${nome}.data.toJSON()`, () => {
            const json = cmd.data.toJSON();
            assert.strictEqual(json.name, nome);
            assert.ok(json.description);
        });
    }

    const fundar = comandos['fundar-partido'];
    const config = comandos.config;

    console.log('\n[3] Configuração eleitoral');
    await teste('config permite visualizar e configurar somente com permissão', async () => {
        const { interaction, capturado } = fakeInteraction();
        await config.execute(interaction);
        assert.ok(capturado.reply.embeds);
        assert.strictEqual(capturado.reply.flags, MessageFlags.Ephemeral);

        const fundarSemConfig = fakeInteraction();
        await comandos['fundar-partido'].execute(fundarSemConfig.interaction);
        assert.match(
            fundarSemConfig.capturado.reply.content,
            /ainda não foi configurado/i
        );

        const semPermissao = fakeInteraction({
            memberPermissions: { has: () => false }
        });
        await config.execute(semPermissao.interaction);
        assert.match(semPermissao.capturado.reply.content, /Gerenciar servidor/);
    });

    await teste('config salva canal e mínimo de apoios por servidor', async () => {
        const canal = fakeInteraction({
            options: {
                getSubcommand: () => 'canal-apoio',
                getChannel: () => ({ id: 'c1', type: 0 })
            }
        });
        await config.execute(canal.interaction);
        assert.match(canal.capturado.reply.content, /canal de publicação/i);

        const minimo = fakeInteraction({
            options: {
                getSubcommand: () => 'minimo-apoios',
                getInteger: () => 2
            }
        });
        await config.execute(minimo.interaction);
        assert.strictEqual(database.obterConfiguracao('1').minimoApoios, 2);
        assert.strictEqual(database.obterConfiguracao('2').canalApoioId, null);
    });

    console.log('\n[4] Abertura do primeiro modal');
    await teste('execute() abre o modal de leitura', async () => {
        const { interaction, capturado } = fakeInteraction();
        await fundar.execute(interaction);
        assert.ok(capturado.modal, 'showModal não foi chamado');

        const json = capturado.modal.toJSON();
        assert.strictEqual(json.custom_id, 'tb_fundacao_leitura');
        assert.strictEqual(json.title, 'Fundação de partido | TRE');
        assert.ok(
            json.components.length <= 5,
            'modal aceita no máximo 5 componentes'
        );

        const [texto, consentimento, nome] = json.components;
        assert.strictEqual(texto.type, ComponentType.TextDisplay);
        assert.strictEqual(consentimento.type, ComponentType.Label);
        assert.strictEqual(
            consentimento.component.type,
            ComponentType.CheckboxGroup
        );
        assert.strictEqual(consentimento.component.min_values, 1);
        assert.strictEqual(consentimento.component.max_values, 1);

        assert.strictEqual(nome.type, ComponentType.Label);
        assert.strictEqual(nome.component.type, ComponentType.TextInput);
        assert.strictEqual(nome.component.custom_id, 'tb_nome');
        assert.strictEqual(nome.component.min_length, 3);
        assert.strictEqual(nome.component.max_length, 80);
        assert.strictEqual(nome.component.required, true);
    });

    await teste('execute() recusa fora de servidor', async () => {
        const { interaction, capturado } = fakeInteraction({ guildId: null });
        await fundar.execute(interaction);
        assert.ok(capturado.reply, 'deveria responder');
        assert.strictEqual(capturado.reply.flags, MessageFlags.Ephemeral);
        assert.deepStrictEqual(capturado.reply.allowedMentions, { parse: [] });
    });

    await teste('customIds dos handlers estão registrados', () => {
        assert.deepStrictEqual(Object.keys(fundar.componentHandlers).sort(), [
            'tb_apoio_partido',
            'tb_fundacao_continuar',
            'tb_fundacao_leitura',
            'tb_fundacao_programa'
        ]);
    });

    console.log('\n[5] Validação da identidade');
    const identidade = extra =>
        fields({
            tb_leu_regras: ['aceito'],
            tb_nome: 'Partido Gama',
            tb_sigla: 'PGM',
            tb_emoji: '🎉',
            ...extra
        });

    await teste('sem confirmar leitura é rejeitado', async () => {
        const { interaction, capturado } = fakeInteraction({
            fields: identidade({ tb_leu_regras: [] })
        });
        await fundar.componentHandlers.tb_fundacao_leitura(interaction);
        assert.match(capturado.reply.content, /confirmar a leitura/i);
    });

    await teste('sigla com espaço ou emoji é rejeitada', async () => {
        const { interaction, capturado } = fakeInteraction({
            fields: identidade({ tb_sigla: 'PG 🎉' })
        });
        await fundar.componentHandlers.tb_fundacao_leitura(interaction);
        assert.match(capturado.reply.content, /sigla deve ter/i);
    });

    await teste('identidade válida é gravada como rascunho', async () => {
        const { interaction, capturado } = fakeInteraction({
            fields: identidade()
        });
        await fundar.componentHandlers.tb_fundacao_leitura(interaction);

        const botao = capturado.reply.components[0].toJSON().components[0];
        assert.strictEqual(botao.custom_id, 'tb_fundacao_continuar');

        const proposta = database.obterProposta('u1');
        assert.strictEqual(proposta.guildId, '1');
        assert.strictEqual(proposta.sigla, 'PGM');
        assert.strictEqual(proposta.status, database.STATUS_RASCUNHO);
    });

    await teste('sigla de outro usuário é rejeitada', async () => {
        const { interaction, capturado } = fakeInteraction({
            user: { id: 'u9', username: 'nono' },
            fields: identidade({ tb_sigla: 'pgm', tb_nome: 'Partido Delta' })
        });
        await fundar.componentHandlers.tb_fundacao_leitura(interaction);
        assert.match(capturado.reply.content, /já está em uso/i);
    });

    await teste('nome de outro usuário é rejeitado', async () => {
        const { interaction, capturado } = fakeInteraction({
            user: { id: 'u9', username: 'nono' },
            fields: identidade({ tb_sigla: 'PDL' })
        });
        await fundar.componentHandlers.tb_fundacao_leitura(interaction);
        assert.match(capturado.reply.content, /já existe um partido/i);
    });

    console.log('\n[6] Programa partidário e apoios');
    await teste('botão continuar abre o segundo modal', async () => {
        const { interaction, capturado } = fakeInteraction();
        await fundar.componentHandlers.tb_fundacao_continuar(interaction);

        const json = capturado.modal.toJSON();
        assert.strictEqual(json.custom_id, 'tb_fundacao_programa');
        assert.strictEqual(json.components.length, 3);

        const radio = json.components[0].component;
        assert.strictEqual(radio.type, ComponentType.RadioGroup);
        assert.strictEqual(radio.required, true);
        assert.strictEqual(radio.options.length, 3);
    });

    await teste('botão continuar sem rascunho pede para refazer', async () => {
        const { interaction, capturado } = fakeInteraction({
            user: { id: 'u3', username: 'novo' }
        });
        await fundar.componentHandlers.tb_fundacao_continuar(interaction);
        assert.deepStrictEqual(capturado.update.components, []);
    });

    await teste('programa sem posicionamento é rejeitado', async () => {
        const { interaction, capturado } = fakeInteraction({
            fields: fields({
                tb_posicionamento: null,
                tb_propostas: 'a'.repeat(30),
                tb_valores: 'b'.repeat(15)
            })
        });
        await fundar.componentHandlers.tb_fundacao_programa(interaction);
        assert.match(capturado.reply.content, /posicionamento/i);
    });

    await teste('programa válido conclui a proposta', async () => {
        const { interaction, capturado } = fakeInteraction({
            fields: fields({
                tb_posicionamento: 'Centro',
                tb_propostas: 'Proposta X',
                tb_valores: 'Valor Y'
            })
        });
        await fundar.componentHandlers.tb_fundacao_programa(interaction);
        assert.match(capturado.reply.content, /proposta publicada/i);
        assert.strictEqual(capturado.publicado.embeds.length, 1);

        const proposta = database.obterProposta('u1');
        assert.strictEqual(proposta.status, 'Aguardando apoiadores');
        assert.strictEqual(proposta.posicionamento, 'Centro');
        assert.strictEqual(proposta.propostas, 'Proposta X');
        assert.strictEqual(proposta.mensagemId, 'm1');
    });

    await teste('fundador não pode apoiar a própria proposta', async () => {
        const { interaction, capturado } = fakeInteraction();
        await fundar.componentHandlers.tb_apoio_partido(interaction);
        assert.match(capturado.reply.content, /fundador não pode apoiar/i);
        assert.strictEqual(database.obterTotalApoios('u1', '1'), 0);
    });

    await teste('apoios distintos fundam o partido ao atingir a meta', async () => {
        const primeiro = fakeInteraction({
            user: { id: 'u2', username: 'apoiador-1' }
        });
        await fundar.componentHandlers.tb_apoio_partido(primeiro.interaction);
        assert.match(primeiro.capturado.followUp.content, /1 \/ 2/);
        assert.strictEqual(database.obterTotalApoios('u1', '1'), 1);

        const duplicado = fakeInteraction({
            user: { id: 'u2', username: 'apoiador-1' }
        });
        await fundar.componentHandlers.tb_apoio_partido(duplicado.interaction);
        assert.match(duplicado.capturado.followUp.content, /já apoiou/i);
        assert.strictEqual(database.obterTotalApoios('u1', '1'), 1);

        const segundo = fakeInteraction({
            user: { id: 'u3', username: 'apoiador-2' }
        });
        await fundar.componentHandlers.tb_apoio_partido(segundo.interaction);
        assert.match(segundo.capturado.followUp.content, /foi fundado/i);
        assert.deepStrictEqual(segundo.capturado.update.components, []);
        assert.strictEqual(database.obterProposta('u1', '1').status, 'Partido fundado');
        assert.strictEqual(database.listarPartidos('1').length, 1);
    });

    await teste('texto do usuário não dispara menções', async () => {
        database.salvarIdentidade({
            fundadorId: 'u2',
            fundadorNome: 'beta',
            guildId: '1',
            nome: 'Partido Beta',
            sigla: 'PBT',
            emoji: '🅱️',
            posicionamento: null
        });

        const { interaction, capturado } = fakeInteraction({
            user: { id: 'u2', username: 'beta' },
            fields: fields({
                tb_posicionamento: 'Esquerda',
                tb_propostas: '@everyone vamos dominar',
                tb_valores: '@here unidos'
            })
        });
        await fundar.componentHandlers.tb_fundacao_programa(interaction);

        assert.deepStrictEqual(capturado.reply.allowedMentions, { parse: [] });
        assert.strictEqual(capturado.publicado.embeds.length, 1);
        assert.match(capturado.publicado.embeds[0].data.title, /Partido Beta/);
    });

    console.log('\n[7] Camada de banco');
    await teste('obterProposta devolve o registro de u1', () => {
        const proposta = database.obterProposta('u1');
        assert.strictEqual(proposta.nome, 'Partido Gama');
        assert.strictEqual(proposta.sigla, 'PGM');
    });

    await teste('sigla: única, case-insensitive, ignora o próprio', () => {
        assert.strictEqual(database.siglaEmUso('PGM', 'u9', '1'), true);
        assert.strictEqual(database.siglaEmUso('pgm', 'u9', '1'), true);
        assert.strictEqual(database.siglaEmUso('PGM', 'u1', '1'), false);
        assert.strictEqual(database.siglaEmUso('ZZZ', 'u1', '1'), false);
    });

    await teste('nome: único e case-insensitive', () => {
        assert.strictEqual(database.nomeEmUso('partido gama', 'u9', '1'), true);
        assert.strictEqual(database.nomeEmUso('Partido Gama', 'u1', '1'), false);
    });

    await teste('mesmo fundador pode ter uma proposta isolada em outro servidor', () => {
        database.salvarIdentidade({
            fundadorId: 'u1',
            fundadorNome: 'tester',
            guildId: '2',
            nome: 'Partido Gama',
            sigla: 'PGM',
            emoji: '🎉'
        });
        assert.strictEqual(
            database.obterProposta('u1', '1').status,
            database.STATUS_FUNDADO
        );
        assert.strictEqual(
            database.obterProposta('u1', '2').status,
            database.STATUS_RASCUNHO
        );
    });

    await teste('mesmo usuário atualiza o rascunho sem duplicar', () => {
        database.salvarIdentidade({
            fundadorId: 'u9',
            fundadorNome: 'nove',
            guildId: '1',
            nome: 'Partido Alfa Renovado',
            sigla: 'PAR',
            emoji: '🅰️',
            posicionamento: null
        });
        const proposta = database.obterProposta('u9', '1');
        assert.strictEqual(proposta.sigla, 'PAR');
        assert.strictEqual(proposta.status, database.STATUS_RASCUNHO);
        assert.strictEqual(
            proposta.propostas,
            null,
            'programa anterior é descartado'
        );
    });

    await teste('limpeza remove só rascunhos expirados', () => {
        assert.strictEqual(database.limparRascunhosExpirados(-1000), 2);
        assert.strictEqual(database.obterProposta('u9', '1'), null);
        assert.strictEqual(database.obterProposta('u1', '2'), null);
        assert.ok(database.obterProposta('u2', '1'), 'u2 permanece');
    });

    await teste('limpeza respeita o TTL', () => {
        assert.strictEqual(database.limparRascunhosExpirados(60_000), 0);
    });

    database.fechar();
    fs.rmSync(DB_DIR, { recursive: true, force: true });

    console.log(falhas === 0 ? '\nTUDO OK\n' : `\n${falhas} FALHA(S)\n`);
    process.exit(falhas === 0 ? 0 : 1);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
