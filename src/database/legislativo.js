'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DB_PATH =
    process.env.DB_PATH || path.join(__dirname, 'partidos.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS legislativo_config (
        guild_id TEXT PRIMARY KEY,
        camara_total INTEGER NOT NULL DEFAULT 513 CHECK (camara_total > 0),
        senado_total INTEGER NOT NULL DEFAULT 81 CHECK (senado_total > 0),
        deputados_role_id TEXT,
        senadores_role_id TEXT,
        presidente_role_id TEXT,
        apoios_populares_minimos INTEGER NOT NULL DEFAULT 1000000
            CHECK (apoios_populares_minimos >= 1),
        duracao_votacao_horas INTEGER NOT NULL DEFAULT 48
            CHECK (duracao_votacao_horas BETWEEN 1 AND 720),
        sessao_legislativa TEXT NOT NULL DEFAULT '1',
        intervencao_federal INTEGER NOT NULL DEFAULT 0 CHECK (intervencao_federal IN (0, 1)),
        estado_defesa INTEGER NOT NULL DEFAULT 0 CHECK (estado_defesa IN (0, 1)),
        estado_sitio INTEGER NOT NULL DEFAULT 0 CHECK (estado_sitio IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS legislativo_proposicoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        sessao_legislativa TEXT NOT NULL DEFAULT '1',
        tipo TEXT NOT NULL CHECK (tipo IN ('PEC', 'PL', 'PLP', 'IMPEACHMENT')),
        titulo TEXT NOT NULL,
        ementa TEXT NOT NULL,
        texto TEXT NOT NULL,
        justificativa TEXT NOT NULL,
        referencias TEXT NOT NULL DEFAULT '',
        denunciado_id TEXT,
        denunciado TEXT,
        cargo_denunciado TEXT,
        autor_id TEXT,
        autor_nome TEXT,
        texto_vigente TEXT,
        veto_json TEXT,
        revisao_pendente INTEGER NOT NULL DEFAULT 0 CHECK (revisao_pendente IN (0, 1)),
        denunciante_id TEXT NOT NULL,
        denunciante_nome TEXT NOT NULL,
        casa_iniciadora TEXT CHECK (casa_iniciadora IN ('CAMARA', 'SENADO')),
        etapa TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'EM_TRAMITACAO',
        hash_conteudo TEXT NOT NULL,
        resultado TEXT,
        lei_numero TEXT,
        publicacao_status TEXT NOT NULL DEFAULT 'PENDENTE',
        publicacao_message_id TEXT,
        criada_em TEXT NOT NULL,
        atualizada_em TEXT NOT NULL,
        FOREIGN KEY (guild_id) REFERENCES legislativo_config(guild_id)
    );
    CREATE TABLE IF NOT EXISTS legislativo_tramitacao (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposicao_id INTEGER NOT NULL,
        etapa TEXT NOT NULL,
        evento TEXT NOT NULL,
        detalhe TEXT NOT NULL,
        ator_id TEXT NOT NULL,
        criada_em TEXT NOT NULL,
        FOREIGN KEY (proposicao_id) REFERENCES legislativo_proposicoes(id)
            ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS legislativo_revisoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposicao_id INTEGER NOT NULL,
        etapa TEXT NOT NULL,
        texto_anterior TEXT NOT NULL,
        texto_novo TEXT NOT NULL,
        ator_id TEXT NOT NULL,
        criada_em TEXT NOT NULL,
        FOREIGN KEY (proposicao_id) REFERENCES legislativo_proposicoes(id)
            ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS legislativo_votacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposicao_id INTEGER NOT NULL,
        etapa TEXT NOT NULL,
        casa TEXT NOT NULL CHECK (casa IN ('CAMARA', 'SENADO')),
        cargo_role_id TEXT,
        regra TEXT NOT NULL,
        total_membros INTEGER NOT NULL CHECK (total_membros > 0),
        quórum_presença INTEGER NOT NULL CHECK (quórum_presença > 0),
        elegiveis_json TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'ABERTA' CHECK (estado IN ('ABERTA', 'ENCERRADA')),
        iniciada_por TEXT NOT NULL,
        criada_em TEXT NOT NULL,
        encerra_em TEXT NOT NULL,
        encerrada_em TEXT,
        resultado_json TEXT,
        UNIQUE (proposicao_id, etapa),
        FOREIGN KEY (proposicao_id) REFERENCES legislativo_proposicoes(id)
            ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS legislativo_votos (
        votacao_id INTEGER NOT NULL,
        eleitor_id TEXT NOT NULL,
        escolha TEXT NOT NULL CHECK (escolha IN ('SIM', 'NAO', 'BRANCO')),
        registrada_em TEXT NOT NULL,
        PRIMARY KEY (votacao_id, eleitor_id),
        FOREIGN KEY (votacao_id) REFERENCES legislativo_votacoes(id)
            ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS legislativo_auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        proposicao_id INTEGER,
        evento TEXT NOT NULL,
        detalhe TEXT NOT NULL,
        ator_id TEXT NOT NULL,
        criada_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS legislativo_apoios (
        proposicao_id INTEGER NOT NULL,
        discord_id TEXT NOT NULL,
        tipo_apoio TEXT NOT NULL CHECK (tipo_apoio IN ('CAMARA', 'SENADO', 'POPULAR')),
        criada_em TEXT NOT NULL,
        PRIMARY KEY (proposicao_id, discord_id),
        FOREIGN KEY (proposicao_id) REFERENCES legislativo_proposicoes(id)
            ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS legislativo_inabilitacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        proposicao_id INTEGER NOT NULL UNIQUE,
        inicio_em TEXT NOT NULL,
        fim_em TEXT NOT NULL,
        cargo_removido INTEGER NOT NULL DEFAULT 0 CHECK (cargo_removido IN (0, 1)),
        FOREIGN KEY (proposicao_id) REFERENCES legislativo_proposicoes(id)
            ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_leg_inabilitacoes_usuario
        ON legislativo_inabilitacoes(guild_id, discord_id, fim_em);
`);

const colunasVotacoes = new Set(
    db.pragma('table_info(legislativo_votacoes)').map(coluna => coluna.name)
);
if (!colunasVotacoes.has('cargo_role_id')) {
    db.exec(`
        ALTER TABLE legislativo_votacoes
        ADD COLUMN cargo_role_id TEXT
    `);
}
const colunasConfig = new Set(
    db.pragma('table_info(legislativo_config)').map(coluna => coluna.name)
);
if (!colunasConfig.has('apoios_populares_minimos')) {
    db.exec(`
        ALTER TABLE legislativo_config
        ADD COLUMN apoios_populares_minimos INTEGER NOT NULL DEFAULT 1000000
    `);
}
const colunasProposicoes = new Set(
    db.pragma('table_info(legislativo_proposicoes)').map(coluna => coluna.name)
);
if (!colunasProposicoes.has('casa_iniciadora')) {
    db.exec(`
        ALTER TABLE legislativo_proposicoes
        ADD COLUMN casa_iniciadora TEXT CHECK (casa_iniciadora IN ('CAMARA', 'SENADO'))
    `);
}
if (!colunasProposicoes.has('publicacao_status')) {
    db.exec(`
        ALTER TABLE legislativo_proposicoes
        ADD COLUMN publicacao_status TEXT NOT NULL DEFAULT 'PENDENTE'
    `);
}
if (!colunasProposicoes.has('publicacao_message_id')) {
    db.exec(`
        ALTER TABLE legislativo_proposicoes
        ADD COLUMN publicacao_message_id TEXT
    `);
}
if (!colunasProposicoes.has('denunciado_id')) {
    db.exec(`
        ALTER TABLE legislativo_proposicoes
        ADD COLUMN denunciado_id TEXT
    `);
}
if (!colunasProposicoes.has('sessao_legislativa')) {
    db.exec(`
        ALTER TABLE legislativo_proposicoes
        ADD COLUMN sessao_legislativa TEXT NOT NULL DEFAULT '1'
    `);
}
for (const [nome, tipo] of [
    ['autor_id', 'TEXT'],
    ['autor_nome', 'TEXT'],
    ['texto_vigente', 'TEXT'],
    ['veto_json', 'TEXT'],
    ['revisao_pendente', 'INTEGER NOT NULL DEFAULT 0']
]) {
    if (!colunasProposicoes.has(nome)) {
        db.exec(`ALTER TABLE legislativo_proposicoes ADD COLUMN ${nome} ${tipo}`);
    }
}
db.exec(`
    UPDATE legislativo_proposicoes
       SET autor_id = denunciante_id,
           autor_nome = denunciante_nome
     WHERE autor_id IS NULL OR autor_nome IS NULL
`);
db.exec(`
    DROP INDEX IF EXISTS idx_leg_proposicao_hash;
    CREATE UNIQUE INDEX idx_leg_proposicao_hash
        ON legislativo_proposicoes(guild_id, sessao_legislativa, hash_conteudo);
`);

const agora = () => new Date().toISOString();

function obterConfiguracao(guildId) {
    db.prepare(
        'INSERT OR IGNORE INTO legislativo_config (guild_id) VALUES (?)'
    ).run(guildId);
    return db
        .prepare('SELECT * FROM legislativo_config WHERE guild_id = ?')
        .get(guildId);
}

function configurar(guildId, campos, atorId) {
    const permitidos = new Set([
        'camara_total',
        'senado_total',
        'deputados_role_id',
        'senadores_role_id',
        'presidente_role_id',
        'apoios_populares_minimos',
        'duracao_votacao_horas',
        'sessao_legislativa',
        'intervencao_federal',
        'estado_defesa',
        'estado_sitio'
    ]);
    const entradas = Object.entries(campos).filter(([nome]) =>
        permitidos.has(nome)
    );
    if (!entradas.length) return obterConfiguracao(guildId);

    for (const [nome, valor] of entradas) {
        if (
            ['camara_total', 'senado_total'].includes(nome) &&
            (!Number.isSafeInteger(valor) || valor < 1 || valor > 10000)
        ) {
            throw new RangeError('A composição deve ser um inteiro entre 1 e 10000.');
        }
        if (
            nome === 'duracao_votacao_horas' &&
            (!Number.isSafeInteger(valor) || valor < 1 || valor > 720)
        ) {
            throw new RangeError('A duração deve estar entre 1 e 720 horas.');
        }
        if (
            nome === 'apoios_populares_minimos' &&
            (!Number.isSafeInteger(valor) || valor < 1 || valor > 100000000)
        ) {
            throw new RangeError('O número mínimo de apoiamentos deve estar entre 1 e 100000000.');
        }
        if (
            ['intervencao_federal', 'estado_defesa', 'estado_sitio'].includes(nome) &&
            ![0, 1].includes(valor)
        ) {
            throw new RangeError('Estado constitucional inválido.');
        }
        if (nome === 'sessao_legislativa' && !String(valor).trim()) {
            throw new RangeError('A sessão legislativa não pode ser vazia.');
        }
    }
    const set = entradas.map(([nome]) => `${nome} = @${nome}`).join(', ');
    const valores = Object.fromEntries(entradas);
    return db.transaction(() => {
        obterConfiguracao(guildId);
        db.prepare(`UPDATE legislativo_config SET ${set} WHERE guild_id = @guild_id`)
            .run({ guild_id: guildId, ...valores });
        registrarAuditoria(guildId, null, 'CONFIGURACAO_ALTERADA',
            JSON.stringify(valores), atorId);
        return obterConfiguracao(guildId);
    }).immediate();
}

function registrarAuditoria(guildId, proposicaoId, evento, detalhe, atorId) {
    db.prepare(`
        INSERT INTO legislativo_auditoria
            (guild_id, proposicao_id, evento, detalhe, ator_id, criada_em)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(guildId, proposicaoId, evento, String(detalhe).slice(0, 4000), atorId, agora());
}

function criarProposicao(dados) {
    const criadoEm = agora();
    const hash = crypto
        .createHash('sha256')
        .update([
            dados.tipo,
            dados.titulo,
            dados.ementa,
            dados.texto,
            dados.justificativa,
            dados.referencias ?? '',
            dados.denunciado ?? ''
        ].map(valor => String(valor).trim().toLocaleLowerCase('pt-BR')).join('\n'))
        .digest('hex');

    const operação = db.transaction(() => {
        const config = obterConfiguracao(dados.guildId);
        const info = db.prepare(`
            INSERT INTO legislativo_proposicoes (
                guild_id, sessao_legislativa, tipo, titulo, ementa, texto, justificativa, referencias,
                denunciado_id, denunciado, cargo_denunciado, autor_id, autor_nome,
                denunciante_id, denunciante_nome,
                etapa, hash_conteudo, criada_em, atualizada_em
            ) VALUES (
                @guildId, @sessao, @tipo, @titulo, @ementa, @texto, @justificativa,
                @referencias, @denunciadoId, @denunciado, @cargoDenunciado, @autorId,
                @autorNome, @denuncianteId, @denuncianteNome,
                'ADMISSIBILIDADE', @hash, @criadoEm, @criadoEm
            )
        `).run({
            ...dados,
            autorId: dados.autorId ?? dados.denuncianteId,
            autorNome: dados.autorNome ?? dados.denuncianteNome,
            hash,
            sessao: config.sessao_legislativa,
            criadoEm,
            referencias: dados.referencias ?? '',
            denunciadoId: dados.denunciadoId ?? null,
            denunciado: dados.denunciado ?? null,
            cargoDenunciado: dados.cargoDenunciado ?? null
        });
        const id = Number(info.lastInsertRowid);
        db.prepare(`
            INSERT INTO legislativo_tramitacao
                (proposicao_id, etapa, evento, detalhe, ator_id, criada_em)
            VALUES (?, 'ADMISSIBILIDADE', 'APRESENTADA', 'Proposição registrada para análise de admissibilidade.', ?, ?)
        `).run(id, dados.denuncianteId, criadoEm);
        registrarAuditoria(
            dados.guildId, id, 'PROPOSICAO_APRESENTADA', dados.tipo, dados.denuncianteId
        );
        return obterProposicao(id, dados.guildId);
    });
    return operação.immediate();
}

function obterProposicao(id, guildId) {
    return db.prepare(`
        SELECT * FROM legislativo_proposicoes WHERE id = ? AND guild_id = ?
    `).get(id, guildId) ?? null;
}

function registrarApoio(proposicao, discordId, tipoApoio) {
    if (!['CAMARA', 'SENADO', 'POPULAR'].includes(tipoApoio)) {
        throw new RangeError('Tipo de apoiamento inválido.');
    }
    if (proposicao.status !== 'EM_TRAMITACAO' || proposicao.etapa !== 'ADMISSIBILIDADE') {
        throw new Error('A proposição não está recebendo apoiamentos.');
    }
    db.transaction(() => {
        db.prepare(`
            INSERT INTO legislativo_apoios (proposicao_id, discord_id, tipo_apoio, criada_em)
            VALUES (?, ?, ?, ?)
        `).run(proposicao.id, discordId, tipoApoio, agora());
        registrarAuditoria(
            proposicao.guild_id,
            proposicao.id,
            'APOIAMENTO_REGISTRADO',
            `Apoio ${tipoApoio} registrado.`,
            discordId
        );
    }).immediate();
}

function contarApoios(proposicaoId, tipoApoio) {
    return db.prepare(`
        SELECT COUNT(*) AS quantidade FROM legislativo_apoios
         WHERE proposicao_id = ? AND tipo_apoio = ?
    `).get(proposicaoId, tipoApoio).quantidade;
}

function listarHistorico(proposicaoId) {
    return db.prepare(`
        SELECT * FROM legislativo_tramitacao WHERE proposicao_id = ? ORDER BY id
    `).all(proposicaoId);
}

function registrarEvento(
    proposicao, evento, detalhe, atorId, novaEtapa, novoStatus, casaIniciadora = null
) {
    const timestamp = agora();
    const transação = db.transaction(() => {
        const atualizado = db.prepare(`
            UPDATE legislativo_proposicoes
               SET etapa = COALESCE(?, etapa), status = COALESCE(?, status),
                   casa_iniciadora = COALESCE(?, casa_iniciadora),
                   atualizada_em = ?
             WHERE id = ? AND guild_id = ? AND etapa = ? AND status = 'EM_TRAMITACAO'
        `).run(
            novaEtapa, novoStatus, casaIniciadora, timestamp,
            proposicao.id, proposicao.guild_id, proposicao.etapa
        );
        if (atualizado.changes !== 1) {
            throw new Error('A proposição mudou de estado; atualize e tente novamente.');
        }
        db.prepare(`
            INSERT INTO legislativo_tramitacao
                (proposicao_id, etapa, evento, detalhe, ator_id, criada_em)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(proposicao.id, novaEtapa ?? proposicao.etapa, evento, detalhe, atorId, timestamp);
        registrarAuditoria(proposicao.guild_id, proposicao.id, evento, detalhe, atorId);
    });
    transação.immediate();
    return obterProposicao(proposicao.id, proposicao.guild_id);
}

function revisarTexto(proposicao, textoNovo, atorId) {
    if (typeof textoNovo !== 'string' || !textoNovo.trim() || textoNovo.length > 4000) {
        throw new RangeError('O texto alterado deve conter de 1 a 4000 caracteres.');
    }
    const casaRevisora = proposicao.casa_iniciadora === 'CAMARA'
        ? proposicao.etapa === 'SENADO_TURNO_1'
        : proposicao.casa_iniciadora === 'SENADO' &&
            proposicao.etapa === 'CAMARA_TURNO_1';
    if (!casaRevisora || proposicao.status !== 'EM_TRAMITACAO') {
        throw new Error('O texto só pode ser alterado pela Casa revisora antes da votação daquela etapa.');
    }

    const timestamp = agora();
    return db.transaction(() => {
        const atual = obterProposicao(proposicao.id, proposicao.guild_id);
        if (!atual || atual.etapa !== proposicao.etapa || atual.status !== 'EM_TRAMITACAO') {
            throw new Error('A tramitação mudou de estado; atualize e tente novamente.');
        }
        const votação = db.prepare(`
            SELECT 1 FROM legislativo_votacoes
             WHERE proposicao_id = ? AND etapa = ?
        `).get(proposicao.id, proposicao.etapa);
        if (votação) {
            throw new Error('A votação da Casa revisora já foi aberta; o texto não pode mais ser alterado.');
        }
        db.prepare(`
            INSERT INTO legislativo_revisoes
                (proposicao_id, etapa, texto_anterior, texto_novo, ator_id, criada_em)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            proposicao.id, proposicao.etapa, atual.texto, textoNovo.trim(), atorId, timestamp
        );
        db.prepare(`
            UPDATE legislativo_proposicoes
               SET texto = ?, revisao_pendente = 1, atualizada_em = ?
             WHERE id = ? AND etapa = ? AND status = 'EM_TRAMITACAO'
        `).run(textoNovo.trim(), timestamp, proposicao.id, proposicao.etapa);
        db.prepare(`
            INSERT INTO legislativo_tramitacao
                (proposicao_id, etapa, evento, detalhe, ator_id, criada_em)
            VALUES (?, ?, 'TEXTO_ALTERADO_PELA_CASA_REVISORA', ?, ?, ?)
        `).run(
            proposicao.id,
            proposicao.etapa,
            'O texto foi alterado pela Casa revisora; a votação desta etapa decide a redação alterada.',
            atorId,
            timestamp
        );
        registrarAuditoria(
            proposicao.guild_id,
            proposicao.id,
            'TEXTO_ALTERADO_PELA_CASA_REVISORA',
            `Etapa ${proposicao.etapa}; revisão #${db.prepare('SELECT last_insert_rowid() AS id').get().id}.`,
            atorId
        );
        return obterProposicao(proposicao.id, proposicao.guild_id);
    }).immediate();
}

function registrarVeto(proposicao, veto, atorId) {
    const timestamp = agora();
    return db.transaction(() => {
        const atualizado = db.prepare(`
            UPDATE legislativo_proposicoes
               SET etapa = 'VETO_CAMARA', veto_json = ?, atualizada_em = ?
             WHERE id = ? AND guild_id = ? AND etapa = 'SANCAO'
               AND status = 'EM_TRAMITACAO' AND veto_json IS NULL
        `).run(JSON.stringify(veto), timestamp, proposicao.id, proposicao.guild_id);
        if (atualizado.changes !== 1) {
            throw new Error('A proposta não aguarda decisão presidencial ou já tem veto registrado.');
        }
        const detalhe = JSON.stringify(veto);
        db.prepare(`
            INSERT INTO legislativo_tramitacao
                (proposicao_id, etapa, evento, detalhe, ator_id, criada_em)
            VALUES (?, 'VETO_CAMARA', 'VETO_PRESIDENCIAL', ?, ?, ?)
        `).run(proposicao.id, detalhe, atorId, timestamp);
        registrarAuditoria(
            proposicao.guild_id, proposicao.id, 'VETO_PRESIDENCIAL', detalhe, atorId
        );
        return obterProposicao(proposicao.id, proposicao.guild_id);
    }).immediate();
}

function criarVotacao({
    proposicao, casa, cargoRoleId, regra, totalMembros, quórumPresença, elegiveis, iniciadaPor, prazoHoras
}) {
    const timestamp = agora();
    const encerra = new Date(Date.now() + prazoHoras * 3600000).toISOString();
    return db.transaction(() => {
        const info = db.prepare(`
            INSERT INTO legislativo_votacoes (
                proposicao_id, etapa, casa, cargo_role_id, regra, total_membros, quórum_presença,
                elegiveis_json, iniciada_por, criada_em, encerra_em
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            proposicao.id, proposicao.etapa, casa, cargoRoleId, regra, totalMembros,
            quórumPresença, JSON.stringify([...new Set(elegiveis)]), iniciadaPor,
            timestamp, encerra
        );
        const votoId = Number(info.lastInsertRowid);
        registrarAuditoria(
            proposicao.guild_id, proposicao.id, 'VOTACAO_ABERTA',
            `Votação ${votoId} em ${proposicao.etapa}; casa ${casa}.`, iniciadaPor
        );
        return obterVotacao(votoId);
    }).immediate();
}

function obterVotacao(id) {
    const voto = db.prepare(`
        SELECT v.*, p.guild_id, p.tipo, p.titulo
          FROM legislativo_votacoes v
          JOIN legislativo_proposicoes p ON p.id = v.proposicao_id
         WHERE v.id = ?
    `).get(id);
    if (voto) voto.elegiveis = JSON.parse(voto.elegiveis_json);
    return voto ?? null;
}

function obterVotacaoAberta(proposicaoId) {
    const voto = db.prepare(`
        SELECT id FROM legislativo_votacoes
         WHERE proposicao_id = ? AND estado = 'ABERTA'
         ORDER BY id DESC LIMIT 1
    `).get(proposicaoId);
    return voto ? obterVotacao(voto.id) : null;
}

function registrarVoto(votacaoId, eleitorId, escolha) {
    if (!['SIM', 'NAO', 'BRANCO'].includes(escolha)) {
        throw new RangeError('Escolha de voto inválida.');
    }
    return db.transaction(() => {
        const voto = obterVotacao(votacaoId);
        if (!voto || voto.estado !== 'ABERTA' || Date.now() >= Date.parse(voto.encerra_em)) {
            throw new Error('Esta votação está encerrada ou expirou.');
        }
        if (!voto.elegiveis.includes(eleitorId)) {
            throw new Error('Você não pertence ao eleitorado definido para esta votação.');
        }
        db.prepare(`
            INSERT INTO legislativo_votos (votacao_id, eleitor_id, escolha, registrada_em)
            VALUES (?, ?, ?, ?)
        `).run(votacaoId, eleitorId, escolha, agora());
        registrarAuditoria(
            voto.guild_id, voto.proposicao_id, 'VOTO_REGISTRADO',
            `Voto registrado na votação ${votacaoId}.`, eleitorId
        );
        return { registrado: true };
    }).immediate();
}

function fecharVotacao(votacaoId, resultado, próximaEtapa, atorId) {
    const timestamp = agora();
    return db.transaction(() => {
        const voto = obterVotacao(votacaoId);
        if (!voto || voto.estado !== 'ABERTA') {
            throw new Error('Esta votação já foi encerrada ou não existe.');
        }
        const atualizado = db.prepare(`
            UPDATE legislativo_votacoes
               SET estado = 'ENCERRADA', encerrada_em = ?, resultado_json = ?
             WHERE id = ? AND estado = 'ABERTA'
        `).run(timestamp, JSON.stringify(resultado), votacaoId);
        if (atualizado.changes !== 1) throw new Error('A votação já foi encerrada.');

        const proposicao = obterProposicao(voto.proposicao_id, voto.guild_id);
        const etapaFinal = resultado.etapaFinal ?? próximaEtapa;
        const vetoTotalMantido = resultado.vetoFinalizado &&
            resultado.vetoMantido &&
            proposicao.veto_json &&
            JSON.parse(proposicao.veto_json).tipo === 'TOTAL';
        const estadoFinal = vetoTotalMantido
            ? 'REJEITADA'
            : etapaFinal === 'REJEITADA'
            ? 'REJEITADA'
            : ['PROMULGADA', 'CONDENADA'].includes(etapaFinal)
                ? 'CONCLUIDA'
                : null;
        const detalhe = JSON.stringify({
            votação: votacaoId,
            ...resultado
        });
        const updated = db.prepare(`
            UPDATE legislativo_proposicoes
               SET etapa = ?, status = COALESCE(?, status), resultado = ?,
                   texto_vigente = COALESCE(?, texto_vigente),
                   revisao_pendente = 0, atualizada_em = ?
             WHERE id = ? AND etapa = ? AND status = 'EM_TRAMITACAO'
        `).run(
            etapaFinal,
            estadoFinal,
            detalhe,
            resultado.textoVigente ?? null,
            timestamp,
            proposicao.id,
            voto.etapa
        );
        if (updated.changes !== 1) throw new Error('A etapa da proposição mudou durante a apuração.');
        db.prepare(`
            INSERT INTO legislativo_tramitacao
                (proposicao_id, etapa, evento, detalhe, ator_id, criada_em)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            proposicao.id,
            etapaFinal,
            resultado.vetoFinalizado
                ? resultado.vetoMantido ? 'VETO_MANTIDO' : 'VETO_REJEITADO'
                : resultado.vetoEmAnalise ? 'VETO_APRECIADO'
                : resultado.aprovado ? 'ETAPA_APROVADA' : 'ETAPA_REJEITADA',
            detalhe,
            atorId,
            timestamp
        );
        registrarAuditoria(
            voto.guild_id, proposicao.id, 'VOTACAO_ENCERRADA', detalhe, atorId
        );
        if (
            proposicao.tipo === 'IMPEACHMENT' &&
            etapaFinal === 'CONDENADA' &&
            proposicao.denunciado_id
        ) {
            const inicio = new Date(timestamp);
            const fim = new Date(inicio);
            fim.setUTCFullYear(fim.getUTCFullYear() + 8);
            db.prepare(`
                INSERT OR IGNORE INTO legislativo_inabilitacoes (
                    guild_id, discord_id, proposicao_id, inicio_em, fim_em
                ) VALUES (?, ?, ?, ?, ?)
            `).run(
                proposicao.guild_id,
                proposicao.denunciado_id,
                proposicao.id,
                inicio.toISOString(),
                fim.toISOString()
            );
            registrarAuditoria(
                proposicao.guild_id,
                proposicao.id,
                'INABILITACAO_REGISTRADA',
                `Inabilitação para função pública até ${fim.toISOString()}.`,
                atorId
            );
        }
        return {
            proposicao: obterProposicao(proposicao.id, voto.guild_id),
            voto
        };
    }).immediate();
}

function obterVotos(votacaoId) {
    return db.prepare(`
        SELECT escolha, COUNT(*) AS quantidade
          FROM legislativo_votos WHERE votacao_id = ? GROUP BY escolha
    `).all(votacaoId);
}

function obterVeto(proposicaoId) {
    const proposicao = db.prepare(
        'SELECT veto_json FROM legislativo_proposicoes WHERE id = ?'
    ).get(proposicaoId);
    return proposicao?.veto_json ? JSON.parse(proposicao.veto_json) : null;
}

function obterResultadoVotacao(proposicaoId, etapa) {
    const votação = db.prepare(`
        SELECT resultado_json FROM legislativo_votacoes
         WHERE proposicao_id = ? AND etapa = ? AND estado = 'ENCERRADA'
    `).get(proposicaoId, etapa);
    return votação?.resultado_json ? JSON.parse(votação.resultado_json) : null;
}

function listarVotacoesExpiradas(timestamp = agora()) {
    return db.prepare(`
        SELECT id FROM legislativo_votacoes
         WHERE estado = 'ABERTA' AND encerra_em <= ? ORDER BY encerra_em
    `).all(timestamp).map(({ id }) => obterVotacao(id));
}

function listarAuditoria(proposicaoId) {
    return db.prepare(`
        SELECT * FROM legislativo_auditoria
         WHERE proposicao_id = ? ORDER BY id
    `).all(proposicaoId);
}

function definirNumeroLei(proposicaoId, numero) {
    db.prepare(`
        UPDATE legislativo_proposicoes
           SET lei_numero = COALESCE(lei_numero, ?)
         WHERE id = ? AND status = 'CONCLUIDA' AND etapa = 'PROMULGADA'
    `).run(numero, proposicaoId);
    return db.prepare(
        'SELECT lei_numero FROM legislativo_proposicoes WHERE id = ?'
    ).get(proposicaoId)?.lei_numero ?? null;
}

function obterInabilitacaoAtiva(guildId, discordId, timestamp = agora()) {
    return db.prepare(`
        SELECT * FROM legislativo_inabilitacoes
         WHERE guild_id = ? AND discord_id = ? AND fim_em > ?
         ORDER BY fim_em DESC LIMIT 1
    `).get(guildId, discordId, timestamp) ?? null;
}

function obterInabilitacao(proposicaoId) {
    return db.prepare(`
        SELECT * FROM legislativo_inabilitacoes WHERE proposicao_id = ?
    `).get(proposicaoId) ?? null;
}

function obterInabilitacaoPendente(proposicaoId) {
    return db.prepare(`
        SELECT * FROM legislativo_inabilitacoes
         WHERE proposicao_id = ? AND cargo_removido = 0
    `).get(proposicaoId) ?? null;
}

function listarInabilitacoesPendentes() {
    return db.prepare(`
        SELECT i.*, p.denunciado, p.titulo
          FROM legislativo_inabilitacoes i
          JOIN legislativo_proposicoes p ON p.id = i.proposicao_id
         WHERE i.cargo_removido = 0 ORDER BY i.id
    `).all();
}

function marcarCargoRemovido(proposicaoId) {
    return db.prepare(`
        UPDATE legislativo_inabilitacoes SET cargo_removido = 1
         WHERE proposicao_id = ? AND cargo_removido = 0
    `).run(proposicaoId).changes === 1;
}

function marcarPublicacao(proposicaoId, estado, mensagemId = null) {
    if (!['ENVIANDO', 'PUBLICADA', 'FALHOU'].includes(estado)) {
        throw new RangeError('Estado de publicação inválido.');
    }
    if (estado === 'ENVIANDO') {
        return db.prepare(`
            UPDATE legislativo_proposicoes SET publicacao_status = ?
             WHERE id = ? AND status = 'CONCLUIDA'
               AND publicacao_status IN ('PENDENTE', 'FALHOU', 'ENVIANDO')
        `).run(estado, proposicaoId).changes === 1;
    }
    return db.prepare(`
        UPDATE legislativo_proposicoes
           SET publicacao_status = ?, publicacao_message_id = COALESCE(?, publicacao_message_id)
         WHERE id = ? AND publicacao_status = 'ENVIANDO'
    `).run(estado, mensagemId, proposicaoId).changes === 1;
}

function listarPublicacoesPendentes() {
    return db.prepare(`
        SELECT * FROM legislativo_proposicoes
         WHERE status = 'CONCLUIDA' AND tipo IN ('PEC', 'PL', 'PLP')
           AND publicacao_status IN ('PENDENTE', 'FALHOU', 'ENVIANDO')
         ORDER BY id
    `).all();
}

function fechar() {
    db.close();
}

module.exports = {
    obterConfiguracao,
    configurar,
    criarProposicao,
    obterProposicao,
    registrarApoio,
    contarApoios,
    listarHistorico,
    registrarEvento,
    revisarTexto,
    registrarVeto,
    criarVotacao,
    obterVotacao,
    obterVotacaoAberta,
    registrarVoto,
    fecharVotacao,
    obterVotos,
    obterVeto,
    obterResultadoVotacao,
    listarVotacoesExpiradas,
    listarAuditoria,
    definirNumeroLei,
    obterInabilitacaoAtiva,
    obterInabilitacao,
    obterInabilitacaoPendente,
    listarInabilitacoesPendentes,
    marcarCargoRemovido,
    marcarPublicacao,
    listarPublicacoesPendentes,
    fechar
};
