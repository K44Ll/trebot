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
const MAX_ELEICAO_N = 500;
const MAX_NUMERO_PARTIDO = 99;
const INATIVIDADE_PARTIDO_MS = 21 * 24 * 60 * 60 * 1000;
const CARGOS_ELEITORAIS = Object.freeze([
    'presidente',
    'vice-presidente',
    'governador',
    'deputado-federal',
    'senador'
]);
const CARGOS_SQL = CARGOS_ELEITORAIS.map(cargo => `'${cargo}'`).join(', ');

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
        numero_eleitoral INTEGER,
        status          TEXT NOT NULL DEFAULT 'ativo',
        ultima_atividade_em TEXT,
        liquidado_em    TEXT,
        substituido_por_id INTEGER,
        substitui_partido_id INTEGER,
        UNIQUE (guild_id, fundador_id),
        UNIQUE (guild_id, nome COLLATE NOCASE),
        UNIQUE (guild_id, sigla COLLATE NOCASE)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_partidos_guild_id_id
        ON partidos (guild_id, id);

    CREATE TABLE IF NOT EXISTS filiacao_pedidos (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT NOT NULL,
        partido_id    INTEGER NOT NULL,
        discord_id    TEXT NOT NULL,
        nome          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pendente'
                      CHECK (status IN ('pendente', 'aceito', 'recusado', 'cancelado')),
        criado_em     TEXT NOT NULL,
        decidido_em   TEXT,
        FOREIGN KEY (guild_id, partido_id)
            REFERENCES partidos(guild_id, id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_filiacao_pedido_pendente
        ON filiacao_pedidos (guild_id, partido_id, discord_id)
        WHERE status = 'pendente';

    CREATE TABLE IF NOT EXISTS eleicoes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        n           INTEGER NOT NULL CHECK (n BETWEEN 1 AND ${MAX_ELEICAO_N}),
        criada_em   TEXT NOT NULL,
        UNIQUE (id, guild_id)
    );

    CREATE TABLE IF NOT EXISTS politicos (
        guild_id    TEXT NOT NULL,
        discord_id  TEXT NOT NULL,
        nome        TEXT NOT NULL,
        partido_id  INTEGER,
        posicao     TEXT CHECK (
            posicao IS NULL OR posicao IN (${CARGOS_SQL})
        ),
        criado_em   TEXT NOT NULL,
        atualizado_em TEXT NOT NULL,
        PRIMARY KEY (guild_id, discord_id),
        FOREIGN KEY (guild_id, partido_id)
            REFERENCES partidos(guild_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS candidatos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        eleicao_id  INTEGER NOT NULL,
        politico_id TEXT NOT NULL,
        partido_id  INTEGER NOT NULL,
        cargo       TEXT NOT NULL CHECK (cargo IN (${CARGOS_SQL})),
        numero      TEXT,
        status      TEXT NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente', 'aprovado', 'recusado', 'cancelado')),
        criado_em   TEXT NOT NULL,
        decidido_em TEXT,
        UNIQUE (eleicao_id, politico_id),
        FOREIGN KEY (eleicao_id, guild_id)
            REFERENCES eleicoes(id, guild_id) ON DELETE CASCADE,
        FOREIGN KEY (guild_id, politico_id)
            REFERENCES politicos(guild_id, discord_id) ON DELETE RESTRICT,
        FOREIGN KEY (guild_id, partido_id)
            REFERENCES partidos(guild_id, id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_propostas_sigla
        ON propostas (guild_id, sigla COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_propostas_nome
        ON propostas (guild_id, nome COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_propostas_status
        ON propostas (guild_id, status);
`);

function garantirColunas(tabela, definicoes) {
    const existentes = new Set(
        db.pragma(`table_info(${tabela})`).map(coluna => coluna.name)
    );
    for (const [nome, definicao] of Object.entries(definicoes)) {
        if (!existentes.has(nome)) {
            db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${definicao}`);
        }
    }
}

garantirColunas('partidos', {
    numero_eleitoral: 'INTEGER',
    status: "TEXT NOT NULL DEFAULT 'ativo'",
    ultima_atividade_em: 'TEXT',
    liquidado_em: 'TEXT',
    substituido_por_id: 'INTEGER',
    substitui_partido_id: 'INTEGER'
});
garantirColunas('candidatos', {
    numero: 'TEXT',
    status: "TEXT NOT NULL DEFAULT 'aprovado'",
    decidido_em: 'TEXT'
});
db.exec(`
    UPDATE partidos
       SET ultima_atividade_em = fundado_em
     WHERE ultima_atividade_em IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_partido_numero_ativo
        ON partidos (guild_id, numero_eleitoral)
        WHERE status = 'ativo' AND numero_eleitoral IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidato_numero_ativo
        ON candidatos (eleicao_id, cargo, numero)
        WHERE status IN ('pendente', 'aprovado') AND numero IS NOT NULL;
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
const obterEleicaoStmt = db.prepare(
    'SELECT * FROM eleicoes WHERE guild_id = ? AND id = ?'
);
const obterPoliticoStmt = db.prepare(
    'SELECT * FROM politicos WHERE guild_id = ? AND discord_id = ?'
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

function configurarEleitoral(guildId, canalApoioId, minimoApoios) {
    db.transaction(() => {
        db.prepare(`
            INSERT INTO configuracoes (guild_id, canal_apoio_id)
            VALUES (?, ?)
            ON CONFLICT (guild_id) DO UPDATE SET canal_apoio_id = excluded.canal_apoio_id
        `).run(guildId, canalApoioId);
        db.prepare(`
            INSERT INTO configuracoes (guild_id, minimo_apoios)
            VALUES (?, ?)
            ON CONFLICT (guild_id) DO UPDATE SET minimo_apoios = excluded.minimo_apoios
        `).run(guildId, minimoApoios);
    }).immediate();
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
                posicionamento, propostas, valores, fundado_em,
                ultima_atividade_em
            ) VALUES (
                @guildId, @fundadorId, @fundadorNome, @nome, @sigla, @emoji,
                @posicionamento, @propostas, @valores, @fundadoEm, @fundadoEm
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

function listarPropostas(guildId) {
    return db
        .prepare(`
            SELECT propostas.*,
                   COUNT(apoios.apoiador_id) AS total_apoios
              FROM propostas
              LEFT JOIN apoios
                ON apoios.guild_id = propostas.guild_id
               AND apoios.fundador_id = propostas.fundador_id
             WHERE propostas.guild_id = ?
             GROUP BY propostas.guild_id, propostas.fundador_id
             ORDER BY propostas.atualizado_em DESC
        `)
        .all(guildId)
        .map(proposta => ({
            ...paraObjeto(proposta),
            totalApoios: proposta.total_apoios
        }));
}

function vagasPorCargo(n) {
    validarN(n);
    return {
        presidente: 1,
        'vice-presidente': 1,
        governador: 1,
        'deputado-federal': 3 * n,
        senador: Math.ceil((3 * n) / 2)
    };
}

function validarN(n) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_ELEICAO_N) {
        throw new RangeError(
            `n deve ser um número inteiro entre 1 e ${MAX_ELEICAO_N}.`
        );
    }
}

function criarEleicao(guildId, n) {
    validarN(n);
    if (typeof guildId !== 'string' || !guildId) {
        throw new TypeError('guildId é obrigatório para criar uma eleição.');
    }

    const info = db
        .prepare('INSERT INTO eleicoes (guild_id, n, criada_em) VALUES (?, ?, ?)')
        .run(guildId, n, agora());
    return obterEleicao(guildId, Number(info.lastInsertRowid));
}

function obterEleicao(guildId, eleicaoId) {
    return obterEleicaoStmt.get(guildId, eleicaoId) ?? null;
}

function listarEleicoes(guildId) {
    return db
        .prepare('SELECT * FROM eleicoes WHERE guild_id = ? ORDER BY id')
        .all(guildId);
}

function listarPoliticos(guildId) {
    return db
        .prepare(`
            SELECT politicos.*, partidos.nome AS partido_nome,
                   partidos.sigla AS partido_sigla,
                   partidos.emoji AS partido_emoji
              FROM politicos
              LEFT JOIN partidos
                ON partidos.guild_id = politicos.guild_id
               AND partidos.id = politicos.partido_id
             WHERE politicos.guild_id = ?
             ORDER BY politicos.nome COLLATE NOCASE
        `)
        .all(guildId);
}

function salvarPolitico({
    guildId,
    discordId,
    nome,
    partidoId = null,
    posicao = null
}) {
    if (typeof guildId !== 'string' || !guildId) {
        throw new TypeError('guildId é obrigatório para cadastrar um político.');
    }
    if (typeof discordId !== 'string' || !discordId) {
        throw new TypeError('discordId é obrigatório para cadastrar um político.');
    }
    if (typeof nome !== 'string' || !nome.trim()) {
        throw new TypeError('O nome do político não pode ficar vazio.');
    }
    if (posicao !== null && !CARGOS_ELEITORAIS.includes(posicao)) {
        throw new RangeError('A posição informada não é um cargo eleitoral válido.');
    }

    db.prepare(`
        INSERT INTO politicos (
            guild_id, discord_id, nome, partido_id, posicao, criado_em, atualizado_em
        ) VALUES (
            @guildId, @discordId, @nome, @partidoId, @posicao, @agora, @agora
        )
        ON CONFLICT (guild_id, discord_id) DO UPDATE SET
            nome = excluded.nome,
            partido_id = excluded.partido_id,
            posicao = excluded.posicao,
            atualizado_em = excluded.atualizado_em
    `).run({
        guildId,
        discordId,
        nome: nome.trim(),
        partidoId,
        posicao,
        agora: agora()
    });

    return obterPolitico(guildId, discordId);
}

function obterPolitico(guildId, discordId) {
    return obterPoliticoStmt.get(guildId, discordId) ?? null;
}

function removerPolitico(guildId, discordId) {
    return db
        .prepare('DELETE FROM politicos WHERE guild_id = ? AND discord_id = ?')
        .run(guildId, discordId).changes;
}

function registrarCandidato({ guildId, eleicaoId, politicoId, cargo }) {
    if (!CARGOS_ELEITORAIS.includes(cargo)) {
        throw new RangeError('O cargo informado não é um cargo eleitoral válido.');
    }

    const eleicao = obterEleicao(guildId, eleicaoId);
    if (!eleicao) {
        throw new Error('A eleição não existe neste servidor.');
    }
    const politico = obterPolitico(guildId, politicoId);
    if (!politico) {
        throw new Error('O político não está cadastrado neste servidor.');
    }
    if (politico.partido_id === null) {
        throw new Error('O político precisa estar filiado a um partido para ser candidato.');
    }

    const criadoEm = agora();
    const info = db
        .prepare(`
            INSERT INTO candidatos (
                guild_id, eleicao_id, politico_id, partido_id, cargo,
                status, criado_em
            ) VALUES (?, ?, ?, ?, ?, 'aprovado', ?)
        `)
        .run(
            guildId,
            eleicaoId,
            politicoId,
            politico.partido_id,
            cargo,
            criadoEm
        );

    return db
        .prepare('SELECT * FROM candidatos WHERE id = ?')
        .get(Number(info.lastInsertRowid));
}

function listarCandidatos(guildId, eleicaoId) {
    return db
        .prepare(`
            SELECT candidatos.*, politicos.nome AS politico_nome,
                   partidos.nome AS partido_nome, partidos.sigla AS partido_sigla,
                   partidos.emoji AS partido_emoji
              FROM candidatos
              JOIN politicos
                ON politicos.guild_id = candidatos.guild_id
               AND politicos.discord_id = candidatos.politico_id
              JOIN partidos
                ON partidos.guild_id = candidatos.guild_id
               AND partidos.id = candidatos.partido_id
             WHERE candidatos.guild_id = ? AND candidatos.eleicao_id = ?
             ORDER BY candidatos.cargo, politicos.nome COLLATE NOCASE
        `)
        .all(guildId, eleicaoId);
}

function listarPartidosParaFiliacao(guildId) {
    return db
        .prepare(`
            SELECT id, nome, sigla, emoji, fundador_id, numero_eleitoral
              FROM partidos
             WHERE guild_id = ? AND status = 'ativo'
             ORDER BY nome COLLATE NOCASE
        `)
        .all(guildId);
}

function solicitarFiliacao({ guildId, partidoId, discordId, nome }) {
    return db.transaction(() => {
        const partido = db
            .prepare(`
                SELECT * FROM partidos
                 WHERE guild_id = ? AND id = ? AND status = 'ativo'
            `)
            .get(guildId, partidoId);
        if (!partido) throw new Error('Partido não encontrado ou liquidado.');

        const politico = obterPolitico(guildId, discordId);
        if (politico?.partido_id === partidoId) {
            throw new Error('Você já é filiado a este partido.');
        }
        if (politico?.partido_id !== null && politico?.partido_id !== undefined) {
            throw new Error('Você já é filiado a outro partido.');
        }
        const pendente = db
            .prepare(`
                SELECT 1 FROM filiacao_pedidos
                 WHERE guild_id = ? AND discord_id = ?
                   AND status = 'pendente'
            `)
            .get(guildId, discordId);
        if (pendente) {
            throw new Error(
                'Você já tem uma solicitação de filiação pendente neste servidor.'
            );
        }

        const timestamp = agora();
        const info = db
            .prepare(`
                INSERT INTO filiacao_pedidos (
                    guild_id, partido_id, discord_id, nome, criado_em
                ) VALUES (?, ?, ?, ?, ?)
            `)
            .run(guildId, partidoId, discordId, nome, timestamp);
        db.prepare(`
            UPDATE partidos SET ultima_atividade_em = ?
             WHERE guild_id = ? AND id = ?
        `).run(timestamp, guildId, partidoId);
        return Number(info.lastInsertRowid);
    }).immediate();
}

function listarPedidosFiliacaoPorDono(guildId, donoId) {
    return db
        .prepare(`
            SELECT pedidos.*, partidos.nome AS partido_nome,
                   partidos.sigla AS partido_sigla,
                   partidos.emoji AS partido_emoji
              FROM filiacao_pedidos AS pedidos
              JOIN partidos
                ON partidos.guild_id = pedidos.guild_id
               AND partidos.id = pedidos.partido_id
             WHERE pedidos.guild_id = ? AND partidos.fundador_id = ?
               AND pedidos.status = 'pendente'
             ORDER BY pedidos.criado_em, pedidos.id
        `)
        .all(guildId, donoId);
}

function decidirPedidoFiliacao({ guildId, pedidoId, donoId, aceitar }) {
    return db.transaction(() => {
        const pedido = db
            .prepare(`
                SELECT pedidos.*, partidos.fundador_id, partidos.status AS partido_status
                  FROM filiacao_pedidos AS pedidos
                  JOIN partidos
                    ON partidos.guild_id = pedidos.guild_id
                   AND partidos.id = pedidos.partido_id
                 WHERE pedidos.guild_id = ? AND pedidos.id = ?
                   AND pedidos.status = 'pendente'
            `)
            .get(guildId, pedidoId);
        if (!pedido) return { resultado: 'indisponivel' };
        if (pedido.fundador_id !== donoId) return { resultado: 'nao_autorizado' };
        if (pedido.partido_status !== 'ativo') {
            db.prepare(`
                UPDATE filiacao_pedidos
                   SET status = 'cancelado', decidido_em = ?
                 WHERE id = ?
            `).run(agora(), pedidoId);
            return { resultado: 'partido_inativo' };
        }

        const timestamp = agora();
        db.prepare(`
            UPDATE partidos SET ultima_atividade_em = ?
             WHERE guild_id = ? AND id = ?
        `).run(timestamp, guildId, pedido.partido_id);

        if (aceitar) {
            const politico = obterPolitico(guildId, pedido.discord_id);
            if (
                politico?.partido_id !== null &&
                politico?.partido_id !== undefined
            ) {
                db.prepare(`
                    UPDATE filiacao_pedidos
                       SET status = 'cancelado', decidido_em = ?
                     WHERE id = ?
                `).run(timestamp, pedidoId);
                return { resultado: 'ja_filiado' };
            }
            db.prepare(`
                INSERT INTO politicos (
                    guild_id, discord_id, nome, partido_id, posicao,
                    criado_em, atualizado_em
                ) VALUES (?, ?, ?, ?, NULL, ?, ?)
                ON CONFLICT (guild_id, discord_id) DO UPDATE SET
                    nome = excluded.nome,
                    partido_id = excluded.partido_id,
                    atualizado_em = excluded.atualizado_em
            `).run(
                guildId,
                pedido.discord_id,
                pedido.nome,
                pedido.partido_id,
                timestamp,
                timestamp
            );
            db.prepare(`
                UPDATE filiacao_pedidos
                   SET status = 'aceito', decidido_em = ?
                 WHERE id = ?
            `).run(timestamp, pedidoId);
            db.prepare(`
                UPDATE partidos SET ultima_atividade_em = ?
                 WHERE guild_id = ? AND id = ?
            `).run(timestamp, guildId, pedido.partido_id);
            db.prepare(`
                UPDATE filiacao_pedidos
                   SET status = 'cancelado', decidido_em = ?
                 WHERE guild_id = ? AND discord_id = ?
                   AND id != ? AND status = 'pendente'
            `).run(timestamp, guildId, pedido.discord_id, pedidoId);
            return { resultado: 'aceito' };
        }

        db.prepare(`
            UPDATE filiacao_pedidos
               SET status = 'recusado', decidido_em = ?
             WHERE id = ?
        `).run(timestamp, pedidoId);
        return { resultado: 'recusado' };
    }).immediate();
}

function numeroSufixoPorCargo(cargo) {
    if (['presidente', 'vice-presidente', 'governador'].includes(cargo)) {
        return 0;
    }
    if (cargo === 'senador') return 1;
    if (cargo === 'deputado-federal') return 4;
    throw new RangeError('O cargo informado não é um cargo eleitoral válido.');
}

function alocarNumeroPartido(guildId, partidoId, timestamp) {
    const partido = db
        .prepare('SELECT * FROM partidos WHERE guild_id = ? AND id = ?')
        .get(guildId, partidoId);
    if (!partido || partido.status !== 'ativo') {
        throw new Error('Partido não encontrado ou liquidado.');
    }
    if (partido.numero_eleitoral !== null) {
        return partido.numero_eleitoral;
    }

    const numeros = new Set(
        db
            .prepare(`
                SELECT numero_eleitoral FROM partidos
                 WHERE guild_id = ? AND status = 'ativo'
                   AND numero_eleitoral IS NOT NULL
            `)
            .all(guildId)
            .map(row => row.numero_eleitoral)
    );
    let numero = 0;
    for (let candidato = 1; candidato <= MAX_NUMERO_PARTIDO; candidato++) {
        if (!numeros.has(candidato)) {
            numero = candidato;
            break;
        }
    }

    if (numero === 0) {
        const limiteInatividade = new Date(
            Date.now() - INATIVIDADE_PARTIDO_MS
        ).toISOString();
        const inativo = db
            .prepare(`
                SELECT * FROM partidos
                 WHERE guild_id = ? AND status = 'ativo'
                   AND numero_eleitoral IS NOT NULL
                   AND id != ?
                   AND ultima_atividade_em <= ?
                 ORDER BY ultima_atividade_em, id
                 LIMIT 1
            `)
            .get(guildId, partidoId, limiteInatividade);
        if (!inativo) {
            throw new Error(
                'Todos os números de partido (01–99) estão ocupados. Nenhum partido está inativo há 3 semanas para liberar um número.'
            );
        }

        numero = inativo.numero_eleitoral;
        db.prepare(`
            UPDATE partidos
               SET status = 'liquidado', liquidado_em = ?,
                   substituido_por_id = ?
             WHERE guild_id = ? AND id = ?
        `).run(timestamp, partidoId, guildId, inativo.id);
        db.prepare(`
            UPDATE filiacao_pedidos SET status = 'cancelado', decidido_em = ?
             WHERE guild_id = ? AND partido_id = ? AND status = 'pendente'
        `).run(timestamp, guildId, inativo.id);
        db.prepare(`
            UPDATE candidatos SET status = 'cancelado', decidido_em = ?
             WHERE guild_id = ? AND partido_id = ? AND status = 'pendente'
        `).run(timestamp, guildId, inativo.id);
        db.prepare(`
            UPDATE politicos SET partido_id = NULL, atualizado_em = ?
             WHERE guild_id = ? AND partido_id = ?
        `).run(timestamp, guildId, inativo.id);
        db.prepare(`
            UPDATE partidos SET substitui_partido_id = ?
             WHERE guild_id = ? AND id = ?
        `).run(inativo.id, guildId, partidoId);
    }

    db.prepare(`
        UPDATE partidos
           SET numero_eleitoral = ?, ultima_atividade_em = ?
         WHERE guild_id = ? AND id = ?
    `).run(numero, timestamp, guildId, partidoId);
    return numero;
}

function solicitarCandidatura({
    guildId,
    eleicaoId,
    politicoId,
    nome,
    cargo,
    sufixo = ''
}) {
    return db.transaction(() => {
        const eleicao = obterEleicao(guildId, eleicaoId);
        if (!eleicao) throw new Error('A eleição não existe neste servidor.');

        let politico = obterPolitico(guildId, politicoId);
        const partidoDoFundador = db
            .prepare(`
                SELECT * FROM partidos
                 WHERE guild_id = ? AND fundador_id = ? AND status = 'ativo'
            `)
            .get(guildId, politicoId);
        if (!politico && partidoDoFundador) {
            const timestamp = agora();
            db.prepare(`
                INSERT INTO politicos (
                    guild_id, discord_id, nome, partido_id, posicao,
                    criado_em, atualizado_em
                ) VALUES (?, ?, ?, ?, NULL, ?, ?)
            `).run(
                guildId,
                politicoId,
                nome,
                partidoDoFundador.id,
                timestamp,
                timestamp
            );
            politico = obterPolitico(guildId, politicoId);
        }
        if (!politico || politico.partido_id === null) {
            throw new Error('Você precisa estar filiado a um partido para se candidatar.');
        }

        const comprimentoSufixo = numeroSufixoPorCargo(cargo);
        if (
            typeof sufixo !== 'string' ||
            sufixo.length !== comprimentoSufixo ||
            (comprimentoSufixo > 0 &&
                !new RegExp(`^\\d{${comprimentoSufixo}}$`).test(sufixo)) ||
            (comprimentoSufixo === 0 && sufixo !== '')
        ) {
            throw new Error(
                comprimentoSufixo === 0
                    ? 'Este cargo usa somente os 2 dígitos do partido; não informe complemento.'
                    : `Informe exatamente ${comprimentoSufixo} dígito(s) como complemento do número.`
            );
        }

        const timestamp = agora();
        const numeroPartido = alocarNumeroPartido(
            guildId,
            politico.partido_id,
            timestamp
        );
        const numero = `${String(numeroPartido).padStart(2, '0')}${sufixo}`;
        const existente = db
            .prepare(`
                SELECT 1 FROM candidatos
                 WHERE eleicao_id = ? AND politico_id = ?
            `)
            .get(eleicaoId, politicoId);
        if (existente) {
            throw new Error('Você já tem uma solicitação de candidatura nesta eleição.');
        }
        const numeroEmUso = db
            .prepare(`
                SELECT 1 FROM candidatos
                 WHERE eleicao_id = ? AND cargo = ? AND numero = ?
                   AND status IN ('pendente', 'aprovado')
            `)
            .get(eleicaoId, cargo, numero);
        if (numeroEmUso) {
            throw new Error('Este número já está reservado para esse cargo nesta eleição.');
        }

        const info = db
            .prepare(`
                INSERT INTO candidatos (
                    guild_id, eleicao_id, politico_id, partido_id, cargo,
                    numero, status, criado_em
                ) VALUES (?, ?, ?, ?, ?, ?, 'pendente', ?)
            `)
            .run(
                guildId,
                eleicaoId,
                politicoId,
                politico.partido_id,
                cargo,
                numero,
                timestamp
            );
        db.prepare(`
            UPDATE partidos SET ultima_atividade_em = ?
             WHERE guild_id = ? AND id = ?
        `).run(timestamp, guildId, politico.partido_id);
        return db
            .prepare(`
                SELECT candidatos.*, partidos.fundador_id AS dono_id,
                       partidos.nome AS partido_nome, partidos.sigla AS partido_sigla
                  FROM candidatos
                  JOIN partidos
                    ON partidos.guild_id = candidatos.guild_id
                   AND partidos.id = candidatos.partido_id
                 WHERE candidatos.id = ?
            `)
            .get(Number(info.lastInsertRowid));
    }).immediate();
}

function listarPedidosCandidaturaPorDono(guildId, donoId) {
    return db
        .prepare(`
            SELECT candidatos.*, politicos.nome AS politico_nome,
                   partidos.nome AS partido_nome, partidos.sigla AS partido_sigla,
                   eleicoes.n AS eleicao_n
              FROM candidatos
              JOIN politicos
                ON politicos.guild_id = candidatos.guild_id
               AND politicos.discord_id = candidatos.politico_id
              JOIN partidos
                ON partidos.guild_id = candidatos.guild_id
               AND partidos.id = candidatos.partido_id
              JOIN eleicoes
                ON eleicoes.guild_id = candidatos.guild_id
               AND eleicoes.id = candidatos.eleicao_id
             WHERE candidatos.guild_id = ? AND partidos.fundador_id = ?
               AND candidatos.status = 'pendente'
             ORDER BY candidatos.criado_em, candidatos.id
        `)
        .all(guildId, donoId);
}

function decidirPedidoCandidatura({
    guildId,
    pedidoId,
    donoId,
    aceitar
}) {
    return db.transaction(() => {
        const pedido = db
            .prepare(`
                SELECT candidatos.*, partidos.fundador_id AS dono_id,
                       partidos.status AS partido_status
                  FROM candidatos
                  JOIN partidos
                    ON partidos.guild_id = candidatos.guild_id
                   AND partidos.id = candidatos.partido_id
                 WHERE candidatos.guild_id = ? AND candidatos.id = ?
                   AND candidatos.status = 'pendente'
            `)
            .get(guildId, pedidoId);
        if (!pedido) return { resultado: 'indisponivel' };
        if (pedido.dono_id !== donoId) return { resultado: 'nao_autorizado' };
        if (pedido.partido_status !== 'ativo') {
            db.prepare(`
                UPDATE candidatos SET status = 'cancelado', decidido_em = ?
                 WHERE id = ?
            `).run(agora(), pedidoId);
            return { resultado: 'partido_inativo' };
        }

        const timestamp = agora();
        db.prepare(`
            UPDATE candidatos
               SET status = ?, decidido_em = ?
             WHERE id = ?
        `).run(aceitar ? 'aprovado' : 'recusado', timestamp, pedidoId);
        db.prepare(`
            UPDATE partidos SET ultima_atividade_em = ?
             WHERE guild_id = ? AND id = ?
        `).run(timestamp, guildId, pedido.partido_id);
        return { resultado: aceitar ? 'aceito' : 'recusado' };
    }).immediate();
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
    configurarEleitoral,
    obterPropostaPorMensagem,
    registrarApoio,
    obterTotalApoios,
    listarPartidos,
    listarPropostas,
    MAX_ELEICAO_N,
    CARGOS_ELEITORAIS,
    vagasPorCargo,
    criarEleicao,
    obterEleicao,
    listarEleicoes,
    salvarPolitico,
    obterPolitico,
    listarPoliticos,
    removerPolitico,
    registrarCandidato,
    listarCandidatos,
    listarPartidosParaFiliacao,
    solicitarFiliacao,
    listarPedidosFiliacaoPorDono,
    decidirPedidoFiliacao,
    solicitarCandidatura,
    listarPedidosCandidaturaPorDono,
    decidirPedidoCandidatura,
    limparRascunhosExpirados,
    fechar
};
