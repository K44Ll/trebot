'use strict';

const database = require('../../database/legislativo');
const quorum = require('./quorum');
const fluxo = require('./fluxo');
const { PermissionFlagsBits } = require('discord.js');

const ID_CANAL_LEIS = '1498064047491252495';
const ID_CANAL_POLITICO = '1503209895456014356';

function exigeServidor(interaction) {
    if (!interaction.guildId) throw new Error('Use este comando dentro do servidor.');
}

function éAdministrador(interaction) {
    return Boolean(
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    );
}

function valorDeQuorum(regra, total) {
    if (regra === 'maioria_simples') return `maioria simples; presença mínima de ${quorum.maioriaAbsoluta(total)}`;
    if (regra === 'maioria_absoluta') return `${quorum.maioriaAbsoluta(total)} votos SIM`;
    if (regra === 'dois_tercos') return `${quorum.doisTerços(total)} votos SIM`;
    if (regra === 'tres_quintos') return `${quorum.trêsQuintos(total)} votos SIM`;
    throw new RangeError('Regra de quórum desconhecida.');
}

function validarComposicaoMembros(membros, total) {
    if (membros.length > total) {
        throw new Error(
            `O cargo parlamentar tem ${membros.length} membros, acima da composição configurada de ${total}.`
        );
    }
    if (membros.length === 0) {
        throw new Error('Não há parlamentares ativos com o cargo configurado para receber esta votação.');
    }
    return true;
}

async function buscarMembro(guild, userId) {
    try {
        return await guild.members.fetch(userId);
    } catch (error) {
        if (error.code === 10007) return null;
        throw new Error(`Falha ao verificar membro do servidor: ${error.message}`);
    }
}

async function obterMembrosDaCasa(guild, config, casa) {
    const roleId = casa === 'CAMARA'
        ? config.deputados_role_id
        : config.senadores_role_id;
    const total = casa === 'CAMARA' ? config.camara_total : config.senado_total;
    if (!roleId) {
        throw new Error(
            `Configure o cargo de ${casa === 'CAMARA' ? 'deputados' : 'senadores'} com /configleicomplementar cargos.`
        );
    }

    let membros;
    try {
        await guild.members.fetch();
        const cargo = await guild.roles.fetch(roleId);
        if (!cargo) throw new Error('O cargo parlamentar configurado não existe.');
        membros = [...cargo.members.values()].filter(member => !member.user.bot);
    } catch (error) {
        throw new Error(
            `Não foi possível consultar a composição parlamentar (${error.message}). Ative o intent privilegiado Server Members Intent e tente novamente.`
        );
    }

    validarComposicaoMembros(membros, total);
    return { roleId, total, membros };
}

async function validarEleitor(votacao, userId, client) {
    if (!votacao.elegiveis.includes(userId)) {
        throw new Error('Você não fazia parte da composição desta votação.');
    }
    const guild = await client.guilds.fetch(votacao.guild_id);
    const member = await buscarMembro(guild, userId);
    const config = database.obterConfiguracao(votacao.guild_id);
    const roleId = votacao.cargo_role_id || (votacao.casa === 'CAMARA'
        ? config.deputados_role_id
        : config.senadores_role_id);
    if (!member || !roleId || !member.roles.cache.has(roleId)) {
        throw new Error('Seu mandato/cargo parlamentar não está ativo nesta Casa.');
    }
}

async function abrirVotacao(interaction, client, proposicao) {
    exigeServidor(interaction);
    if (!éAdministrador(interaction)) {
        throw new Error('Somente administradores autorizados podem abrir a votação.');
    }
    if (proposicao.status !== 'EM_TRAMITACAO') {
        throw new Error('A proposição não está em tramitação.');
    }
    if (database.obterVotacaoAberta(proposicao.id)) {
        throw new Error('Já existe uma votação aberta para esta proposição.');
    }

    const etapa = fluxo.etapaDeVotacao(proposicao);
    if (!etapa) throw new Error(`A etapa ${proposicao.etapa} não admite votação.`);
    const config = database.obterConfiguracao(interaction.guildId);
    const { roleId, total, membros } = await obterMembrosDaCasa(
        interaction.guild, config, etapa[0]
    );
    const quórumPresença = quorum.maioriaAbsoluta(total);
    const votação = database.criarVotacao({
        proposicao,
        casa: etapa[0],
        cargoRoleId: roleId,
        regra: etapa[1],
        totalMembros: total,
        quórumPresença,
        elegiveis: membros.map(member => member.id),
        iniciadaPor: interaction.user.id,
        prazoHoras: config.duracao_votacao_horas
    });

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const componentes = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`leg:vote:${votação.id}:SIM`)
                .setLabel('SIM')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`leg:vote:${votação.id}:NAO`)
                .setLabel('NÃO')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`leg:vote:${votação.id}:BRANCO`)
                .setLabel('BRANCO')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
    const conteúdo = [
        `Votação legislativa #${proposiçãoId(proposicao)} — ${proposicao.tipo}: **${proposicao.titulo}**`,
        `Etapa: ${proposicao.etapa} · Casa: ${etapa[0]}`,
        `Quórum: ${valorDeQuorum(etapa[1], total)} · Presença mínima: ${quórumPresença}/${total}`,
        `Prazo: <t:${Math.floor(Date.parse(votação.encerra_em) / 1000)}:F>`,
        `Resumo: ${proposicao.ementa.slice(0, 900)}`,
        'Seu voto é individual e não pode ser alterado.'
    ].join('\n');

    const envios = await Promise.allSettled(
        membros.map(member =>
            member.send({
                content: conteúdo,
                components: componentes,
                allowedMentions: { parse: [] }
            })
        )
    );
    const falhas = envios.filter(resultado => resultado.status === 'rejected').length;
    database.registrarAuditoria(
        interaction.guildId,
        proposicao.id,
        'DMS_VOTACAO',
        `Mensagens entregues: ${membros.length - falhas}/${membros.length}. Falhas consultam a cédula privada com /proposta votar.`,
        interaction.user.id
    );
    for (const [index, resultado] of envios.entries()) {
        if (resultado.status === 'rejected') {
            database.registrarAuditoria(
                interaction.guildId,
                proposicao.id,
                'FALHA_DM_VOTACAO',
                `Votação ${votação.id}; eleitor ${membros[index].id}; use /proposta votar para acessar a cédula efêmera.`,
                'sistema'
            );
        }
    }
    return {
        votação,
        entregues: membros.length - falhas,
        falhas,
        casa: etapa[0],
        regra: etapa[1],
        total,
        quórumPresença
    };
}

function proposiçãoId(proposicao) {
    return String(proposicao.id).padStart(4, '0');
}

async function admitir(interaction, proposicao, casa, client) {
    if (!éAdministrador(interaction)) {
        throw new Error('Somente administradores autorizados podem decidir a admissibilidade.');
    }
    if (proposicao.status !== 'EM_TRAMITACAO' || proposicao.etapa !== 'ADMISSIBILIDADE') {
        throw new Error('A proposição não aguarda decisão de admissibilidade.');
    }
    if (proposicao.tipo === 'PEC') {
        const config = database.obterConfiguracao(interaction.guildId);
        if (config.intervencao_federal || config.estado_defesa || config.estado_sitio) {
            throw new Error('A PEC não pode tramitar durante intervenção federal, estado de defesa ou estado de sítio.');
        }
        const guild = await client.guilds.fetch(interaction.guildId);
        const autor = await buscarMembro(guild, proposicao.denunciante_id);
        const iniciativaPresidencial = Boolean(
            autor && config.presidente_role_id &&
            autor.roles.cache.has(config.presidente_role_id)
        );
        const apoiamentosCamara = database.contarApoios(proposicao.id, 'CAMARA');
        const apoiamentosSenado = database.contarApoios(proposicao.id, 'SENADO');
        const iniciativaParlamentar =
            apoiamentosCamara >= Math.ceil(config.camara_total / 3) ||
            apoiamentosSenado >= Math.ceil(config.senado_total / 3);
        if (!iniciativaPresidencial && !iniciativaParlamentar) {
            throw new Error(
                `A sugestão ainda não cumpre a iniciativa formal de PEC: exige apoio de 1/3 da Câmara (${Math.ceil(config.camara_total / 3)}) ou do Senado (${Math.ceil(config.senado_total / 3)}), na composição configurada, ou autoria presidencial.`
            );
        }
        return database.registrarEvento(
            proposicao,
            'ADMISSIBILIDADE_APROVADA',
            'PEC admitida para análise e votação; os limites materiais do art. 60 devem ser verificados pela autoridade revisora.',
            interaction.user.id,
            'CAMARA_TURNO_1'
        );
    }
    if (proposicao.tipo === 'IMPEACHMENT') {
        if (!/president[ae] da rep[uú]blica/i.test(proposicao.cargo_denunciado ?? '')) {
            throw new Error(
                'Este servidor ainda não configurou o rito e as autoridades competentes para esse cargo; a denúncia permanece em admissibilidade.'
            );
        }
        const config = database.obterConfiguracao(interaction.guildId);
        if (!config.presidente_role_id || !proposicao.denunciado_id) {
            throw new Error('Configure o cargo presidencial e associe a denúncia à conta Discord da autoridade.');
        }
        const guild = await client.guilds.fetch(interaction.guildId);
        const autoridade = await buscarMembro(guild, proposicao.denunciado_id);
        if (!autoridade?.roles.cache.has(config.presidente_role_id)) {
            throw new Error('A conta denunciada não ocupa atualmente o cargo de Presidente configurado.');
        }
        return database.registrarEvento(
            proposicao,
            'DENUNCIA_ADMITIDA',
            'Admissibilidade registrada; a autorização da Câmara não equivale a condenação.',
            interaction.user.id,
            'CAMARA_AUTORIZACAO'
        );
    }
    if (!['CAMARA', 'SENADO'].includes(casa)) {
        throw new Error('Escolha a Casa iniciadora (Câmara ou Senado) para PL/PLP.');
    }
    const config = database.obterConfiguracao(interaction.guildId);
    const guild = await client.guilds.fetch(interaction.guildId);
    const autor = await buscarMembro(guild, proposicao.denunciante_id);
    const iniciativaParlamentar = Boolean(
        autor && (
            (config.deputados_role_id && autor.roles.cache.has(config.deputados_role_id)) ||
            (config.senadores_role_id && autor.roles.cache.has(config.senadores_role_id)) ||
            (config.presidente_role_id && autor.roles.cache.has(config.presidente_role_id))
        )
    );
    const apoiamentosPopulares = database.contarApoios(proposicao.id, 'POPULAR');
    if (
        !iniciativaParlamentar &&
        apoiamentosPopulares < config.apoios_populares_minimos
    ) {
        throw new Error(
            `A sugestão cidadã ainda não atingiu o mínimo configurado de apoiamentos populares (${apoiamentosPopulares}/${config.apoios_populares_minimos}). O padrão exige configuração explícita do servidor; essa contagem não representa por si só todos os requisitos federais de iniciativa popular.`
        );
    }
    return database.registrarEvento(
        proposicao,
        'ADMISSIBILIDADE_APROVADA',
        `Proposição admitida; Casa iniciadora: ${casa}.`,
        interaction.user.id,
        `${casa}_TURNO_1`,
        null,
        casa
    );
}

function rejeitar(interaction, proposicao, justificativa) {
    if (!éAdministrador(interaction)) {
        throw new Error('Somente administradores autorizados podem encerrar a admissibilidade.');
    }
    if (proposicao.status !== 'EM_TRAMITACAO' || proposicao.etapa !== 'ADMISSIBILIDADE') {
        throw new Error('A proposição não aguarda decisão de admissibilidade.');
    }
    return database.registrarEvento(
        proposicao,
        'ADMISSIBILIDADE_REJEITADA',
        justificativa,
        interaction.user.id,
        'REJEITADA',
        'REJEITADA'
    );
}

function separarDispositivosVeto(texto, dispositivos) {
    if (typeof dispositivos !== 'string' || !dispositivos.trim()) {
        throw new Error('Informe o texto integral do(s) dispositivo(s) vetado(s), copiado(s) da proposta e separado(s) por uma linha --- .');
    }
    const trechos = dispositivos
        .split(/\r?\n---\r?\n/)
        .map(trecho => trecho.trim())
        .filter(Boolean);
    if (!trechos.length || trechos.length > 20) {
        throw new Error('Informe entre 1 e 20 dispositivos para veto parcial.');
    }
    const identificadorLegal = /^(?:Art(?:igo)?\.?\s+\d+|§\s*(?:\d+|único)|(?:inciso\s+)?(?:[IVXLCDM]+|\d+)\s*[-–—.)]|(?:alínea\s+)?[a-z]\s*[).])/iu;
    const normalizar = valor => valor.replace(/\s+/g, ' ').trim();
    const vistos = new Set();
    for (const trecho of trechos) {
        if (!identificadorLegal.test(trecho)) {
            throw new Error('Cada trecho vetado deve começar por um identificador integral (artigo, parágrafo, inciso ou alínea).');
        }
        if (!texto.includes(trecho)) {
            throw new Error('Cada trecho vetado deve ser copiado integralmente, sem alterações, do texto da proposta.');
        }
        if (texto.indexOf(trecho) !== texto.lastIndexOf(trecho)) {
            throw new Error('O trecho vetado aparece mais de uma vez; informe uma redação única para evitar remover o dispositivo errado.');
        }
        const chave = normalizar(trecho);
        if (vistos.has(chave)) throw new Error('Há dispositivos repetidos no veto parcial.');
        vistos.add(chave);
    }
    return trechos;
}

function removerDispositivosVetados(texto, dispositivos) {
    return dispositivos.reduce(
        (vigente, dispositivo) => vigente.replace(dispositivo, ''),
        texto
    );
}

async function decidirExecutivo(
    interaction, proposicao, decisão, justificativa, client, dispositivos = ''
) {
    exigeServidor(interaction);
    if (!['SANCIONAR', 'VETAR', 'VETAR_PARCIAL'].includes(decisão)) {
        throw new Error('Decisão executiva inválida.');
    }
    const config = database.obterConfiguracao(interaction.guildId);
    const autorizado = éAdministrador(interaction) ||
        (config.presidente_role_id &&
            interaction.member?.roles?.cache?.has(config.presidente_role_id));
    if (!autorizado) {
        throw new Error('A decisão cabe ao Presidente configurado; administradores têm override auditado.');
    }
    if (
        !['PL', 'PLP'].includes(proposicao.tipo) ||
        proposicao.etapa !== 'SANCAO' ||
        proposicao.status !== 'EM_TRAMITACAO'
    ) {
        throw new Error('Esta proposição não aguarda sanção ou veto presidencial.');
    }
    const promulgada = decisão === 'SANCIONAR';
    const veto = decisão === 'VETAR_PARCIAL'
        ? dadosVetoParcial(proposicao, dispositivos, justificativa)
        : { tipo: 'TOTAL', justificativa };
    const atualizada = promulgada
        ? database.registrarEvento(
            proposicao,
            'SANCIONADA',
            justificativa,
            interaction.user.id,
            'PROMULGADA',
            'CONCLUIDA'
        )
        : database.registrarVeto(proposicao, veto, interaction.user.id);
    database.registrarAuditoria(
        proposicao.guild_id,
        proposicao.id,
        'DECISAO_EXECUTIVA',
        JSON.stringify({ decisão, justificativa, dispositivos: veto.dispositivos }),
        interaction.user.id
    );
    if (promulgada) await publicarConclusao(client, atualizada);
    else await anunciar(
        client,
        atualizada,
        `${veto.tipo === 'TOTAL' ? 'Veto presidencial total' : 'Veto presidencial parcial'} registrado para a proposição #${proposiçãoId(atualizada)}.`
    );
    return atualizada;
}

function dadosVetoParcial(proposicao, dispositivos, justificativa) {
    return {
        tipo: 'PARCIAL',
        justificativa,
        dispositivos: separarDispositivosVeto(proposicao.texto, dispositivos)
    };
}

function formatarApuração(resultado, votação) {
    const limiar = resultado.votosFavoráveisNecessários === null
        ? 'maioria simples dos votos válidos'
        : `${resultado.votosFavoráveisNecessários} votos SIM`;
    return [
        `Apuração da votação #${votação.id} (${votação.casa}, ${votação.etapa})`,
        `SIM: ${resultado.sim} · NÃO: ${resultado.nao} · BRANCO: ${resultado.branco}`,
        `Ausências: ${resultado.ausências} · Presença: ${resultado.presença}/${votação.total_membros}`,
        `Quórum de presença: ${resultado.quórumPresença} · Aprovação: ${limiar}`,
        `Resultado: ${resultado.aprovado ? 'APROVADA' : 'REJEITADA'}`
    ].join('\n');
}

async function encerrarVotacao(interaction, client, votação) {
    if (!éAdministrador(interaction)) {
        throw new Error('Somente administradores autorizados podem encerrar a votação.');
    }
    return apurarVotacao(votação, interaction.user.id, client);
}

async function apurarVotacao(votação, atorId, client) {
    const votos = Object.fromEntries(
        database.obterVotos(votação.id).map(linha => [linha.escolha, linha.quantidade])
    );
    const apuração = quorum.apurarVotacao({
        sim: votos.SIM ?? 0,
        nao: votos.NAO ?? 0,
        branco: votos.BRANCO ?? 0,
        totalMembros: votação.total_membros,
        regra: votação.regra,
        quórumPresença: votação.quórum_presença
    });
    const proposicao = database.obterProposicao(votação.proposicao_id, votação.guild_id);
    let próxima = fluxo.próximaEtapa(proposicao, apuração.aprovado);
    let resultadoApuração = apuração;
    if (votação.etapa === 'VETO_CAMARA') {
        próxima = 'VETO_SENADO';
        resultadoApuração = { ...apuração, vetoEmAnalise: true };
    } else if (votação.etapa === 'VETO_SENADO') {
        const votoCamara = database.obterResultadoVotacao(
            proposicao.id,
            'VETO_CAMARA'
        );
        const veto = database.obterVeto(proposicao.id);
        if (!votoCamara || !veto) {
            throw new Error('Não foi possível recuperar as duas etapas e a decisão do veto.');
        }
        const vetoRejeitado = Boolean(votoCamara.aprovado && apuração.aprovado);
        const vetoMantido = !vetoRejeitado;
        const etapaFinal = vetoMantido && veto.tipo === 'TOTAL'
            ? 'VETO_MANTIDO'
            : 'PROMULGADA';
        resultadoApuração = {
            ...apuração,
            vetoFinalizado: true,
            vetoMantido,
            etapaFinal,
            textoVigente: vetoMantido && veto.tipo === 'PARCIAL'
                ? removerDispositivosVetados(proposicao.texto, veto.dispositivos)
                : proposicao.texto
        };
        próxima = etapaFinal;
    }
    const resultado = database.fecharVotacao(
        votação.id,
        resultadoApuração,
        próxima,
        atorId
    );
    const mensagem = formatarApuração(resultadoApuração, votação);
    await anunciar(client, resultado.proposicao, mensagem);
    if (
        ['PROMULGADA', 'CONDENADA', 'VETO_MANTIDO'].includes(próxima) ||
        (resultado.proposicao.tipo === 'IMPEACHMENT' && próxima === 'REJEITADA')
    ) {
        await publicarConclusao(client, resultado.proposicao);
    }

    return { ...resultado, apuração, mensagem };
}

async function encerrarVotacoesExpiradas(client) {
    const expiradas = database.listarVotacoesExpiradas();
    for (const votação of expiradas) {
        try {
            await apurarVotacao(votação, 'sistema', client);
        } catch (error) {
            console.error(`[LEGISLATIVO] Falha ao encerrar votação expirada #${votação.id}:`, error);
        }
    }
    return expiradas.length;
}

function sanitizarMencoes(texto) {
    return String(texto).replaceAll('@', '@\u200b');
}

async function anunciar(client, proposicao, conteúdo, final = false) {
    try {
        const guild = await client.guilds.fetch(proposicao.guild_id);
        const canal = await guild.channels.fetch(ID_CANAL_POLITICO);
        if (!canal?.isTextBased()) throw new Error('Canal de anúncios políticos indisponível.');
        const mençãoFinal = final;
        await canal.send({
            content: `${mençãoFinal ? '@everyone\n' : ''}${sanitizarMencoes(conteúdo)}`.slice(0, 1900),
            allowedMentions: { parse: mençãoFinal ? ['everyone'] : [] }
        });
    } catch (error) {
        console.error('[LEGISLATIVO] Falha ao anunciar:', error.message);
        database.registrarAuditoria(
            proposicao.guild_id,
            proposicao.id,
            'FALHA_ANUNCIO',
            error.message,
            'sistema'
        );
    }
}

async function publicarConclusao(client, proposicao) {
    if (proposicao.tipo === 'IMPEACHMENT') {
        let consequência = null;
        if (proposicao.etapa === 'CONDENADA') {
            consequência = await aplicarConsequenciaImpeachment(client, proposicao);
        }
        await anunciar(
            client,
            proposicao,
            proposicao.etapa === 'CONDENADA'
                ? `Julgamento da denúncia #${proposiçãoId(proposicao)} concluído: condenação do(a) ${proposicao.denunciado} pelo Senado, com perda do cargo e inabilitação para função pública até <t:${Math.floor(Date.parse(consequência.fim_em) / 1000)}:F>.${consequência.cargoRemovido ? '' : ' A remoção do cargo Discord requer correção administrativa.'}`
                : `Processo de denúncia #${proposiçãoId(proposicao)} concluído. Resultado: ${proposicao.etapa}.`,
            true
        );
        return;
    }
    if (
        proposicao.etapa !== 'PROMULGADA' ||
        proposicao.status !== 'CONCLUIDA'
    ) return;
    if (!database.marcarPublicacao(proposicao.id, 'ENVIANDO')) return;
    const config = database.obterConfiguracao(proposicao.guild_id);
    const numero = database.definirNumeroLei(
        proposicao.id,
        `${config.sessao_legislativa}/${proposicao.id}`
    );
    try {
        const guild = await client.guilds.fetch(proposicao.guild_id);
        const canal = await guild.channels.fetch(ID_CANAL_LEIS);
        if (!canal?.isTextBased()) throw new Error('Canal de publicação de leis indisponível.');
        const { EmbedBuilder } = require('discord.js');
        const votaçãoResumo = database.listarHistorico(proposicao.id)
            .filter(item => item.evento === 'ETAPA_APROVADA')
            .map(item => {
                try {
                    const resultado = JSON.parse(item.detalhe);
                    return `${item.etapa}: SIM ${resultado.sim}, NÃO ${resultado.nao}, BRANCO ${resultado.branco}`;
                } catch {
                    return `${item.etapa}: aprovada`;
                }
            })
            .join('\n')
            .slice(0, 800);
        const historicoDecisoes = database.listarHistorico(proposicao.id)
            .filter(item => [
                'SANCIONADA',
                'VETO_PRESIDENCIAL',
                'VETO_REJEITADO',
                'VETO_MANTIDO'
            ].includes(item.evento))
            .map(item => {
                if (item.evento === 'SANCIONADA') return 'Sanção presidencial integral.';
                if (item.evento === 'VETO_REJEITADO') return 'Veto rejeitado pelas duas Casas; texto integral promulgado pelo Congresso.';
                if (item.evento === 'VETO_MANTIDO') return 'Veto mantido; dispositivos vetados não integram o texto publicado.';
                try {
                    const veto = JSON.parse(item.detalhe);
                    return `Veto presidencial ${veto.tipo.toLowerCase()}: ${veto.justificativa}`;
                } catch {
                    return 'Veto presidencial registrado.';
                }
            })
            .join('\n');
        const tipo = proposicao.tipo === 'PEC'
            ? 'Emenda constitucional promulgada'
            : `${proposicao.tipo} convertido em lei`;
        const embed = new EmbedBuilder()
            .setColor(0x1f7a45)
            .setTitle(`${tipo} nº ${numero}`)
            .setDescription(proposicao.ementa.slice(0, 600))
            .addFields(
                { name: 'Título', value: proposicao.titulo.slice(0, 1024) },
                { name: 'Texto integral vigente', value: (proposicao.texto_vigente ?? proposicao.texto).slice(0, 4000) },
                { name: 'Autor', value: `<@${proposicao.autor_id ?? proposicao.denunciante_id}>` },
                { name: 'Histórico resumido de votação', value: votaçãoResumo.slice(0, 400) || 'Aprovação registrada; consulte a tramitação para o detalhamento.' },
                {
                    name: 'Aprovação e publicação',
                    value: `${proposicao.atualizada_em}\n${historicoDecisoes || 'Promulgação após aprovação nos turnos constitucionais.'}`
                }
            );
        const mensagem = await canal.send({
            embeds: [embed],
            allowedMentions: { parse: [] }
        });
        database.marcarPublicacao(proposicao.id, 'PUBLICADA', mensagem.id);
        await anunciar(
            client,
            proposicao,
            `${tipo} nº ${numero} promulgado: **${proposicao.titulo}**.`,
            true
        );
    } catch (error) {
        database.marcarPublicacao(proposicao.id, 'FALHOU');
        database.registrarAuditoria(
            proposicao.guild_id,
            proposicao.id,
            'FALHA_PUBLICACAO',
            error.message,
            'sistema'
        );
        console.error('[LEGISLATIVO] Falha ao publicar lei:', error);
    }
}

async function aplicarConsequenciaImpeachment(client, proposicao) {
    const inabilitação = database.obterInabilitacao(proposicao.id);
    if (!inabilitação) {
        throw new Error(`Inabilitação não registrada para condenação #${proposicao.id}.`);
    }
    if (inabilitação.cargo_removido) {
        return { ...inabilitação, cargoRemovido: true };
    }

    const config = database.obterConfiguracao(proposicao.guild_id);
    try {
        if (!config.presidente_role_id) {
            throw new Error('Cargo presidencial não está configurado.');
        }
        const guild = await client.guilds.fetch(proposicao.guild_id);
        const autoridade = await buscarMembro(guild, proposicao.denunciado_id);
        if (autoridade?.roles.cache.has(config.presidente_role_id)) {
            await autoridade.roles.remove(
                config.presidente_role_id,
                `Perda do cargo após condenação no processo #${proposicao.id}`
            );
        }
        database.marcarCargoRemovido(proposicao.id);
        database.registrarAuditoria(
            proposicao.guild_id,
            proposicao.id,
            'CARGO_PRESIDENCIAL_REMOVIDO',
            autoridade ? 'Cargo presidencial removido ou já não estava atribuído.' : 'Autoridade não está mais no servidor.',
            'sistema'
        );
        return { ...inabilitação, cargoRemovido: true };
    } catch (error) {
        database.registrarAuditoria(
            proposicao.guild_id,
            proposicao.id,
            'FALHA_REMOCAO_CARGO',
            error.message,
            'sistema'
        );
        console.error('[LEGISLATIVO] Falha ao remover cargo após impeachment:', error);
        return { ...inabilitação, cargoRemovido: false };
    }
}

async function recuperarPublicacoes(client) {
    for (const proposicao of database.listarPublicacoesPendentes()) {
        await publicarConclusao(client, proposicao);
    }
}

async function recuperarConsequencias(client) {
    for (const inabilitação of database.listarInabilitacoesPendentes()) {
        const proposicao = database.obterProposicao(
            inabilitação.proposicao_id,
            inabilitação.guild_id
        );
        if (proposicao) {
            await aplicarConsequenciaImpeachment(client, proposicao);
        }
    }
}

module.exports = {
    exigeServidor,
    éAdministrador,
    valorDeQuorum,
    validarComposicaoMembros,
    buscarMembro,
    abrirVotacao,
    validarEleitor,
    admitir,
    rejeitar,
    decidirExecutivo,
    obterMembrosDaCasa,
    encerrarVotacao,
    encerrarVotacoesExpiradas,
    sanitizarMencoes,
    separarDispositivosVeto,
    removerDispositivosVetados,
    anunciar,
    publicarConclusao,
    recuperarPublicacoes,
    recuperarConsequencias
};
