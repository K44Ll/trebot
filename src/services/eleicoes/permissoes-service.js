'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { PermissionFlagsBits } = require('discord.js');
const dbEleicoes = require('../../database/eleicoes');

const PARTIDOS_DB_PATH =
    process.env.DB_PATH ||
    path.join(__dirname, '..', '..', 'database', 'partidos.db');

/**
 * Valida se a interação partiu de um administrador com permissão adequada.
 */
function verificarPermissaoAdmin(interaction) {
    if (!interaction.guildId || !interaction.memberPermissions) {
        return false;
    }

    return (
        interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild) ||
        interaction.memberPermissions.has(PermissionFlagsBits.Administrator)
    );
}

/**
 * Verifica se um usuário do Discord é filiado ativo em algum partido no servidor.
 */
function verificarFiliacao(guildId, discordId) {
    const db = new Database(PARTIDOS_DB_PATH, { readonly: true });
    try {
        const politico = db
            .prepare(`
                SELECT pol.partido_id
                  FROM politicos pol
                  JOIN partidos part
                    ON part.guild_id = pol.guild_id
                   AND part.id = pol.partido_id
                 WHERE pol.guild_id = ?
                   AND pol.discord_id = ?
                   AND pol.partido_id IS NOT NULL
                   AND part.status = 'ativo'
            `)
            .get(guildId, discordId);

        return Boolean(politico);
    } finally {
        db.close();
    }
}

/**
 * Verifica se o eleitor está apto a votar na eleição e no turno atual.
 */
function verificarElegibilidadeEleitor(eleicao, discordId) {
    if (!eleicao) {
        return { autorizacao: false, motivo: 'eleicao_inexistente' };
    }

    if (eleicao.status === dbEleicoes.STATUS_ELEICAO.CONFIGURADA) {
        return { autorizacao: false, motivo: 'eleicao_nao_iniciada' };
    }

    if (eleicao.status === dbEleicoes.STATUS_ELEICAO.CANCELADA) {
        return { autorizacao: false, motivo: 'eleicao_cancelada' };
    }

    if (eleicao.status === dbEleicoes.STATUS_ELEICAO.ENCERRADA) {
        return { autorizacao: false, motivo: 'eleicao_encerrada' };
    }

    if (eleicao.encerraEm && new Date().toISOString() >= eleicao.encerraEm) {
        return { autorizacao: false, motivo: 'prazo_encerrado' };
    }

    // Regra de eleitorado (todos vs somente filiados)
    if (eleicao.eleitorado === dbEleicoes.ELEITORADO.FILIADOS) {
        const filiado = verificarFiliacao(eleicao.guildId, discordId);
        if (!filiado) {
            return { autorizacao: false, motivo: 'somente_filiados' };
        }
    }

    // Verifica se já votou e concluiu a cédula no turno atual
    const eleitor = dbEleicoes.obterEleitor(eleicao.id, discordId, eleicao.turno);
    if (eleitor && eleitor.status === 'concluido') {
        return { autorizacao: false, motivo: 'ja_votou' };
    }

    return { autorizacao: true };
}

/**
 * Registra evento administrativo na auditoria.
 */
function registrarAuditoria(eleicaoId, guildId, evento, detalhe, atorId) {
    return dbEleicoes.registrarAuditoria({
        eleicaoId,
        guildId,
        evento,
        detalhe,
        atorId
    });
}

module.exports = {
    verificarPermissaoAdmin,
    verificarFiliacao,
    verificarElegibilidadeEleitor,
    registrarAuditoria
};
