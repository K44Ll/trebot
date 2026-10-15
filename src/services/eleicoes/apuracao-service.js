'use strict';

const dbEleicoes = require('../../database/eleicoes');

/**
 * Política explícita e determinística de desempate para classificação
 * e vitória eleitoral:
 * 1) Maior número de votos nominais.
 * 2) Em caso de empate, menor ID de cadastro na eleição (registro mais antigo).
 * Motivo registrado em auditoria para transparência e reproducibilidade.
 */
function ordenarCandidatosComDesempate(candidatos) {
    return [...candidatos].sort((a, b) => {
        if (b.votos !== a.votos) {
            return b.votos - a.votos;
        }
        // Desempate determinístico: menor ID
        return a.id - b.id;
    });
}

/**
 * Apura os votos de um cargo específico em uma eleição e turno, aplicando
 * as regras constitucionais simuladas (maioria absoluta para presidente e
 * governador no 1º turno; maioria simples no 2º turno e para os demais cargos).
 */
function apurarCargo({ eleicaoId, cargo, turno, guildId = '' }) {
    const apuracaoBruta = dbEleicoes.apurarVotos(eleicaoId, cargo, turno);
    const cargoDb = dbEleicoes.obterCargo(eleicaoId, cargo);
    const permiteSegundoTurno =
        cargoDb?.segundoTurno ||
        dbEleicoes.CARGOS_SEGUNDO_TURNO.includes(cargo);

    const ordenados = ordenarCandidatosComDesempate(apuracaoBruta.candidatos);
    const validos = apuracaoBruta.validos;
    const totalVotos = apuracaoBruta.total;

    let vencedorId = null;
    let situacao = dbEleicoes.SITUACAO.ENCERRADA;
    let aguardaSegundoTurno = false;
    let observacao = null;
    let classificadosSegundoTurno = [];
    let eliminadosSegundoTurno = [];

    // Cenário: Nenhum voto registrado ou apenas brancos/nulos
    if (validos === 0) {
        if (ordenados.length === 0) {
            situacao = dbEleicoes.SITUACAO.SEM_VENCEDOR;
            observacao = 'Nenhum candidato concorreu para este cargo.';
        } else if (permiteSegundoTurno && turno === 1) {
            // Contingência: nenhum voto válido no 1º turno para presidente/governador
            aguardaSegundoTurno = true;
            situacao = dbEleicoes.SITUACAO.AGUARDANDO_SEGUNDO_TURNO;
            const top2 = ordenados.slice(0, 2);
            classificadosSegundoTurno = top2.map(c => c.id);
            eliminadosSegundoTurno = ordenados.slice(2).map(c => c.id);
            observacao =
                'Contingência: eleição sem votos válidos no 1º turno. Dois primeiros inscritos avançam para o 2º turno.';

            if (guildId) {
                dbEleicoes.registrarAuditoria({
                    eleicaoId,
                    guildId,
                    evento: 'apuracao_contingencia_sem_votos_validos',
                    detalhe: `Cargo ${cargo}: avanço de contingência para segundo turno dos candidatos IDs [${classificadosSegundoTurno.join(', ')}]`
                });
            }
        } else {
            situacao = dbEleicoes.SITUACAO.SEM_VENCEDOR;
            observacao = 'Nenhum candidato recebeu votos válidos.';
        }
    } else if (permiteSegundoTurno && turno === 1) {
        const primeiro = ordenados[0];
        const percentualPrimeiro = (primeiro.votos / validos) * 100;

        // Regra de maioria absoluta: mais de 50% dos votos válidos
        if (primeiro.votos > validos / 2) {
            vencedorId = primeiro.id;
            situacao = dbEleicoes.SITUACAO.ENCERRADA;
            observacao = `Eleito em 1º turno com ${percentualPrimeiro.toFixed(2)}% dos votos válidos.`;
        } else {
            // Não atingiu mais de 50%: classifica os dois mais votados
            aguardaSegundoTurno = true;
            situacao = dbEleicoes.SITUACAO.AGUARDANDO_SEGUNDO_TURNO;

            const top2 = ordenados.slice(0, 2);
            classificadosSegundoTurno = top2.map(c => c.id);
            eliminadosSegundoTurno = ordenados.slice(2).map(c => c.id);

            const segundo = ordenados[1];
            const houveEmpateSegundoLugar =
                ordenados.length > 2 && ordenados[2].votos === segundo.votos;

            observacao = `Segundo turno necessário. Nenhum candidato obteve mais de 50% dos votos válidos (líder com ${percentualPrimeiro.toFixed(2)}%).`;

            if (houveEmpateSegundoLugar && guildId) {
                dbEleicoes.registrarAuditoria({
                    eleicaoId,
                    guildId,
                    evento: 'desempate_segundo_turno',
                    detalhe: `Cargo ${cargo}: empate para a 2ª vaga entre ${segundo.nome} (ID ${segundo.id}) e ${ordenados[2].nome} (ID ${ordenados[2].id}). Desempatado pelo critério determinístico de menor ID a favor de ${segundo.nome}.`
                });
            }
        }
    } else {
        // Demais cargos ou 2º turno: maioria simples
        const primeiro = ordenados[0];
        vencedorId = primeiro.id;
        situacao = dbEleicoes.SITUACAO.ENCERRADA;

        const houveEmpatePrimeiroLugar =
            ordenados.length > 1 && ordenados[1].votos === primeiro.votos;

        if (houveEmpatePrimeiroLugar) {
            observacao = `Eleito por critério de desempate (menor ID) após empate de ${primeiro.votos} voto(s).`;
            if (guildId) {
                dbEleicoes.registrarAuditoria({
                    eleicaoId,
                    guildId,
                    evento: 'desempate_vitoria',
                    detalhe: `Cargo ${cargo} (turno ${turno}): empate no 1º lugar entre ${primeiro.nome} (ID ${primeiro.id}) e ${ordenados[1].nome} (ID ${ordenados[1].id}). Vencedor definido pelo menor ID: ${primeiro.nome}.`
                });
            }
        } else {
            observacao = `Eleito com ${((primeiro.votos / validos) * 100).toFixed(2)}% dos votos válidos.`;
        }
    }

    // Persiste os resultados agregados e a situação do cargo
    dbEleicoes.salvarResultado({
        eleicaoId,
        apuracao: {
            ...apuracaoBruta,
            candidatos: ordenados
        },
        situacao,
        vencedorId,
        aguardaSegundoTurno,
        observacao
    });

    return {
        eleicaoId,
        cargo,
        turno,
        situacao,
        vencedorId,
        aguardaSegundoTurno,
        observacao,
        apuracao: {
            ...apuracaoBruta,
            candidatos: ordenados
        },
        classificadosSegundoTurno,
        eliminadosSegundoTurno
    };
}

/**
 * Apura todos os cargos abertos de uma eleição para o turno atual.
 */
function apurarEleicaoCompleta(eleicaoId, guildId = '') {
    const eleicao = dbEleicoes.obterEleicaoPorId(eleicaoId);
    if (!eleicao) throw new Error('Eleição não encontrada.');

    const cargos = dbEleicoes.listarCargos(eleicaoId);
    const resultadosPorCargo = [];

    for (const cargo of cargos) {
        const resultado = apurarCargo({
            eleicaoId,
            cargo: cargo.cargo,
            turno: cargo.turnoAtual,
            guildId: guildId || eleicao.guildId
        });
        resultadosPorCargo.push(resultado);
    }

    const algumAguardaSegundoTurno = resultadosPorCargo.some(
        res => res.aguardaSegundoTurno
    );

    return {
        eleicao,
        resultadosPorCargo,
        necessitaSegundoTurno: algumAguardaSegundoTurno
    };
}

module.exports = {
    ordenarCandidatosComDesempate,
    apurarCargo,
    apurarEleicaoCompleta
};
