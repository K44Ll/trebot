'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pastaTemporaria = fs.mkdtempSync(path.join(os.tmpdir(), 'trebot-legislativo-'));
process.env.DB_PATH = path.join(pastaTemporaria, 'legislativo.db');

const quorum = require('../src/services/legislativo/quorum');
const fluxo = require('../src/services/legislativo/fluxo');
const propostaCommand = require('../src/commands/proposta');
const sistema = require('../src/services/legislativo/sistema');
let db = require('../src/database/legislativo');

for (const subcommand of propostaCommand.data.toJSON().options) {
    if (!subcommand.options) continue;
    let opcionalEncontrado = false;
    for (const option of subcommand.options) {
        if (option.required === false) opcionalEncontrado = true;
        if (opcionalEncontrado && option.required) {
            throw new Error(`Opção obrigatória depois de opcional em /proposta ${subcommand.name}.`);
        }
    }
}

function proposicao(tipo, guildId = 'guild-test') {
    return db.criarProposicao({
        guildId,
        tipo,
        titulo: `${tipo} de teste ${Math.random()}`,
        ementa: 'Ementa de teste.',
        texto: 'Art. 1º Texto de teste.',
        justificativa: 'Justificativa de teste.',
        referencias: '',
        denuncianteId: 'autor-1',
        denuncianteNome: 'Autor'
    });
}

function avaliar(regra, sim, nao, branco, total) {
    return quorum.apurarVotacao({
        sim,
        nao,
        branco,
        totalMembros: total,
        regra,
        quórumPresença: quorum.maioriaAbsoluta(total)
    });
}

function testarQuorunsFederais() {
    assert.equal(quorum.doisTerços(513), 342);
    assert.equal(quorum.doisTerços(81), 54);
    assert.equal(quorum.trêsQuintos(513), 308);
    assert.equal(quorum.trêsQuintos(81), 49);
    assert.equal(quorum.maioriaAbsoluta(513), 257);
    assert.equal(quorum.maioriaAbsoluta(81), 41);

    assert.equal(avaliar('tres_quintos', 307, 0, 0, 513).aprovado, false);
    assert.equal(avaliar('tres_quintos', 308, 0, 0, 513).aprovado, true);
    assert.equal(avaliar('tres_quintos', 48, 0, 0, 81).aprovado, false);
    assert.equal(avaliar('tres_quintos', 49, 0, 0, 81).aprovado, true);
    assert.equal(avaliar('maioria_absoluta', 256, 0, 0, 513).aprovado, false);
    assert.equal(avaliar('maioria_absoluta', 257, 0, 0, 513).aprovado, true);
    assert.equal(avaliar('dois_tercos', 341, 0, 0, 513).aprovado, false);
    assert.equal(avaliar('dois_tercos', 342, 0, 0, 513).aprovado, true);
    assert.equal(avaliar('dois_tercos', 53, 0, 0, 81).aprovado, false);
    assert.equal(avaliar('dois_tercos', 54, 0, 0, 81).aprovado, true);
}

function testarMaioriaSimplesEBrancos() {
    const aprovada = avaliar('maioria_simples', 130, 120, 7, 513);
    assert.equal(aprovada.presença, 257);
    assert.equal(aprovada.aprovado, true);
    assert.equal(aprovada.votosFavoráveisNecessários, null);
    assert.equal(avaliar('maioria_simples', 120, 130, 7, 513).aprovado, false);
    assert.equal(avaliar('maioria_simples', 140, 0, 0, 513).aprovado, false);
    assert.equal(avaliar('maioria_absoluta', 256, 1, 0, 513).aprovado, false);
}

function testarComposicaoConfiguravel() {
    assert.equal(quorum.maioriaAbsoluta(10), 6);
    assert.equal(quorum.trêsQuintos(13), 8);
    assert.equal(quorum.doisTerços(7), 5);
    db.configurar('guild-custom', { camara_total: 13, senado_total: 7 }, 'admin');
    const config = db.obterConfiguracao('guild-custom');
    assert.equal(config.camara_total, 13);
    assert.equal(config.senado_total, 7);
    assert.equal(sistema.validarComposicaoMembros(
        Array.from({ length: 7 }, (_, index) => `member-${index}`), 10
    ), true);
    assert.throws(
        () => sistema.validarComposicaoMembros(Array(11).fill('member'), 10),
        /acima da composição/
    );
}

function testarDuplicacaoAcidental() {
    const dados = {
        guildId: 'guild-duplicacao',
        tipo: 'PL',
        titulo: 'Proposta repetida',
        ementa: 'Ementa.',
        texto: 'Art. 1º.',
        justificativa: 'Justificativa.',
        referencias: '',
        denuncianteId: 'autor-1',
        denuncianteNome: 'Autor'
    };
    db.criarProposicao(dados);
    assert.throws(
        () => db.criarProposicao({ ...dados, denuncianteId: 'autor-2' }),
        error => error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    );
}

function testarVotosETramitacao() {
    const projeto = proposicao('PEC');
    const IDs = Array.from({ length: 513 }, (_, index) => `deputado-${index}`);
    const emAnalise = db.registrarEvento(
        projeto, 'ADMISSIBILIDADE_APROVADA', 'Admitida.', 'admin', 'CAMARA_TURNO_1'
    );
    const votacao = db.criarVotacao({
        proposicao: emAnalise,
        casa: 'CAMARA',
        regra: 'tres_quintos',
        totalMembros: 513,
        quórumPresença: 257,
        elegiveis: IDs,
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    assert.deepEqual(db.obterVotos(votacao.id), []);
    assert.throws(
        () => db.registrarVoto(votacao.id, 'cidadao', 'SIM'),
        /não pertence/
    );
    assert.equal(db.registrarVoto(votacao.id, IDs[0], 'BRANCO').registrado, true);
    assert.throws(
        () => db.registrarVoto(votacao.id, IDs[0], 'SIM'),
        error => error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
            error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    );
    assert.equal(db.obterVotos(votacao.id)[0].quantidade, 1);

    const tentativas = Promise.allSettled([
        Promise.resolve().then(() => db.registrarVoto(votacao.id, IDs[1], 'SIM')),
        Promise.resolve().then(() => db.registrarVoto(votacao.id, IDs[1], 'NAO'))
    ]);
    return tentativas.then(resultados => {
        db.configurar('guild-test', { camara_total: 400, senado_total: 70 }, 'admin');
        assert.equal(db.obterVotacao(votacao.id).total_membros, 513);
        assert.equal(resultados.filter(resultado => resultado.status === 'fulfilled').length, 1);
        assert.equal(resultados.filter(resultado => resultado.status === 'rejected').length, 1);

        const fechado = db.fecharVotacao(votacao.id, {
            sim: 1,
            nao: 0,
            branco: 1,
            ausências: 511,
            presença: 2,
            quórumPresença: 257,
            votosFavoráveisNecessários: 308,
            aprovado: false
        }, 'REJEITADA', 'admin');
        assert.equal(fechado.proposicao.status, 'REJEITADA');
        assert.throws(
            () => db.registrarVoto(votacao.id, IDs[2], 'SIM'),
            /encerrada/
        );
        assert.throws(
            () => db.fecharVotacao(votacao.id, {}, 'REJEITADA', 'admin'),
            /encerrada/
        );
        assert.equal(fluxo.próximaEtapa(emAnalise, false), 'REJEITADA');
        assert.equal(fluxo.próximaEtapa(emAnalise, true), 'CAMARA_TURNO_2');
    });
}

function testarFluxosEspeciais() {
    assert.deepEqual(fluxo.etapaDeVotacao({
        tipo: 'IMPEACHMENT',
        etapa: 'CAMARA_AUTORIZACAO'
    }), ['CAMARA', 'dois_tercos', 'SENADO_JULGAMENTO']);
    assert.deepEqual(fluxo.etapaDeVotacao({
        tipo: 'IMPEACHMENT',
        etapa: 'SENADO_JULGAMENTO'
    }), ['SENADO', 'dois_tercos', 'CONDENADA']);
    assert.deepEqual(fluxo.etapaDeVotacao({
        tipo: 'PLP',
        etapa: 'CAMARA_TURNO_1',
        casa_iniciadora: 'CAMARA'
    }), ['CAMARA', 'maioria_absoluta', 'SENADO_TURNO_1']);
    assert.deepEqual(fluxo.etapaDeVotacao({
        tipo: 'PL',
        etapa: 'SENADO_TURNO_1',
        casa_iniciadora: 'SENADO'
    }), ['SENADO', 'maioria_simples', 'CAMARA_TURNO_1']);
    assert.deepEqual(fluxo.etapaDeVotacao({
        tipo: 'PL',
        etapa: 'VETO_CAMARA'
    }), ['CAMARA', 'maioria_absoluta', 'VETO_SENADO']);
    assert.equal(fluxo.etapaDeVotacao({
        tipo: 'IMPEACHMENT',
        etapa: 'PROMULGADA'
    }), null);
}

async function main() {
    testarQuorunsFederais();
    testarMaioriaSimplesEBrancos();
    testarComposicaoConfiguravel();
    testarDuplicacaoAcidental();
    await testarVotosETramitacao();
    testarFluxosEspeciais();
    testarAlteracaoDaCasaRevisora();
    testarVetoParcial();
    testarConsequenciasImpeachment();

    const persistente = proposicao('PLP');
    const persistenteId = persistente.id;
    const persistenteEmAnalise = db.registrarEvento(
        persistente, 'ADMISSIBILIDADE_APROVADA', 'Admitido.', 'admin', 'CAMARA_TURNO_1',
        null, 'CAMARA'
    );
    const votacaoPendente = db.criarVotacao({
        proposicao: persistenteEmAnalise,
        casa: 'CAMARA',
        cargoRoleId: 'role-deputados',
        regra: 'maioria_absoluta',
        totalMembros: 400,
        quórumPresença: 201,
        elegiveis: ['deputado-1'],
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    db.fechar();
    if (databasePartidos) databasePartidos.fechar();
    delete require.cache[require.resolve('../src/database/legislativo')];
    db = require('../src/database/legislativo');
    assert.equal(db.obterProposicao(persistenteId, 'guild-test').titulo, persistente.titulo);
    assert.equal(db.obterVotacao(votacaoPendente.id).estado, 'ABERTA');
    db.fechar();

    for (const sufixo of ['', '-wal', '-shm']) {
        const arquivo = `${process.env.DB_PATH}${sufixo}`;
        if (fs.existsSync(arquivo)) fs.unlinkSync(arquivo);
    }
    fs.rmdirSync(pastaTemporaria);
    console.log('Testes legislativos passaram.');
}

function testarAlteracaoDaCasaRevisora() {
    const projeto = proposicao('PL', 'guild-revisao');
    assert.equal(projeto.autor_id, 'autor-1');
    const camaraInicial = db.registrarEvento(
        projeto, 'ADMISSIBILIDADE_APROVADA', 'Admitida.', 'admin',
        'CAMARA_TURNO_1', null, 'CAMARA'
    );
    const primeiraEtapa = fluxo.etapaDeVotacao(camaraInicial);
    assert.deepEqual(primeiraEtapa, ['CAMARA', 'maioria_simples', 'SENADO_TURNO_1']);
    const votoCamara = db.criarVotacao({
        proposicao: camaraInicial,
        casa: 'CAMARA',
        cargoRoleId: 'deputados',
        regra: 'maioria_simples',
        totalMembros: 3,
        quórumPresença: 2,
        elegiveis: ['dep-1', 'dep-2', 'dep-3'],
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    db.registrarVoto(votoCamara.id, 'dep-1', 'SIM');
    db.registrarVoto(votoCamara.id, 'dep-2', 'SIM');
    const camaraAprovou = avaliar('maioria_simples', 2, 0, 0, 3);
    const enviadaAoSenado = db.fecharVotacao(
        votoCamara.id, camaraAprovou, 'SENADO_TURNO_1', 'admin'
    ).proposicao;

    const alterada = db.revisarTexto(
        enviadaAoSenado,
        'Art. 1º Texto revisto.\nArt. 2º Dispositivo adicional.',
        'admin'
    );
    assert.equal(alterada.revisao_pendente, 1);
    assert.equal(
        db.listarHistorico(alterada.id).at(-1).evento,
        'TEXTO_ALTERADO_PELA_CASA_REVISORA'
    );
    const votoSenado = db.criarVotacao({
        proposicao: alterada,
        casa: 'SENADO',
        cargoRoleId: 'senadores',
        regra: 'maioria_simples',
        totalMembros: 3,
        quórumPresença: 2,
        elegiveis: ['sen-1', 'sen-2', 'sen-3'],
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    assert.throws(
        () => db.revisarTexto(alterada, 'Texto novo posterior à abertura.', 'admin'),
        /já foi aberta/
    );
    db.registrarVoto(votoSenado.id, 'sen-1', 'SIM');
    db.registrarVoto(votoSenado.id, 'sen-2', 'SIM');
    const senatePass = avaliar('maioria_simples', 2, 0, 0, 3);
    const returnStage = fluxo.próximaEtapa(
        alterada,
        senatePass.aprovado
    );
    assert.equal(returnStage, 'RETORNO_CAMARA');
    const returned = db.fecharVotacao(
        votoSenado.id, senatePass, returnStage, 'admin'
    ).proposicao;
    assert.equal(returned.etapa, 'RETORNO_CAMARA');
    const retorno = fluxo.etapaDeVotacao(returned);
    assert.deepEqual(retorno, ['CAMARA', 'maioria_simples', 'SANCAO']);
    assert.equal(fluxo.próximaEtapa(
        { ...returned, revisao_pendente: 0 },
        true
    ), 'SANCAO');
}

function testarVetoParcial() {
    const texto = 'Art. 1º Mantém-se.\nArt. 2º Dispositivo vetado.\nArt. 3º Também mantém-se.';
    const trechos = sistema.separarDispositivosVeto(
        texto,
        'Art. 2º Dispositivo vetado.'
    );
    assert.deepEqual(trechos, ['Art. 2º Dispositivo vetado.']);
    assert.equal(
        sistema.removerDispositivosVetados(texto, trechos),
        'Art. 1º Mantém-se.\n\nArt. 3º Também mantém-se.'
    );
    assert.throws(
        () => sistema.separarDispositivosVeto(texto, 'Art. 4º Inexistente.'),
        /copiado integralmente/
    );
    assert.throws(
        () => sistema.separarDispositivosVeto(texto, 'apenas uma frase'),
        /identificador integral/
    );

    const projeto = db.criarProposicao({
        guildId: 'guild-veto',
        tipo: 'PL',
        titulo: 'Lei parcial',
        ementa: 'Teste de veto.',
        texto,
        justificativa: 'Teste.',
        referencias: '',
        autorId: 'autor',
        autorNome: 'Autor',
        denuncianteId: 'autor',
        denuncianteNome: 'Autor'
    });
    const emSancao = db.registrarEvento(
        projeto, 'APROVADA_CASAS', 'Aprovada.', 'admin', 'SANCAO', null, 'CAMARA'
    );
    const comVeto = db.registrarVeto(emSancao, {
        tipo: 'PARCIAL',
        justificativa: 'Contrariedade ao interesse público.',
        dispositivos: trechos
    }, 'presidente');
    assert.equal(db.obterVeto(projeto.id).tipo, 'PARCIAL');

    const casa = { etapa: 'VETO_CAMARA', ...comVeto };
    const votoCamara = db.criarVotacao({
        proposicao: casa,
        casa: 'CAMARA',
        cargoRoleId: 'dep',
        regra: 'maioria_absoluta',
        totalMembros: 3,
        quórumPresença: 2,
        elegiveis: ['d1', 'd2', 'd3'],
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    const camaraResultado = {
        ...avaliar('maioria_absoluta', 1, 2, 0, 3),
        vetoEmAnalise: true
    };
    const naCamara = db.fecharVotacao(
        votoCamara.id, camaraResultado, 'VETO_SENADO', 'admin'
    ).proposicao;
    const votoSenado = db.criarVotacao({
        proposicao: naCamara,
        casa: 'SENADO',
        cargoRoleId: 'sen',
        regra: 'maioria_absoluta',
        totalMembros: 3,
        quórumPresença: 2,
        elegiveis: ['s1', 's2', 's3'],
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    const resultadoFinal = {
        ...avaliar('maioria_absoluta', 1, 2, 0, 3),
        vetoFinalizado: true,
        vetoMantido: true,
        etapaFinal: 'PROMULGADA',
        textoVigente: sistema.removerDispositivosVetados(texto, trechos)
    };
    const promulgada = db.fecharVotacao(
        votoSenado.id, resultadoFinal, 'PROMULGADA', 'admin'
    ).proposicao;
    assert.equal(promulgada.status, 'CONCLUIDA');
    assert.equal(promulgada.etapa, 'PROMULGADA');
    assert.equal(promulgada.texto_vigente.includes('Art. 2º'), false);
    assert.equal(db.listarHistorico(projeto.id).at(-1).evento, 'VETO_MANTIDO');
    testarResultadoVetoTotal(false);
    testarResultadoVetoTotal(true);
}

function testarResultadoVetoTotal(rejeitadoPelasCasas) {
    const projeto = proposicao('PL', 'guild-veto-total');
    const emSancao = db.registrarEvento(
        projeto, 'APROVADA_CASAS', 'Aprovada.', 'admin', 'SANCAO', null, 'CAMARA'
    );
    const comVeto = db.registrarVeto(emSancao, {
        tipo: 'TOTAL',
        justificativa: 'Teste do veto total.',
        dispositivos: []
    }, 'presidente');
    const criarVotacaoVeto = (proposicaoAtual, casa, etapa) => db.criarVotacao({
        proposicao: { ...proposicaoAtual, etapa },
        casa,
        cargoRoleId: casa,
        regra: 'maioria_absoluta',
        totalMembros: 3,
        quórumPresença: 2,
        elegiveis: [`${casa}-1`, `${casa}-2`, `${casa}-3`],
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    const resultadoCasa = (casa, rejeitado) => ({
        ...avaliar(
            'maioria_absoluta',
            rejeitado ? 2 : 1,
            rejeitado ? 1 : 2,
            0,
            3
        ),
        ...(casa === 'SENADO' && {
            vetoFinalizado: true,
            vetoMantido: !rejeitadoPelasCasas,
            etapaFinal: rejeitadoPelasCasas ? 'PROMULGADA' : 'REJEITADA'
        }),
        ...(casa === 'CAMARA' && { vetoEmAnalise: true })
    });
    const rejeitadoNestaCasa = rejeitadoPelasCasas;
    const votoCamara = criarVotacaoVeto(comVeto, 'CAMARA', 'VETO_CAMARA');
    const naCamara = db.fecharVotacao(
        votoCamara.id,
        resultadoCasa('CAMARA', rejeitadoNestaCasa),
        'VETO_SENADO',
        'admin'
    ).proposicao;
    const votoSenado = criarVotacaoVeto(naCamara, 'SENADO', 'VETO_SENADO');
    const final = db.fecharVotacao(
        votoSenado.id,
        resultadoCasa('SENADO', rejeitadoNestaCasa),
        rejeitadoPelasCasas ? 'PROMULGADA' : 'REJEITADA',
        'admin'
    ).proposicao;
    assert.equal(final.etapa, rejeitadoPelasCasas ? 'PROMULGADA' : 'REJEITADA');
    assert.equal(final.status, rejeitadoPelasCasas ? 'CONCLUIDA' : 'REJEITADA');
}

let databasePartidos;

function testarConsequenciasImpeachment() {
    const denúncia = db.criarProposicao({
        guildId: 'guild-impeachment',
        tipo: 'IMPEACHMENT',
        titulo: 'Denúncia de teste',
        ementa: 'Alegações para teste.',
        texto: 'Fatos alegados.',
        justificativa: 'Fundamentação de teste.',
        referencias: '',
        denunciadoId: 'president-user',
        denunciado: 'Autoridade',
        cargoDenunciado: 'Presidente da República',
        denuncianteId: 'denunciante',
        denuncianteNome: 'Denunciante'
    });
    const autorizacao = db.registrarEvento(
        denúncia, 'DENUNCIA_ADMITIDA', 'Admitida.', 'admin', 'CAMARA_AUTORIZACAO'
    );
    const camara = db.criarVotacao({
        proposicao: autorizacao,
        casa: 'CAMARA',
        cargoRoleId: 'deputados',
        regra: 'dois_tercos',
        totalMembros: 3,
        quórumPresença: 2,
        elegiveis: ['dep-1', 'dep-2', 'dep-3'],
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    db.registrarVoto(camara.id, 'dep-1', 'SIM');
    db.registrarVoto(camara.id, 'dep-2', 'SIM');
    const apuraçãoCamara = avaliar('dois_tercos', 2, 0, 0, 3);
    const autorizado = db.fecharVotacao(
        camara.id, apuraçãoCamara, 'SENADO_JULGAMENTO', 'admin'
    ).proposicao;
    const senado = db.criarVotacao({
        proposicao: autorizado,
        casa: 'SENADO',
        cargoRoleId: 'senadores',
        regra: 'dois_tercos',
        totalMembros: 3,
        quórumPresença: 2,
        elegiveis: ['sen-1', 'sen-2', 'sen-3'],
        iniciadaPor: 'admin',
        prazoHoras: 48
    });
    db.registrarVoto(senado.id, 'sen-1', 'SIM');
    db.registrarVoto(senado.id, 'sen-2', 'SIM');
    const condenação = db.fecharVotacao(
        senado.id, avaliar('dois_tercos', 2, 0, 0, 3), 'CONDENADA', 'admin'
    ).proposicao;
    assert.equal(condenação.status, 'CONCLUIDA');

    const inabilitação = db.obterInabilitacaoAtiva(
        'guild-impeachment',
        'president-user'
    );
    assert.ok(inabilitação);
    assert.ok(Date.parse(inabilitação.fim_em) - Date.parse(inabilitação.inicio_em) >
        7.99 * 365 * 24 * 60 * 60 * 1000);

    databasePartidos = require('../src/database');
    assert.throws(
        () => databasePartidos.solicitarCandidatura({
            guildId: 'guild-impeachment',
            eleicaoId: 1,
            politicoId: 'president-user',
            nome: 'Presidente',
            cargo: 'presidente'
        }),
        /inabilitado/
    );
}

main().catch(error => {
    if (db.open) db.fechar();
    if (databasePartidos?.fechar) databasePartidos.fechar();
    for (const sufixo of ['', '-wal', '-shm']) {
        const arquivo = `${process.env.DB_PATH}${sufixo}`;
        if (fs.existsSync(arquivo)) fs.unlinkSync(arquivo);
    }
    if (fs.existsSync(pastaTemporaria)) fs.rmdirSync(pastaTemporaria);
    console.error(error);
    process.exitCode = 1;
});
