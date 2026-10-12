'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'partidos.db');
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_RASCUNHO = 'rascunho';
const STATUS_AGUARDANDO_APOIO = 'Aguardando apoiadores';
const STATUS_FUNDADO = 'Partido fundado';
const APOIOS_PADRAO = 5;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const criarTabelaPropostas = () =>
    db.exec(`
        CREATE TABLE propostas (
            guild_id       TEXT NOT NULL DEFAULT '',
            fundador_id    TEXT NOT NULL,
            fundador_nome  TEXT NOT NULL,
            nome           TEXT NOT NULL,
            sigla          TEXT NOT NULL,
            emoji          TEXT NOT NULL,
            posicionamento TEXT,
            propostas      TEXT,
            valores        TEXT,
            status         TEXT NOT NULL DEFAULT '${STATUS_RASCUNHO}',
            criado_em      TEXT NOT NULL,
            atualizado_em  TEXT NOT NULL,
            canal_id       TEXT,
            mensagem_id    TEXT,
            PRIMARY KEY (guild_id, fundador_id)
        )
    `);

function migrarPropostasLegadas() {
    const tabela = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'propostas'")
        .get();
    if (!tabela) {
        criarTabelaPropostas();
        return;
    }

    const info = db.pragma('table_info(propostas)');
    const colunas = new Set(info.map(coluna => coluna.name));
    const chavePrimaria = info
        .filter(coluna => coluna.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map(coluna => coluna.name);

    if (colunas.has('guild_id') && chavePrimaria.join(',') === 'guild_id,fundador_id') {
        return;
    }

    const guildId = colunas.has('guild_id') ? 'guild_id' : "''";
    const canalId = colunas.has('canal_id') ? 'canal_id' : 'NULL';
    const mensagemId = colunas.has('mensagem_id') ? 'mensagem_id' : 'NULL';

    db.transaction(() => {
        db.exec('ALTER TABLE propostas RENAME TO propostas_legadas');
        criarTabelaPropostas();
        db.exec(`
            INSERT INTO propostas (
                guild_id, fundador_id, fundador_nome, nome, sigla, emoji,
                posicionamento, propostas, valores, status, criado_em,
                atualizado_em, canal_id, mensagem_id
            )
            SELECT ${guildId}, fundador_id, fundador_nome, nome, sigla, emoji,
                   posicionamento, propostas, valores, status, criado_em,
                   atualizado_em, ${canalId}, ${mensagemId}
              FROM propostas_legadas
        `);
        db.exec('DROP TABLE propostas_legadas');
    }).immediate();
}

migrarPropostasLegadas();

db.exec(`
    CREATE TABLE IF NOT EXISTS configuracoes (
        guild_id       TEXT PRIMARY KEY,
        canal_apoio_id TEXT,
        minimo_apoios  INTEGER NOT NULL DEFAULT ${APOIOS_PADRAO}
    );

    CREATE TABLE IF NOT EXISTS apoios (
        guild_id    TEXT NOT NULL,
        fundador_id TEXT NOT NULL,
        apoiador_id TEXT NOT NULL,
        criado_em   TEXT NOT NULL,
        PRIMARY KEY (guild_id, fundador_id, apoiador_id),
        FOREIGN KEY (guild_id, fundador_id)
            REFERENCES propostas(guild_id, fundador_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS partidos (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id       TEXT NOT NULL,
        fundador_id    TEXT NOT NULL,
        fundador_nome  TEXT NOT NULL,
        nome           TEXT NOT NULL,
        sigla          TEXT NOT NULL,
        emoji          TEXT NOT NULL,
        posicionamento TEXT NOT NULL,
        propostas      TEXT NOT NULL,
        valores        TEXT NOT NULL,
        fundado_em     TEXT NOT NULL,
        UNIQUE (guild_id, fundador_id),
        UNIQUE (guild_id, nome COLLATE NOCASE),
        UNIQUE (guild_id, sigla COLLATE NOCASE)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_propostas_sigla
        ON propostas (guild_id, sigla COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_propostas_nome
        ON propostas (guild_id, nome COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_propostas_status
        ON propostas (guild_id, status);
`);

const agora = () => new Date().toISOString();

function paraObjeto(linha) {
    if (!linha) return null;

    return {
        fundadorId: linha.fundador_id,
        fundadorNome: linha.fundador_nome,
        nome: linha.nome,
        sigla: linha.sigla,
        emoji: linha.emoji,
        posicionamento: linha.posicionamento,
        propostas: linha.propostas,
        valores: linha.valores,
        status: linha.status,
        criadoEm: linha.criado_em,
        atualizadoEm: linha.atualizado_em,
        guildId: linha.guild_id,
        canalId: linha.canal_id,
        mensagemId: linha.mensagem_id
    };
}

const obterStmt = db.prepare(`
    SELECT * FROM propostas WHERE fundador_id = ?
     ORDER BY rowid DESC LIMIT 1
`);
const obterPorGuildStmt = db.prepare(
    'SELECT * FROM propostas WHERE fundador_id = ? AND guild_id = ?'
);
const salvarIdentidadeStmt = db.prepare(`
    INSERT INTO propostas (
        guild_id, fundador_id, fundador_nome, nome, sigla, emoji,
        posicionamento, propostas, valores, status, criado_em,
        atualizado_em, canal_id, mensagem_id
    ) VALUES (
        @guildId, @fundadorId, @fundadorNome, @nome, @sigla, @emoji,
        @posicionamento, NULL, NULL, @status, @agora, @agora, NULL, NULL
    )
    ON CONFLICT (guild_id, fundador_id) DO UPDATE SET
        fundador_nome  = excluded.fundador_nome,
        nome           = excluded.nome,
        sigla          = excluded.sigla,
        emoji          = excluded.emoji,
        posicionamento = excluded.posicionamento,
        propostas      = NULL,
        valores        = NULL,
        status         = excluded.status,
        atualizado_em  = excluded.atualizado_em,
        canal_id       = NULL,
        mensagem_id    = NULL
`);
const salvarProgramaStmt = db.prepare(`
    UPDATE propostas
       SET propostas      = @propostas,
           valores        = @valores,
           posicionamento = @posicionamento,
           status         = @status,
           atualizado_em  = @agora,
           canal_id       = @canalId,
           mensagem_id    = @mensagemId
     WHERE fundador_id    = @fundadorId
       AND guild_id       = @guildId
`);
const contarSiglaStmt = db.prepare(`
    SELECT 1 FROM propostas
     WHERE guild_id = @guildId AND sigla = @sigla COLLATE NOCASE
       AND fundador_id != @ignorarFundadorId LIMIT 1
`);
const contarNomeStmt = db.prepare(`
    SELECT 1 FROM propostas
     WHERE guild_id = @guildId AND nome = @nome COLLATE NOCASE
       AND fundador_id != @ignorarFundadorId LIMIT 1
`);
const limparRascunhosStmt = db.prepare(
    'DELETE FROM propostas WHERE status = ? AND atualizado_em < ?'
);
const obterConfiguracaoStmt = db.prepare(
    'SELECT * FROM configuracoes WHERE guild_id = ?'
);
const propostaMensagemStmt = db.prepare(`
    SELECT * FROM propostas
     WHERE guild_id = ? AND canal_id = ? AND mensagem_id = ?
`);
const totalApoiosStmt = db.prepare(
    'SELECT COUNT(*) AS total FROM apoios WHERE guild_id = ? AND fundador_id = ?'
);

function obterProposta(fundadorId, guildId) {
    return paraObjeto(
        guildId === undefined
            ? obterStmt.get(fundadorId)
            : obterPorGuildStmt.get(fundadorId, guildId)
    );
}

function salvarIdentidade({
    fundadorId,
    fundadorNome,
    nome,
    sigla,
    emoji,
    posicionamento = null,
    guildId = ''
}) {
    salvarIdentidadeStmt.run({
        fundadorId,
        fundadorNome,
        nome,
        sigla,
        emoji,
        posicionamento,
        status: STATUS_RASCUNHO,
        agora: agora(),
        guildId
    });

    return obterProposta(fundadorId, guildId);
}

function salvarPrograma(
    fundadorId,
    {
        guildId = '',
        propostas,
        valores,
        posicionamento,
        status = STATUS_AGUARDANDO_APOIO,
        canalId = null,
        mensagemId = null
    }
) {
    const info = salvarProgramaStmt.run({
        fundadorId,
        guildId,
        propostas,
        valores,
        posicionamento,
        status,
        agora: agora(),
        canalId,
        mensagemId
    });

    return info.changes === 0 ? null : obterProposta(fundadorId, guildId);
}

function siglaEmUso(sigla, ignorarFundadorId, guildId = '') {
    return Boolean(
        contarSiglaStmt.get({ sigla, ignorarFundadorId, guildId })
    );
}

function nomeEmUso(nome, ignorarFundadorId, guildId = '') {
    return Boolean(contarNomeStmt.get({ nome, ignorarFundadorId, guildId }));
}

function obterConfiguracao(guildId) {
    const config = obterConfiguracaoStmt.get(guildId);
    return {
        guildId,
        canalApoioId: config?.canal_apoio_id ?? null,
        minimoApoios: config?.minimo_apoios ?? APOIOS_PADRAO
    };
}

function configurarCanalApoio(guildId, canalApoioId) {
    db.prepare(`
        INSERT INTO configuracoes (guild_id, canal_apoio_id)
        VALUES (?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET canal_apoio_id = excluded.canal_apoio_id
    `).run(guildId, canalApoioId);
    return obterConfiguracao(guildId);
}

function configurarMinimoApoios(guildId, minimoApoios) {
    db.prepare(`
        INSERT INTO configuracoes (guild_id, minimo_apoios)
        VALUES (?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET minimo_apoios = excluded.minimo_apoios
    `).run(guildId, minimoApoios);
    return obterConfiguracao(guildId);
}

function obterPropostaPorMensagem(guildId, canalId, mensagemId) {
    return paraObjeto(propostaMensagemStmt.get(guildId, canalId, mensagemId));
}

const registrarApoioTx = db.transaction((guildId, fundadorId, apoiadorId) => {
    const proposta = obterProposta(fundadorId, guildId);
    if (!proposta || proposta.status !== STATUS_AGUARDANDO_APOIO) {
        return { resultado: 'indisponivel', proposta, total: 0 };
    }
    if (fundadorId === apoiadorId) {
        return {
            resultado: 'fundador',
            proposta,
            total: totalApoiosStmt.get(guildId, fundadorId).total
        };
    }

    const insercao = db
        .prepare(
            'INSERT OR IGNORE INTO apoios (guild_id, fundador_id, apoiador_id, criado_em) VALUES (?, ?, ?, ?)'
        )
        .run(guildId, fundadorId, apoiadorId, agora());
    const total = totalApoiosStmt.get(guildId, fundadorId).total;
    const minimoApoios = obterConfiguracao(guildId).minimoApoios;

    if (total >= minimoApoios) {
        const fundadoEm = agora();
        db.prepare(`
            INSERT OR IGNORE INTO partidos (
                guild_id, fundador_id, fundador_nome, nome, sigla, emoji,
                posicionamento, propostas, valores, fundado_em
            ) VALUES (
                @guildId, @fundadorId, @fundadorNome, @nome, @sigla, @emoji,
                @posicionamento, @propostas, @valores, @fundadoEm
            )
        `).run({ ...proposta, guildId, fundadoEm });
        db.prepare(`
            UPDATE propostas SET status = ?, atualizado_em = ?
             WHERE fundador_id = ? AND guild_id = ?
        `).run(STATUS_FUNDADO, fundadoEm, fundadorId, guildId);

        return {
            resultado: insercao.changes ? 'fundado' : 'ja_fundado',
            proposta: obterProposta(fundadorId, guildId),
            total,
            minimoApoios
        };
    }

    return {
        resultado: insercao.changes ? 'registrado' : 'duplicado',
        proposta,
        total,
        minimoApoios
    };
});

function registrarApoio(guildId, fundadorId, apoiadorId) {
    return registrarApoioTx.immediate(guildId, fundadorId, apoiadorId);
}

function obterTotalApoios(fundadorId, guildId = '') {
    return totalApoiosStmt.get(guildId, fundadorId).total;
}

function listarPartidos(guildId) {
    return db
        .prepare('SELECT * FROM partidos WHERE guild_id = ? ORDER BY fundado_em')
        .all(guildId);
}

function limparRascunhosExpirados(maxIdadeMs = DRAFT_TTL_MS) {
    const limite = new Date(Date.now() - maxIdadeMs).toISOString();
    return limparRascunhosStmt.run(STATUS_RASCUNHO, limite).changes;
}

function fechar() {
    db.close();
}

module.exports = {
    STATUS_RASCUNHO,
    STATUS_AGUARDANDO_APOIO,
    STATUS_FUNDADO,
    APOIOS_PADRAO,
    obterProposta,
    salvarIdentidade,
    salvarPrograma,
    siglaEmUso,
    nomeEmUso,
    obterConfiguracao,
    configurarCanalApoio,
    configurarMinimoApoios,
    obterPropostaPorMensagem,
    registrarApoio,
    obterTotalApoios,
    listarPartidos,
    limparRascunhosExpirados,
    fechar
};
