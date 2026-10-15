'use strict';

/**
 * Serviço de persistência do processo eleitoral (urna, votos e apuração).
 *
 * Banco separado de `partidos.db` de propósito: partidos, filiados e
 * candidaturas são cadastro; aqui ficam as eleições, as urnas, os votos, os
 * turnos, os agendamentos e as apurações. O esquema é relacional e
 * compartilhado — nenhuma tabela é criada por eleição — com `eleicao_id` como
 * discriminador e `guild_id` isolando os servidores.
 *
 * Sigilo do voto: a tabela `votos` NÃO guarda o ID do eleitor. Quem já votou
 * em cada cargo é controlado em `eleitores_cargos`, uma tabela separada do
 * conteúdo do voto. Como as duas gravações acontecem na mesma transação,
 * quem tem acesso ao arquivo do banco consegue correlacionar participação e
 * voto pela ordem de inserção — limitação documentada no README.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH =
    process.env.ELEICOES_DB_PATH ||
    path.join(
        path.dirname(process.env.DB_PATH || path.join(__dirname, 'partidos.db')),
        'eleicoes.db'
    );

const STATUS_ELEICAO = Object.freeze({
    CONFIGURADA: 'configurada',
    ABERTA: 'aberta',
    ENCERRADA: 'encerrada',
    CANCELADA: 'cancelada'
});

const STATUS_CARGO = Object.freeze({
    PENDENTE: 'pendente',
    ABERTA: 'aberta',
    ENCERRADA: 'encerrada',
    CANCELADA: 'cancelada'
});

const SITUACAO = Object.freeze({
    AGUARDANDO: 'aguardando',
    EM_ANDAMENTO: 'em_andamento',
    AGUARDANDO_SEGUNDO_TURNO: 'aguardando_segundo_turno',
    ENCERRADA: 'encerrada',
    SEM_VENCEDOR: 'sem_vencedor',
    DECIDIDA_ADMINISTRATIVAMENTE: 'decidida_administrativamente',
    CANCELADA: 'cancelada'
});

const TIPO_VOTO = Object.freeze({
    VALIDO: 'valido',
    BRANCO: 'branco',
    NULO: 'nulo'
});

const TIPO_AGENDAMENTO = Object.freeze({
    ENCERRAR_ELEICAO: 'encerrar_eleicao',
    ABRIR_SEGUNDO_TURNO: 'abrir_segundo_turno'
});

const STATUS_AGENDAMENTO = Object.freeze({
    PENDENTE: 'pendente',
    EXECUTANDO: 'executando',
    EXECUTADO: 'executado',
    CANCELADO: 'cancelado',
    FALHOU: 'falhou'
});

const ELEITORADO = Object.freeze({
    TODOS: 'todos',
    FILIADOS: 'filiados'
});

/** Atraso entre a apuração do primeiro turno e a abertura do segundo. */
const SEGUNDO_TURNO_ATRASO_MS = 10 * 60 * 1000;

/** Cargos sujeitos à regra de maioria absoluta e segundo turno. */
const CARGOS_SEGUNDO_TURNO = Object.freeze(['presidente', 'governador']);

/** Ordem em que a urna apresenta os cargos (proporcional antes de majoritário). */
const ORDEM_CARGOS = Object.freeze([
    'deputado-federal',
    'senador',
    'governador',
    'vice-presidente',
    'presidente'
]);

const listaSql = lista => lista.map(valor => `'${valor}'`).join(', ');

const STATUS_ELEICAO_SQL = listaSql(Object.values(STATUS_ELEICAO));
const STATUS_CARGO_SQL = listaSql(Object.values(STATUS_CARGO));
const TIPO_VOTO_SQL = listaSql(Object.values(TIPO_VOTO));
const TIPO_AGENDAMENTO_SQL = listaSql(Object.values(TIPO_AGENDAMENTO));
const STATUS_AGENDAMENTO_SQL = listaSql(Object.values(STATUS_AGENDAMENTO));
const ELEITORADO_SQL = listaSql(Object.values(ELEITORADO));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let conexao = new Database(DB_PATH);
conexao.pragma('journal_mode = WAL');
conexao.pragma('foreign_keys = ON');
conexao.pragma('busy_timeout = 5000');

const agora = () => new Date().toISOString();

function inicializarEsquema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS eleicoes (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id            TEXT NOT NULL,
            eleicao_ref_id      INTEGER NOT NULL,
            n                   INTEGER NOT NULL CHECK (n >= 1),
            nome                TEXT NOT NULL,
            estado              TEXT NOT NULL DEFAULT 'BR',
            status              TEXT NOT NULL DEFAULT 'configurada'
                                CHECK (status IN (${STATUS_ELEICAO_SQL})),
            turno               INTEGER NOT NULL DEFAULT 1 CHECK (turno IN (1, 2)),
            eleitorado          TEXT NOT NULL DEFAULT 'todos'
                                CHECK (eleitorado IN (${ELEITORADO_SQL})),
            publicar_parcial    INTEGER NOT NULL DEFAULT 0
                                CHECK (publicar_parcial IN (0, 1)),
            duracao_minutos     INTEGER,
            canal_id            TEXT,
            mensagem_id         TEXT,
            criada_por          TEXT NOT NULL,
            criada_em           TEXT NOT NULL,
            atualizada_em       TEXT NOT NULL,
            aberta_em           TEXT,
            encerra_em          TEXT,
            encerrada_em        TEXT,
            cancelada_em        TEXT,
            motivo_cancelamento TEXT,
            UNIQUE (guild_id, eleicao_ref_id, nome)
        );

        CREATE INDEX IF NOT EXISTS idx_eleicoes_guild_status
            ON eleicoes (guild_id, status);

        CREATE TABLE IF NOT EXISTS eleicao_cargos (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            eleicao_id    INTEGER NOT NULL,
            guild_id      TEXT NOT NULL,
            cargo         TEXT NOT NULL,
            ordem         INTEGER NOT NULL DEFAULT 0,
            digitos       INTEGER NOT NULL CHECK (digitos BETWEEN 1 AND 8),
            vagas         INTEGER NOT NULL DEFAULT 1 CHECK (vagas >= 1),
            segundo_turno INTEGER NOT NULL DEFAULT 0
                          CHECK (segundo_turno IN (0, 1)),
            turno_atual   INTEGER NOT NULL DEFAULT 1 CHECK (turno_atual IN (1, 2)),
            status        TEXT NOT NULL DEFAULT 'pendente'
                          CHECK (status IN (${STATUS_CARGO_SQL})),
            situacao      TEXT NOT NULL DEFAULT 'aguardando',
            aberta_em     TEXT,
            encerrada_em  TEXT,
            criada_em     TEXT NOT NULL,
            UNIQUE (eleicao_id, cargo),
            FOREIGN KEY (eleicao_id) REFERENCES eleicoes (id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_eleicao_cargos_status
            ON eleicao_cargos (eleicao_id, status, ordem);

        CREATE TABLE IF NOT EXISTS eleicao_candidatos (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            eleicao_id    INTEGER NOT NULL,
            cargo         TEXT NOT NULL,
            turno_vigente INTEGER NOT NULL DEFAULT 1
                          CHECK (turno_vigente IN (1, 2)),
            candidato_id  INTEGER NOT NULL,
            politico_id   TEXT NOT NULL,
            nome          TEXT NOT NULL,
            partido_id    INTEGER,
            partido_nome  TEXT NOT NULL,
            partido_sigla TEXT NOT NULL,
            partido_emoji TEXT,
            numero        TEXT NOT NULL,
            eliminado_em  TEXT,
            criado_em     TEXT NOT NULL,
            UNIQUE (eleicao_id, cargo, candidato_id),
            FOREIGN KEY (eleicao_id) REFERENCES eleicoes (id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_eleicao_candidato_numero
            ON eleicao_candidatos (eleicao_id, cargo, numero);

        CREATE TABLE IF NOT EXISTS votos (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            eleicao_id      INTEGER NOT NULL,
            cargo           TEXT NOT NULL,
            turno           INTEGER NOT NULL CHECK (turno IN (1, 2)),
            tipo            TEXT NOT NULL CHECK (tipo IN (${TIPO_VOTO_SQL})),
            candidato_id    INTEGER,
            numero_digitado TEXT,
            registrado_em   TEXT NOT NULL,
            CHECK ((tipo = 'valido') = (candidato_id IS NOT NULL)),
            FOREIGN KEY (eleicao_id) REFERENCES eleicoes (id) ON DELETE CASCADE,
            FOREIGN KEY (candidato_id)
                REFERENCES eleicao_candidatos (id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_votos_apuracao
            ON votos (eleicao_id, cargo, turno, tipo);

        CREATE TABLE IF NOT EXISTS eleitores_votacao (
            eleicao_id    INTEGER NOT NULL,
            discord_id    TEXT NOT NULL,
            turno         INTEGER NOT NULL CHECK (turno IN (1, 2)),
            status        TEXT NOT NULL DEFAULT 'em_curso'
                          CHECK (status IN ('em_curso', 'concluido')),
            iniciado_em   TEXT NOT NULL,
            atualizado_em TEXT NOT NULL,
            concluido_em  TEXT,
            PRIMARY KEY (eleicao_id, discord_id, turno),
            FOREIGN KEY (eleicao_id) REFERENCES eleicoes (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS eleitores_cargos (
            eleicao_id    INTEGER NOT NULL,
            discord_id    TEXT NOT NULL,
            turno         INTEGER NOT NULL CHECK (turno IN (1, 2)),
            cargo         TEXT NOT NULL,
            confirmado_em TEXT NOT NULL,
            PRIMARY KEY (eleicao_id, discord_id, turno, cargo),
            FOREIGN KEY (eleicao_id) REFERENCES eleicoes (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS resultados (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            eleicao_id         INTEGER NOT NULL,
            cargo              TEXT NOT NULL,
            turno              INTEGER NOT NULL CHECK (turno IN (1, 2)),
            tipo               TEXT NOT NULL CHECK (tipo IN (${TIPO_VOTO_SQL})),
            candidato_id       INTEGER,
            nome               TEXT NOT NULL,
            numero             TEXT,
            partido_nome       TEXT,
            partido_sigla      TEXT,
            votos              INTEGER NOT NULL DEFAULT 0,
            percentual_validos REAL,
            eleito             INTEGER NOT NULL DEFAULT 0 CHECK (eleito IN (0, 1)),
            calculado_em       TEXT NOT NULL,
            UNIQUE (eleicao_id, cargo, turno, tipo, nome),
            FOREIGN KEY (eleicao_id) REFERENCES eleicoes (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS resultado_cargos (
            eleicao_id            INTEGER NOT NULL,
            cargo                 TEXT NOT NULL,
            turno                 INTEGER NOT NULL CHECK (turno IN (1, 2)),
            situacao              TEXT NOT NULL,
            votos_validos         INTEGER NOT NULL DEFAULT 0,
            votos_brancos         INTEGER NOT NULL DEFAULT 0,
            votos_nulos           INTEGER NOT NULL DEFAULT 0,
            total_votos           INTEGER NOT NULL DEFAULT 0,
            eleitores             INTEGER NOT NULL DEFAULT 0,
            eleitores_concluidos  INTEGER NOT NULL DEFAULT 0,
            vencedor_id           INTEGER,
            vencedor_nome         TEXT,
            vencedor_numero       TEXT,
            vencedor_partido_sigla TEXT,
            vencedor_percentual   REAL,
            aguarda_segundo_turno INTEGER NOT NULL DEFAULT 0
                                  CHECK (aguarda_segundo_turno IN (0, 1)),
            observacao            TEXT,
            calculado_em          TEXT NOT NULL,
            PRIMARY KEY (eleicao_id, cargo, turno),
            FOREIGN KEY (eleicao_id) REFERENCES eleicoes (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agendamentos (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            eleicao_id    INTEGER NOT NULL,
            tipo          TEXT NOT NULL CHECK (tipo IN (${TIPO_AGENDAMENTO_SQL})),
            cargo         TEXT NOT NULL DEFAULT '',
            turno         INTEGER NOT NULL DEFAULT 1 CHECK (turno IN (1, 2)),
            executar_em   TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'pendente'
                          CHECK (status IN (${STATUS_AGENDAMENTO_SQL})),
            tentativas    INTEGER NOT NULL DEFAULT 0,
            detalhe       TEXT,
            criado_em     TEXT NOT NULL,
            atualizado_em TEXT NOT NULL,
            UNIQUE (eleicao_id, tipo, cargo, turno),
            FOREIGN KEY (eleicao_id) REFERENCES eleicoes (id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_agendamentos_status
            ON agendamentos (status, executar_em);

        CREATE TABLE IF NOT EXISTS eleicao_auditoria (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            eleicao_id INTEGER,
            guild_id   TEXT NOT NULL,
            evento     TEXT NOT NULL,
            detalhe    TEXT,
            ator_id    TEXT,
            criado_em  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_eleicao_auditoria
            ON eleicao_auditoria (eleicao_id, id);
    `);
}

inicializarEsquema(conexao);




// ---------------------------------------------------------------------------
// Conversão de linhas do SQLite para objetos da aplicação
// ---------------------------------------------------------------------------

const paraEleicao = linha =>
    linha
        ? {
              id: linha.id,
              guildId: linha.guild_id,
              eleicaoRefId: linha.eleicao_ref_id,
              n: linha.n,
              nome: linha.nome,
              estado: linha.estado,
              status: linha.status,
              turno: linha.turno,
              eleitorado: linha.eleitorado,
              publicarParcial: Boolean(linha.publicar_parcial),
              duracaoMinutos: linha.duracao_minutos,
              canalId: linha.canal_id,
              mensagemId: linha.mensagem_id,
              criadaPor: linha.criada_por,
              criadaEm: linha.criada_em,
              atualizadaEm: linha.atualizada_em,
              abertaEm: linha.aberta_em,
              encerraEm: linha.encerra_em,
              encerradaEm: linha.encerrada_em,
              canceladaEm: linha.cancelada_em,
              motivoCancelamento: linha.motivo_cancelamento
          }
        : null;

const paraCargo = linha =>
    linha
        ? {
              id: linha.id,
              eleicaoId: linha.eleicao_id,
              guildId: linha.guild_id,
              cargo: linha.cargo,
              ordem: linha.ordem,
              digitos: linha.digitos,
              vagas: linha.vagas,
              segundoTurno: Boolean(linha.segundo_turno),
              turnoAtual: linha.turno_atual,
              status: linha.status,
              situacao: linha.situacao,
              abertaEm: linha.aberta_em,
              encerradaEm: linha.encerrada_em
          }
        : null;

const paraCandidato = linha =>
    linha
        ? {
              id: linha.id,
              eleicaoId: linha.eleicao_id,
              cargo: linha.cargo,
              turnoVigente: linha.turno_vigente,
              candidatoId: linha.candidato_id,
              politicoId: linha.politico_id,
              nome: linha.nome,
              partidoId: linha.partido_id,
              partidoNome: linha.partido_nome,
              partidoSigla: linha.partido_sigla,
              partidoEmoji: linha.partido_emoji,
              numero: linha.numero,
              eliminadoEm: linha.eliminado_em
          }
        : null;

// ---------------------------------------------------------------------------
// Eleições
// ---------------------------------------------------------------------------

function executarCriacaoEleicao(dados) {
    const criadaEm = dados.criadaEm ?? agora();
    const info = conexao
        .prepare(`
            INSERT INTO eleicoes (
                guild_id, eleicao_ref_id, n, nome, estado, eleitorado,
                publicar_parcial, duracao_minutos, canal_id, criada_por,
                criada_em, atualizada_em
            ) VALUES (
                @guildId, @eleicaoRefId, @n, @nome, @estado, @eleitorado,
                @publicarParcial, @duracaoMinutos, @canalId, @criadaPor,
                @criadaEm, @criadaEm
            )
        `)
        .run({
            guildId: dados.guildId,
            eleicaoRefId: dados.eleicaoRefId,
            n: dados.n,
            nome: dados.nome,
            estado: dados.estado ?? 'BR',
            eleitorado: dados.eleitorado ?? ELEITORADO.TODOS,
            publicarParcial: dados.publicarParcial ? 1 : 0,
            duracaoMinutos: dados.duracaoMinutos ?? null,
            canalId: dados.canalId ?? null,
            criadaPor: dados.criadaPor,
            criadaEm
        });

    const eleicaoId = Number(info.lastInsertRowid);
    const inserirCargo = conexao.prepare(`
        INSERT INTO eleicao_cargos (
            eleicao_id, guild_id, cargo, ordem, digitos, vagas,
            segundo_turno, turno_atual, status, situacao, criada_em
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pendente', 'aguardando', ?)
    `);

    dados.cargos.forEach((cargo, indice) => {
        inserirCargo.run(
            eleicaoId,
            dados.guildId,
            cargo.cargo,
            cargo.ordem ?? indice + 1,
            cargo.digitos,
            cargo.vagas ?? 1,
            cargo.segundoTurno ? 1 : 0,
            criadaEm
        );
    });

    return eleicaoId;
}

function criarEleicao(dados) {
    const eleicaoId = conexao.transaction(executarCriacaoEleicao)(dados);
    return obterEleicao(dados.guildId, eleicaoId);
}

function obterEleicao(guildId, eleicaoId) {
    return paraEleicao(
        conexao
            .prepare('SELECT * FROM eleicoes WHERE guild_id = ? AND id = ?')
            .get(guildId, eleicaoId)
    );
}

function obterEleicaoPorId(eleicaoId) {
    return paraEleicao(
        conexao.prepare('SELECT * FROM eleicoes WHERE id = ?').get(eleicaoId)
    );
}

function listarEleicoes(guildId) {
    return conexao
        .prepare('SELECT * FROM eleicoes WHERE guild_id = ? ORDER BY id DESC')
        .all(guildId)
        .map(paraEleicao);
}

function listarEleicoesComTurnoPendente() {
    return conexao
        .prepare(`
            SELECT * FROM eleicoes
             WHERE status = 'aberta' AND turno = 1
             ORDER BY id
        `)
        .all()
        .map(paraEleicao);
}

const COLUNAS_ELEICAO = new Set([
    'nome',
    'estado',
    'status',
    'turno',
    'eleitorado',
    'publicar_parcial',
    'duracao_minutos',
    'canal_id',
    'mensagem_id',
    'aberta_em',
    'encerra_em',
    'encerrada_em',
    'cancelada_em',
    'motivo_cancelamento'
]);

function atualizarEleicao(eleicaoId, campos) {
    const chaves = Object.keys(campos).filter(chave =>
        COLUNAS_ELEICAO.has(chave)
    );
    if (!chaves.length) return 0;

    const atribuicoes = chaves.map(chave => `${chave} = @${chave}`).join(', ');
    return conexao
        .prepare(`
            UPDATE eleicoes
               SET ${atribuicoes}, atualizada_em = @atualizadaEm
             WHERE id = @eleicaoId
        `)
        .run({ ...campos, eleicaoId, atualizadaEm: agora() }).changes;
}

// ---------------------------------------------------------------------------
// Cargos da eleição
// ---------------------------------------------------------------------------

function listarCargos(eleicaoId) {
    return conexao
        .prepare(`
            SELECT * FROM eleicao_cargos
             WHERE eleicao_id = ?
             ORDER BY ordem, cargo
        `)
        .all(eleicaoId)
        .map(paraCargo);
}

function listarCargosAbertos(eleicaoId) {
    return conexao
        .prepare(`
            SELECT * FROM eleicao_cargos
             WHERE eleicao_id = ? AND status = 'aberta'
             ORDER BY ordem, cargo
        `)
        .all(eleicaoId)
        .map(paraCargo);
}

function obterCargo(eleicaoId, cargo) {
    return paraCargo(
        conexao
            .prepare(
                'SELECT * FROM eleicao_cargos WHERE eleicao_id = ? AND cargo = ?'
            )
            .get(eleicaoId, cargo)
    );
}

function abrirCargos(eleicaoId, quando) {
    return conexao
        .prepare(`
            UPDATE eleicao_cargos
               SET status = 'aberta', situacao = 'em_andamento', aberta_em = ?
             WHERE eleicao_id = ? AND status = 'pendente'
        `)
        .run(quando, eleicaoId).changes;
}

function atualizarCargo(eleicaoId, cargo, campos) {
    const permitidos = [
        'status',
        'situacao',
        'aberta_em',
        'encerrada_em',
        'turno_atual'
    ];
    const chaves = Object.keys(campos).filter(chave =>
        permitidos.includes(chave)
    );
    if (!chaves.length) return 0;

    const atribuicoes = chaves.map(chave => `${chave} = @${chave}`).join(', ');
    return conexao
        .prepare(`
            UPDATE eleicao_cargos SET ${atribuicoes}
             WHERE eleicao_id = @eleicaoId AND cargo = @cargo
        `)
        .run({ ...campos, eleicaoId, cargo }).changes;
}

function contarCargosAbertos(eleicaoId) {
    return conexao
        .prepare(`
            SELECT COUNT(*) AS total FROM eleicao_cargos
             WHERE eleicao_id = ? AND status = 'aberta'
        `)
        .get(eleicaoId).total;
}

function contarCargosPendentes(eleicaoId) {
    return conexao
        .prepare(`
            SELECT COUNT(*) AS total FROM eleicao_cargos
             WHERE eleicao_id = ? AND status = 'pendente'
        `)
        .get(eleicaoId).total;
}

// ---------------------------------------------------------------------------
// Candidaturas congeladas na eleição
// ---------------------------------------------------------------------------

function inserirCandidatos(candidatos) {
    const inserir = conexao.prepare(`
        INSERT INTO eleicao_candidatos (
            eleicao_id, cargo, turno_vigente, candidato_id, politico_id, nome,
            partido_id, partido_nome, partido_sigla, partido_emoji, numero,
            criado_em
        ) VALUES (
            @eleicaoId, @cargo, 1, @candidatoId, @politicoId, @nome,
            @partidoId, @partidoNome, @partidoSigla, @partidoEmoji, @numero,
            @criadoEm
        )
        ON CONFLICT (eleicao_id, cargo, candidato_id) DO UPDATE SET
            nome = excluded.nome,
            partido_id = excluded.partido_id,
            partido_nome = excluded.partido_nome,
            partido_sigla = excluded.partido_sigla,
            partido_emoji = excluded.partido_emoji
    `);

    return conexao.transaction(lista => {
        for (const candidato of lista) inserir.run(candidato);
        return lista.length;
    })(candidatos);
}

function listarCandidatos(eleicaoId, filtros = {}) {
    const condicoes = ['eleicao_id = ?'];
    const parametros = [eleicaoId];

    if (filtros.cargo) {
        condicoes.push('cargo = ?');
        parametros.push(filtros.cargo);
    }
    if (filtros.turnoVigente) {
        condicoes.push('turno_vigente = ?');
        parametros.push(filtros.turnoVigente);
    }
    if (filtros.somenteElegiveis) {
        condicoes.push('eliminado_em IS NULL');
    }

    return conexao
        .prepare(`
            SELECT * FROM eleicao_candidatos
             WHERE ${condicoes.join(' AND ')}
             ORDER BY numero
        `)
        .all(...parametros)
        .map(paraCandidato);
}

/**
 * Candidatos que podem receber voto no turno informado. No segundo turno isso
 * exclui automaticamente todos os que não se classificaram.
 */
function listarCandidatosElegiveis(eleicaoId, cargo, turno) {
    return conexao
        .prepare(`
            SELECT * FROM eleicao_candidatos
             WHERE eleicao_id = ? AND cargo = ?
               AND eliminado_em IS NULL AND turno_vigente <= ?
             ORDER BY numero
        `)
        .all(eleicaoId, cargo, turno)
        .map(paraCandidato);
}

function buscarCandidatoPorNumero(eleicaoId, cargo, numero, turno) {
    return paraCandidato(
        conexao
            .prepare(`
                SELECT * FROM eleicao_candidatos
                 WHERE eleicao_id = ? AND cargo = ? AND numero = ?
                   AND eliminado_em IS NULL AND turno_vigente <= ?
            `)
            .get(eleicaoId, cargo, numero, turno)
    );
}

function obterCandidatoEleicao(eleicaoId, id) {
    return paraCandidato(
        conexao
            .prepare(
                'SELECT * FROM eleicao_candidatos WHERE eleicao_id = ? AND id = ?'
            )
            .get(eleicaoId, id)
    );
}

function eliminarCandidatos(eleicaoId, cargo, ids, quando) {
    if (!ids.length) return 0;

    const marcar = conexao.prepare(`
        UPDATE eleicao_candidatos SET eliminado_em = ?
         WHERE eleicao_id = ? AND cargo = ? AND id = ?
    `);

    return conexao.transaction(() => {
        let total = 0;
        for (const id of ids) {
            total += marcar.run(quando, eleicaoId, cargo, id).changes;
        }
        return total;
    })();
}

function promoverCandidatosSegundoTurno(eleicaoId, cargo, ids) {
    if (!ids.length) return 0;

    const promover = conexao.prepare(`
        UPDATE eleicao_candidatos SET turno_vigente = 2
         WHERE eleicao_id = ? AND cargo = ? AND id = ?
    `);

    return conexao.transaction(() => {
        let total = 0;
        for (const id of ids) {
            total += promover.run(eleicaoId, cargo, id).changes;
        }
        return total;
    })();
}

// ---------------------------------------------------------------------------
// Participação do eleitor — separada do conteúdo do voto
// ---------------------------------------------------------------------------

function iniciarEleitor(eleicaoId, discordId, turno, quando) {
    conexao
        .prepare(`
            INSERT INTO eleitores_votacao (
                eleicao_id, discord_id, turno, status, iniciado_em, atualizado_em
            ) VALUES (?, ?, ?, 'em_curso', ?, ?)
            ON CONFLICT (eleicao_id, discord_id, turno) DO UPDATE SET
                atualizado_em = excluded.atualizado_em
        `)
        .run(eleicaoId, discordId, turno, quando, quando);

    return obterEleitor(eleicaoId, discordId, turno);
}

function obterEleitor(eleicaoId, discordId, turno) {
    return (
        conexao
            .prepare(`
                SELECT * FROM eleitores_votacao
                 WHERE eleicao_id = ? AND discord_id = ? AND turno = ?
            `)
            .get(eleicaoId, discordId, turno) ?? null
    );
}

function concluirEleitor(eleicaoId, discordId, turno, quando) {
    return conexao
        .prepare(`
            UPDATE eleitores_votacao
               SET status = 'concluido', concluido_em = ?, atualizado_em = ?
             WHERE eleicao_id = ? AND discord_id = ? AND turno = ?
        `)
        .run(quando, quando, eleicaoId, discordId, turno).changes;
}

function listarCargosConfirmados(eleicaoId, discordId, turno) {
    return conexao
        .prepare(`
            SELECT cargo FROM eleitores_cargos
             WHERE eleicao_id = ? AND discord_id = ? AND turno = ?
             ORDER BY confirmado_em, cargo
        `)
        .all(eleicaoId, discordId, turno)
        .map(linha => linha.cargo);
}

function contarEleitores(eleicaoId, turno) {
    const linha = conexao
        .prepare(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status = 'concluido' THEN 1 ELSE 0 END)
                       AS concluidos
              FROM eleitores_votacao
             WHERE eleicao_id = ? AND turno = ?
        `)
        .get(eleicaoId, turno);

    return { total: linha.total ?? 0, concluidos: linha.concluidos ?? 0 };
}

// ---------------------------------------------------------------------------
// Registro do voto
// ---------------------------------------------------------------------------

/**
 * Registra um voto. A confirmação do cargo é gravada primeiro, na tabela de
 * participação, dentro da mesma transação: se o eleitor já confirmou aquele
 * cargo, o INSERT OR IGNORE não afeta linhas e o voto é descartado como
 * duplicado — nenhuma confirmação é processada duas vezes, mesmo com cliques
 * repetidos ou interações concorrentes.
 */
function executarRegistroVoto(entrada) {
    const eleicao = obterEleicao(entrada.guildId, entrada.eleicaoId);
    if (!eleicao) return { resultado: 'eleicao_inexistente' };
    if (eleicao.status === STATUS_ELEICAO.CANCELADA) {
        return { resultado: 'eleicao_cancelada', eleicao };
    }
    if (eleicao.status !== STATUS_ELEICAO.ABERTA) {
        return { resultado: 'eleicao_encerrada', eleicao };
    }
    if (eleicao.encerraEm && entrada.quando >= eleicao.encerraEm) {
        return { resultado: 'prazo_encerrado', eleicao };
    }

    const cargo = obterCargo(eleicao.id, entrada.cargo);
    if (!cargo) return { resultado: 'cargo_inexistente', eleicao };
    if (cargo.status !== STATUS_CARGO.ABERTA) {
        return { resultado: 'cargo_fechado', eleicao, cargo };
    }
    if (cargo.turnoAtual !== eleicao.turno) {
        return { resultado: 'turno_incompativel', eleicao, cargo };
    }

    const eleitor = obterEleitor(eleicao.id, entrada.discordId, eleicao.turno);
    if (!eleitor || eleitor.status !== 'em_curso') {
        return { resultado: 'eleitor_nao_autorizado', eleicao, cargo };
    }

    let candidatoId = null;
    let numero = null;
    if (entrada.tipo === TIPO_VOTO.VALIDO) {
        const candidato = buscarCandidatoPorNumero(
            eleicao.id,
            cargo.cargo,
            entrada.numero,
            eleicao.turno
        );
        if (!candidato) {
            return { resultado: 'candidato_invalido', eleicao, cargo };
        }
        candidatoId = candidato.id;
        numero = candidato.numero;
    }

    const confirmacao = conexao
        .prepare(`
            INSERT OR IGNORE INTO eleitores_cargos (
                eleicao_id, discord_id, turno, cargo, confirmado_em
            ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
            eleicao.id,
            entrada.discordId,
            eleicao.turno,
            cargo.cargo,
            entrada.quando
        );

    if (confirmacao.changes === 0) {
        return { resultado: 'duplicado', eleicao, cargo };
    }

    conexao
        .prepare(`
            INSERT INTO votos (
                eleicao_id, cargo, turno, tipo, candidato_id, numero_digitado,
                registrado_em
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
            eleicao.id,
            cargo.cargo,
            eleicao.turno,
            entrada.tipo,
            candidatoId,
            entrada.tipo === TIPO_VOTO.VALIDO ? numero : null,
            entrada.quando
        );

    const abertos = listarCargosAbertos(eleicao.id);
    const confirmados = listarCargosConfirmados(
        eleicao.id,
        entrada.discordId,
        eleicao.turno
    );
    const concluido = abertos.every(item => confirmados.includes(item.cargo));

    if (concluido) {
        concluirEleitor(
            eleicao.id,
            entrada.discordId,
            eleicao.turno,
            entrada.quando
        );
    }

    return {
        resultado: 'registrado',
        eleicao,
        cargo,
        concluido,
        cargosConfirmados: confirmados,
        cargosRestantes: abertos
            .map(item => item.cargo)
            .filter(nomeCargo => !confirmados.includes(nomeCargo))
    };
}

function registrarVoto(entrada) {
    return conexao.transaction(executarRegistroVoto).immediate({
        ...entrada,
        quando: entrada.quando ?? agora()
    });
}

// ---------------------------------------------------------------------------
// Apuração
// ---------------------------------------------------------------------------

function apurarVotos(eleicaoId, cargo, turno) {
    const candidatos = conexao
        .prepare(`
            SELECT c.*, (
                SELECT COUNT(*) FROM votos v
                 WHERE v.candidato_id = c.id AND v.turno = ?
            ) AS votos
              FROM eleicao_candidatos c
             WHERE c.eleicao_id = ? AND c.cargo = ?
               AND (
                    (c.turno_vigente <= ? AND (? = 1 OR c.eliminado_em IS NULL))
                    OR EXISTS (
                        SELECT 1 FROM votos v
                         WHERE v.candidato_id = c.id AND v.turno = ?
                    )
               )
             ORDER BY votos DESC, c.numero
        `)
        .all(turno, eleicaoId, cargo, turno, turno, turno)
        .map(linha => ({ ...paraCandidato(linha), votos: linha.votos }));

    const tipos = conexao
        .prepare(`
            SELECT tipo, COUNT(*) AS total FROM votos
             WHERE eleicao_id = ? AND cargo = ? AND turno = ?
             GROUP BY tipo
        `)
        .all(eleicaoId, cargo, turno);

    const brancos =
        tipos.find(linha => linha.tipo === TIPO_VOTO.BRANCO)?.total ?? 0;
    const nulos = tipos.find(linha => linha.tipo === TIPO_VOTO.NULO)?.total ?? 0;
    const validos = candidatos.reduce((total, item) => total + item.votos, 0);
    const eleitores = contarEleitores(eleicaoId, turno);

    return {
        cargo,
        turno,
        candidatos: candidatos.map(item => ({
            ...item,
            percentual: validos ? (item.votos / validos) * 100 : 0
        })),
        brancos,
        nulos,
        validos,
        total: validos + brancos + nulos,
        eleitores
    };
}

function salvarResultado(entrada) {
    const apuracao = entrada.apuracao;
    const calculadoEm = entrada.calculadoEm ?? agora();

    return conexao.transaction(() => {
        conexao
            .prepare(`
                DELETE FROM resultados
                 WHERE eleicao_id = ? AND cargo = ? AND turno = ?
            `)
            .run(entrada.eleicaoId, apuracao.cargo, apuracao.turno);

        const inserir = conexao.prepare(`
            INSERT INTO resultados (
                eleicao_id, cargo, turno, tipo, candidato_id, nome, numero,
                partido_nome, partido_sigla, votos, percentual_validos, eleito,
                calculado_em
            ) VALUES (
                @eleicaoId, @cargo, @turno, @tipo, @candidatoId, @nome, @numero,
                @partidoNome, @partidoSigla, @votos, @percentual, @eleito,
                @calculadoEm
            )
        `);

        for (const candidato of apuracao.candidatos) {
            inserir.run({
                eleicaoId: entrada.eleicaoId,
                cargo: apuracao.cargo,
                turno: apuracao.turno,
                tipo: TIPO_VOTO.VALIDO,
                candidatoId: candidato.id,
                nome: candidato.nome,
                numero: candidato.numero,
                partidoNome: candidato.partidoNome,
                partidoSigla: candidato.partidoSigla,
                votos: candidato.votos,
                percentual: candidato.percentual,
                eleito: candidato.id === entrada.vencedorId ? 1 : 0,
                calculadoEm
            });
        }

        const percentualSobreValidos = votos =>
            apuracao.validos ? (votos / apuracao.validos) * 100 : null;

        inserir.run({
            eleicaoId: entrada.eleicaoId,
            cargo: apuracao.cargo,
            turno: apuracao.turno,
            tipo: TIPO_VOTO.BRANCO,
            candidatoId: null,
            nome: 'Branco',
            numero: null,
            partidoNome: null,
            partidoSigla: null,
            votos: apuracao.brancos,
            percentual: percentualSobreValidos(apuracao.brancos),
            eleito: 0,
            calculadoEm
        });

        inserir.run({
            eleicaoId: entrada.eleicaoId,
            cargo: apuracao.cargo,
            turno: apuracao.turno,
            tipo: TIPO_VOTO.NULO,
            candidatoId: null,
            nome: 'Nulo',
            numero: null,
            partidoNome: null,
            partidoSigla: null,
            votos: apuracao.nulos,
            percentual: percentualSobreValidos(apuracao.nulos),
            eleito: 0,
            calculadoEm
        });

        const vencedor = apuracao.candidatos.find(
            candidato => candidato.id === entrada.vencedorId
        );

        conexao
            .prepare(`
                INSERT INTO resultado_cargos (
                    eleicao_id, cargo, turno, situacao, votos_validos,
                    votos_brancos, votos_nulos, total_votos, eleitores,
                    eleitores_concluidos, vencedor_id, vencedor_nome,
                    vencedor_numero, vencedor_partido_sigla,
                    vencedor_percentual, aguarda_segundo_turno, observacao,
                    calculado_em
                ) VALUES (
                    @eleicaoId, @cargo, @turno, @situacao, @validos, @brancos,
                    @nulos, @total, @eleitores, @eleitoresConcluidos,
                    @vencedorId, @vencedorNome, @vencedorNumero,
                    @vencedorSigla, @vencedorPercentual, @aguardaSegundoTurno,
                    @observacao, @calculadoEm
                )
                ON CONFLICT (eleicao_id, cargo, turno) DO UPDATE SET
                    situacao = excluded.situacao,
                    votos_validos = excluded.votos_validos,
                    votos_brancos = excluded.votos_brancos,
                    votos_nulos = excluded.votos_nulos,
                    total_votos = excluded.total_votos,
                    eleitores = excluded.eleitores,
                    eleitores_concluidos = excluded.eleitores_concluidos,
                    vencedor_id = excluded.vencedor_id,
                    vencedor_nome = excluded.vencedor_nome,
                    vencedor_numero = excluded.vencedor_numero,
                    vencedor_partido_sigla = excluded.vencedor_partido_sigla,
                    vencedor_percentual = excluded.vencedor_percentual,
                    aguarda_segundo_turno = excluded.aguarda_segundo_turno,
                    observacao = excluded.observacao,
                    calculado_em = excluded.calculado_em
            `)
            .run({
                eleicaoId: entrada.eleicaoId,
                cargo: apuracao.cargo,
                turno: apuracao.turno,
                situacao: entrada.situacao,
                validos: apuracao.validos,
                brancos: apuracao.brancos,
                nulos: apuracao.nulos,
                total: apuracao.total,
                eleitores: apuracao.eleitores.total,
                eleitoresConcluidos: apuracao.eleitores.concluidos,
                vencedorId: vencedor?.id ?? null,
                vencedorNome: vencedor?.nome ?? null,
                vencedorNumero: vencedor?.numero ?? null,
                vencedorSigla: vencedor?.partidoSigla ?? null,
                vencedorPercentual: vencedor?.percentual ?? null,
                aguardaSegundoTurno: entrada.aguardaSegundoTurno ? 1 : 0,
                observacao: entrada.observacao ?? null,
                calculadoEm
            });
    }).immediate();
}

// ---------------------------------------------------------------------------
// Consulta de Resultados
// ---------------------------------------------------------------------------

function obterResultadoCargo(eleicaoId, cargo, turno) {
    return (
        conexao
            .prepare(`
                SELECT * FROM resultado_cargos
                 WHERE eleicao_id = ? AND cargo = ? AND turno = ?
            `)
            .get(eleicaoId, cargo, turno) ?? null
    );
}

function listarResultadosCargo(eleicaoId, cargo, turno) {
    return conexao
        .prepare(`
            SELECT * FROM resultados
             WHERE eleicao_id = ? AND cargo = ? AND turno = ?
             ORDER BY tipo = 'valido' DESC, votos DESC, nome
        `)
        .all(eleicaoId, cargo, turno);
}

function listarResultadoCargosEleicao(eleicaoId, turno) {
    const condicoes = ['eleicao_id = ?'];
    const parametros = [eleicaoId];
    if (turno !== undefined && turno !== null) {
        condicoes.push('turno = ?');
        parametros.push(turno);
    }
    return conexao
        .prepare(`
            SELECT * FROM resultado_cargos
             WHERE ${condicoes.join(' AND ')}
             ORDER BY cargo, turno
        `)
        .all(...parametros);
}

function obterResultadosCompletos(eleicaoId, turno) {
    const cargosResultado = listarResultadoCargosEleicao(eleicaoId, turno);
    return cargosResultado.map(resCargo => ({
        ...resCargo,
        itens: listarResultadosCargo(eleicaoId, resCargo.cargo, resCargo.turno)
    }));
}

// ---------------------------------------------------------------------------
// Agendamentos (Segundo turno e Encerramentos automáticos)
// ---------------------------------------------------------------------------

function criarAgendamento({
    eleicaoId,
    tipo,
    cargo = '',
    turno = 1,
    executarEm,
    detalhe = null
}) {
    const timestamp = agora();
    conexao
        .prepare(`
            INSERT INTO agendamentos (
                eleicao_id, tipo, cargo, turno, executar_em, status,
                tentativas, detalhe, criado_em, atualizado_em
            ) VALUES (?, ?, ?, ?, ?, 'pendente', 0, ?, ?, ?)
            ON CONFLICT (eleicao_id, tipo, cargo, turno) DO UPDATE SET
                executar_em = excluded.executar_em,
                status = 'pendente',
                detalhe = excluded.detalhe,
                atualizado_em = excluded.atualizado_em
        `)
        .run(
            eleicaoId,
            tipo,
            cargo,
            turno,
            executarEm,
            detalhe,
            timestamp,
            timestamp
        );

    return conexao
        .prepare(`
            SELECT * FROM agendamentos
             WHERE eleicao_id = ? AND tipo = ? AND cargo = ? AND turno = ?
        `)
        .get(eleicaoId, tipo, cargo, turno);
}

function obterAgendamento(id) {
    return conexao.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id) ?? null;
}

function listarAgendamentosPendentes(ateMomento) {
    const condicoes = ["status = 'pendente'"];
    const parametros = [];
    if (ateMomento) {
        condicoes.push('executar_em <= ?');
        parametros.push(ateMomento);
    }
    return conexao
        .prepare(`
            SELECT * FROM agendamentos
             WHERE ${condicoes.join(' AND ')}
             ORDER BY executar_em, id
        `)
        .all(...parametros);
}

function listarAgendamentosEleicao(eleicaoId) {
    return conexao
        .prepare(`
            SELECT * FROM agendamentos
             WHERE eleicao_id = ?
             ORDER BY executar_em, id
        `)
        .all(eleicaoId);
}

function atualizarStatusAgendamento(id, status, detalhe = null) {
    return conexao
        .prepare(`
            UPDATE agendamentos
               SET status = ?,
                   detalhe = COALESCE(?, detalhe),
                   tentativas = tentativas + 1,
                   atualizado_em = ?
             WHERE id = ?
        `)
        .run(status, detalhe, agora(), id).changes;
}

function cancelarAgendamentosEleicao(eleicaoId, tipo = null) {
    const condicoes = ['eleicao_id = ?', "status = 'pendente'"];
    const parametros = [eleicaoId];
    if (tipo) {
        condicoes.push('tipo = ?');
        parametros.push(tipo);
    }
    return conexao
        .prepare(`
            UPDATE agendamentos
               SET status = 'cancelado', atualizado_em = ?
             WHERE ${condicoes.join(' AND ')}
        `)
        .run(agora(), ...parametros).changes;
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------

function registrarAuditoria({
    eleicaoId = null,
    guildId,
    evento,
    detalhe = null,
    atorId = null,
    criadoEm = agora()
}) {
    const info = conexao
        .prepare(`
            INSERT INTO eleicao_auditoria (
                eleicao_id, guild_id, evento, detalhe, ator_id, criado_em
            ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(eleicaoId, guildId, evento, detalhe, atorId, criadoEm);
    return Number(info.lastInsertRowid);
}

function listarAuditoria(eleicaoId) {
    return conexao
        .prepare(`
            SELECT * FROM eleicao_auditoria
             WHERE eleicao_id = ?
             ORDER BY id ASC
        `)
        .all(eleicaoId);
}

// ---------------------------------------------------------------------------
// Operações Administrativas
// ---------------------------------------------------------------------------

function encerrarEleicao(eleicaoId, quando = agora()) {
    return conexao.transaction(() => {
        const info = conexao
            .prepare(`
                UPDATE eleicoes
                   SET status = 'encerrada', encerrada_em = ?, atualizada_em = ?
                 WHERE id = ? AND status = 'aberta'
            `)
            .run(quando, quando, eleicaoId);

        conexao
            .prepare(`
                UPDATE eleicao_cargos
                   SET status = 'encerrada', encerrada_em = ?
                 WHERE eleicao_id = ? AND status = 'aberta'
            `)
            .run(quando, eleicaoId);

        return info.changes;
    })();
}

function cancelarEleicao(eleicaoId, motivo, quando = agora()) {
    return conexao.transaction(() => {
        const info = conexao
            .prepare(`
                UPDATE eleicoes
                   SET status = 'cancelada', cancelada_em = ?,
                       motivo_cancelamento = ?, atualizada_em = ?
                 WHERE id = ? AND status IN ('configurada', 'aberta')
            `)
            .run(quando, motivo, quando, eleicaoId);

        conexao
            .prepare(`
                UPDATE eleicao_cargos
                   SET status = 'cancelada', situacao = 'cancelada'
                 WHERE eleicao_id = ? AND status != 'encerrada'
            `)
            .run(eleicaoId);

        return info.changes;
    })();
}

function reabrir(caminhoNovo = null) {
    if (conexao && conexao.open) {
        conexao.close();
    }
    const destino = caminhoNovo || process.env.ELEICOES_DB_PATH || DB_PATH;
    conexao = new Database(destino);
    conexao.pragma('journal_mode = WAL');
    conexao.pragma('foreign_keys = ON');
    conexao.pragma('busy_timeout = 5000');
    inicializarEsquema(conexao);
    return conexao;
}

function fechar() {
    if (conexao && conexao.open) {
        conexao.close();
    }
}

module.exports = {
    STATUS_ELEICAO,
    STATUS_CARGO,
    SITUACAO,
    TIPO_VOTO,
    TIPO_AGENDAMENTO,
    STATUS_AGENDAMENTO,
    ELEITORADO,
    SEGUNDO_TURNO_ATRASO_MS,
    CARGOS_SEGUNDO_TURNO,
    ORDEM_CARGOS,
    criarEleicao,
    obterEleicao,
    obterEleicaoPorId,
    listarEleicoes,
    listarEleicoesComTurnoPendente,
    atualizarEleicao,
    listarCargos,
    listarCargosAbertos,
    obterCargo,
    abrirCargos,
    atualizarCargo,
    contarCargosAbertos,
    contarCargosPendentes,
    inserirCandidatos,
    listarCandidatos,
    listarCandidatosElegiveis,
    buscarCandidatoPorNumero,
    obterCandidatoEleicao,
    eliminarCandidatos,
    promoverCandidatosSegundoTurno,
    iniciarEleitor,
    obterEleitor,
    concluirEleitor,
    listarCargosConfirmados,
    contarEleitores,
    registrarVoto,
    apurarVotos,
    salvarResultado,
    obterResultadoCargo,
    listarResultadosCargo,
    listarResultadoCargosEleicao,
    obterResultadosCompletos,
    criarAgendamento,
    obterAgendamento,
    listarAgendamentosPendentes,
    listarAgendamentosEleicao,
    atualizarStatusAgendamento,
    cancelarAgendamentosEleicao,
    registrarAuditoria,
    listarAuditoria,
    encerrarEleicao,
    cancelarEleicao,
    reabrir,
    fechar
};
