'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const dbEleicoes = require('../../database/eleicoes');

const PARTIDOS_DB_PATH =
    process.env.DB_PATH ||
    path.join(__dirname, '..', '..', 'database', 'partidos.db');

const DIGITOS_POR_CARGO = Object.freeze({
    'presidente': 2,
    'vice-presidente': 2,
    'governador': 2,
    'senador': 3,
    'deputado-federal': 4,
    'deputado-estadual': 6
});

const NOMES_CARGOS = Object.freeze({
    'presidente': 'Presidente',
    'vice-presidente': 'Vice-Presidente',
    'governador': 'Governador',
    'senador': 'Senador',
    'deputado-federal': 'Deputado Federal',
    'deputado-estadual': 'Deputado Estadual'
});

const ORDEM_CARGOS_PADRAO = Object.freeze([
    'deputado-estadual',
    'deputado-federal',
    'senador',
    'governador',
    'vice-presidente',
    'presidente'
]);

function abrirPartidosDb() {
    const db = new Database(PARTIDOS_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 5000');
    return db;
}

/**
 * Retorna os dígitos oficiais de cada cargo.
 */
function obterDigitosCargo(cargo) {
    return DIGITOS_POR_CARGO[cargo] ?? 2;
}

/**
 * Normaliza o número eleitoral como string, preservando zeros à esquerda
 * conforme a quantidade de dígitos exigida para o cargo.
 */
function normalizarNumero(numero, cargo) {
    if (numero === null || numero === undefined) return '';
    const numStr = String(numero).trim();
    const digitos = obterDigitosCargo(cargo);
    return numStr.padStart(digitos, '0');
}

/**
 * Carrega somente candidatos com status 'aprovado' do banco partidos.db
 * para a eleição de referência (eleicao_ref_id) e servidor informados.
 */
function carregarCandidatosAprovados(guildId, eleicaoRefId) {
    const db = abrirPartidosDb();
    try {
        const stmt = db.prepare(`
            SELECT c.id           AS candidato_id,
                   c.guild_id     AS guild_id,
                   c.eleicao_id   AS eleicao_ref_id,
                   c.politico_id  AS politico_id,
                   c.partido_id   AS partido_id,
                   c.cargo        AS cargo,
                   c.numero       AS numero_original,
                   c.status       AS status,
                   pol.nome       AS politico_nome,
                   part.nome      AS partido_nome,
                   part.sigla     AS partido_sigla,
                   part.emoji     AS partido_emoji
              FROM candidatos c
              JOIN politicos pol
                ON pol.guild_id = c.guild_id
               AND pol.discord_id = c.politico_id
              JOIN partidos part
                ON part.guild_id = c.guild_id
               AND part.id = c.partido_id
             WHERE c.guild_id = ?
               AND c.eleicao_id = ?
               AND c.status = 'aprovado'
             ORDER BY c.cargo, c.numero
        `);

        const linhas = stmt.all(guildId, eleicaoRefId);

        return linhas.map(linha => {
            const numero = normalizarNumero(linha.numero_original, linha.cargo);
            return {
                candidatoId: linha.candidato_id,
                guildId: linha.guild_id,
                eleicaoRefId: linha.eleicao_ref_id,
                politicoId: linha.politico_id,
                nome: linha.politico_nome,
                partidoId: linha.partido_id,
                partidoNome: linha.partido_nome,
                partidoSigla: linha.partido_sigla,
                partidoEmoji: linha.partido_emoji,
                cargo: linha.cargo,
                numero
            };
        });
    } finally {
        db.close();
    }
}

/**
 * Importa e congela os candidatos aprovados de partidos.db para eleicoes.db.
 */
function importarCandidatosParaEleicao(eleicaoId, guildId, eleicaoRefId) {
    const candidatos = carregarCandidatosAprovados(guildId, eleicaoRefId);
    const agora = new Date().toISOString();

    const paraInserir = candidatos.map(cand => ({
        eleicaoId,
        cargo: cand.cargo,
        candidatoId: cand.candidatoId,
        politicoId: cand.politicoId,
        nome: cand.nome,
        partidoId: cand.partidoId,
        partidoNome: cand.partidoNome,
        partidoSigla: cand.partidoSigla,
        partidoEmoji: cand.partidoEmoji,
        numero: cand.numero,
        criadoEm: agora
    }));

    if (paraInserir.length > 0) {
        dbEleicoes.inserirCandidatos(paraInserir);
    }

    return paraInserir;
}

/**
 * Retorna os cargos configuráveis padrão para uma nova eleição.
 */
function gerarCargosPadrao(cargosDesejados = null) {
    const lista = cargosDesejados && cargosDesejados.length > 0
        ? cargosDesejados
        : ['presidente', 'governador', 'senador', 'deputado-federal'];

    return lista.map((cargo, index) => ({
        cargo,
        ordem: index + 1,
        digitos: obterDigitosCargo(cargo),
        vagas: 1,
        segundoTurno: dbEleicoes.CARGOS_SEGUNDO_TURNO.includes(cargo)
    }));
}

module.exports = {
    DIGITOS_POR_CARGO,
    NOMES_CARGOS,
    ORDEM_CARGOS_PADRAO,
    obterDigitosCargo,
    normalizarNumero,
    carregarCandidatosAprovados,
    importarCandidatosParaEleicao,
    gerarCargosPadrao
};
