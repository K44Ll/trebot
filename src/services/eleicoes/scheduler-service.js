'use strict';

const dbEleicoes = require('../../database/eleicoes');

// Armazena timers em memória referenciados por agendamentoId para permitir cancelamento limpo
const timersAtivos = new Map();

/**
 * Executa a abertura do segundo turno para uma eleição.
 */
async function executarAberturaSegundoTurno(agendamentoId, client = null) {
    const agendamento = dbEleicoes.obterAgendamento(agendamentoId);
    if (!agendamento || agendamento.status !== 'pendente') {
        return { executado: false, motivo: 'agendamento_invalido_ou_ja_processado' };
    }

    dbEleicoes.atualizarStatusAgendamento(agendamentoId, 'executando');

    try {
        const eleicao = dbEleicoes.obterEleicaoPorId(agendamento.eleicao_id);
        if (!eleicao) {
            throw new Error(`Eleição ${agendamento.eleicao_id} não encontrada.`);
        }

        const agora = new Date().toISOString();

        // Promove a eleição para o turno 2 e reabre o status
        dbEleicoes.atualizarEleicao(eleicao.id, {
            turno: 2,
            status: dbEleicoes.STATUS_ELEICAO.ABERTA
        });

        const cargos = dbEleicoes.listarCargos(eleicao.id);
        for (const cargo of cargos) {
            const resultadoCargo = dbEleicoes.obterResultadoCargo(eleicao.id, cargo.cargo, 1);
            if (resultadoCargo && resultadoCargo.aguarda_segundo_turno) {
                // Reabre o cargo para o 2º turno
                dbEleicoes.atualizarCargo(eleicao.id, cargo.cargo, {
                    turno_atual: 2,
                    status: dbEleicoes.STATUS_CARGO.ABERTA,
                    situacao: dbEleicoes.SITUACAO.EM_ANDAMENTO,
                    aberta_em: agora
                });
            } else {
                // Cargo encerrado no 1º turno
                dbEleicoes.atualizarCargo(eleicao.id, cargo.cargo, {
                    status: dbEleicoes.STATUS_CARGO.ENCERRADA,
                    situacao: dbEleicoes.SITUACAO.ENCERRADA,
                    encerrada_em: agora
                });
            }
        }

        dbEleicoes.atualizarStatusAgendamento(agendamentoId, 'executado', 'Segundo turno aberto com sucesso.');

        dbEleicoes.registrarAuditoria({
            eleicaoId: eleicao.id,
            guildId: eleicao.guildId,
            evento: 'segundo_turno_aberto',
            detalhe: `Segundo turno aberto para a eleição ${eleicao.nome} (ID ${eleicao.id}).`
        });

        // Notifica canal se configurado e bot conectado
        if (client && eleicao.canalId) {
            try {
                const canal = await client.channels.fetch(eleicao.canalId).catch(() => null);
                if (canal && canal.isTextBased()) {
                    await canal.send({
                        content: `🗳️ **SEGUNDO TURNO ABERTO!**\nA votação para o 2º turno da eleição **${eleicao.nome}** começou agora na Urna Eletrônica.`
                    }).catch(() => {});
                }
            } catch {
                // Ignora falhas de envio de mensagem no canal
            }
        }

        timersAtivos.delete(agendamentoId);
        return { executado: true, eleicaoId: eleicao.id };
    } catch (error) {
        dbEleicoes.atualizarStatusAgendamento(agendamentoId, 'falhou', error.message);
        timersAtivos.delete(agendamentoId);
        throw error;
    }
}

/**
 * Executa o encerramento automático de uma eleição que atingiu o prazo.
 */
async function executarEncerramentoAutomatico(agendamentoId, client = null) {
    const agendamento = dbEleicoes.obterAgendamento(agendamentoId);
    if (!agendamento || agendamento.status !== 'pendente') {
        return { executado: false, motivo: 'agendamento_invalido_ou_ja_processado' };
    }

    dbEleicoes.atualizarStatusAgendamento(agendamentoId, 'executando');

    try {
        const eleicao = dbEleicoes.obterEleicaoPorId(agendamento.eleicao_id);
        if (!eleicao) {
            throw new Error(`Eleição ${agendamento.eleicao_id} não encontrada.`);
        }

        const apuracaoService = require('./apuracao-service');
        const agora = new Date().toISOString();

        dbEleicoes.encerrarEleicao(eleicao.id, agora);
        const resultadoApuracao = apuracaoService.apurarEleicaoCompleta(eleicao.id, eleicao.guildId);

        dbEleicoes.atualizarStatusAgendamento(agendamentoId, 'executado', 'Eleição encerrada e apurada automaticamente.');

        // Se presidente ou governador necessitar de segundo turno, agenda automaticamente
        if (resultadoApuracao.necessitaSegundoTurno && eleicao.turno === 1) {
            agendarSegundoTurno({
                eleicaoId: eleicao.id,
                guildId: eleicao.guildId,
                client
            });
        }

        timersAtivos.delete(agendamentoId);
        return { executado: true, eleicaoId: eleicao.id };
    } catch (error) {
        dbEleicoes.atualizarStatusAgendamento(agendamentoId, 'falhou', error.message);
        timersAtivos.delete(agendamentoId);
        throw error;
    }
}

/**
 * Agenda o segundo turno para uma eleição no banco e em memória.
 */
function agendarSegundoTurno({
    eleicaoId,
    guildId,
    client = null,
    atrasoMs = dbEleicoes.SEGUNDO_TURNO_ATRASO_MS
}) {
    const executarEm = new Date(Date.now() + atrasoMs).toISOString();

    const agendamento = dbEleicoes.criarAgendamento({
        eleicaoId,
        tipo: dbEleicoes.TIPO_AGENDAMENTO.ABRIR_SEGUNDO_TURNO,
        cargo: '',
        turno: 2,
        executarEm,
        detalhe: `Segundo turno agendado para ${executarEm}`
    });

    dbEleicoes.registrarAuditoria({
        eleicaoId,
        guildId,
        evento: 'segundo_turno_agendado',
        detalhe: `Segundo turno agendado para executar em ${executarEm} (em ${Math.round(atrasoMs / 1000)}s).`
    });

    // Cancela timer anterior se houver
    if (timersAtivos.has(agendamento.id)) {
        clearTimeout(timersAtivos.get(agendamento.id));
    }

    const timer = setTimeout(() => {
        executarAberturaSegundoTurno(agendamento.id, client).catch(err => {
            console.error(`[SCHEDULER ERROR] Falha ao abrir segundo turno #${agendamento.id}:`, err);
        });
    }, Math.max(0, atrasoMs));

    if (timer.unref) timer.unref();
    timersAtivos.set(agendamento.id, timer);

    return agendamento;
}

/**
 * Agenda o encerramento automático de uma eleição com base na duração em minutos.
 */
function agendarEncerramentoEleicao({
    eleicaoId,
    guildId,
    encerraEm,
    client = null
}) {
    const atrasoMs = new Date(encerraEm).getTime() - Date.now();

    const agendamento = dbEleicoes.criarAgendamento({
        eleicaoId,
        tipo: dbEleicoes.TIPO_AGENDAMENTO.ENCERRAR_ELEICAO,
        cargo: '',
        turno: 1,
        executarEm: encerraEm,
        detalhe: `Encerramento automático agendado para ${encerraEm}`
    });

    if (timersAtivos.has(agendamento.id)) {
        clearTimeout(timersAtivos.get(agendamento.id));
    }

    const timer = setTimeout(() => {
        executarEncerramentoAutomatico(agendamento.id, client).catch(err => {
            console.error(`[SCHEDULER ERROR] Falha ao encerrar eleição #${eleicaoId}:`, err);
        });
    }, Math.max(0, atrasoMs));

    if (timer.unref) timer.unref();
    timersAtivos.set(agendamento.id, timer);

    return agendamento;
}

/**
 * Recupera e reativa todos os agendamentos pendentes do banco SQLite.
 * Chamado na inicialização do bot para resiliência a reinicializações.
 */
async function recuperarAgendamentos(client = null) {
    const agora = new Date().toISOString();
    const pendentes = dbEleicoes.listarAgendamentosPendentes();

    for (const agendamento of pendentes) {
        const atrasoMs = new Date(agendamento.executar_em).getTime() - Date.now();

        if (atrasoMs <= 0) {
            // Horário já passou: executa imediatamente
            if (agendamento.tipo === dbEleicoes.TIPO_AGENDAMENTO.ABRIR_SEGUNDO_TURNO) {
                await executarAberturaSegundoTurno(agendamento.id, client).catch(console.error);
            } else if (agendamento.tipo === dbEleicoes.TIPO_AGENDAMENTO.ENCERRAR_ELEICAO) {
                await executarEncerramentoAutomatico(agendamento.id, client).catch(console.error);
            }
        } else {
            // Horário futuro: agenda timer em memória para o tempo restante
            if (timersAtivos.has(agendamento.id)) {
                clearTimeout(timersAtivos.get(agendamento.id));
            }

            const handler = agendamento.tipo === dbEleicoes.TIPO_AGENDAMENTO.ABRIR_SEGUNDO_TURNO
                ? () => executarAberturaSegundoTurno(agendamento.id, client)
                : () => executarEncerramentoAutomatico(agendamento.id, client);

            const timer = setTimeout(() => {
                handler().catch(console.error);
            }, atrasoMs);

            if (timer.unref) timer.unref();
            timersAtivos.set(agendamento.id, timer);
        }
    }

    return pendentes.length;
}

/**
 * Limpa todos os timers ativos em memória (para encerramento limpo nos testes).
 */
function limparTimers() {
    for (const timer of timersAtivos.values()) {
        clearTimeout(timer);
    }
    timersAtivos.clear();
}

module.exports = {
    agendarSegundoTurno,
    agendarEncerramentoEleicao,
    executarAberturaSegundoTurno,
    executarEncerramentoAutomatico,
    recuperarAgendamentos,
    limparTimers
};
