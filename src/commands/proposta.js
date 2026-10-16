'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const db = require('../database/legislativo');
const sistema = require('../services/legislativo/sistema');

const TIPO_CHOICES = [
    { name: 'PEC — Emenda à Constituição', value: 'PEC' },
    { name: 'PL — Lei ordinária', value: 'PL' },
    { name: 'PLP — Lei complementar', value: 'PLP' },
    { name: 'Denúncia por crime de responsabilidade', value: 'IMPEACHMENT' }
];

const responder = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

function input(id, label, maxLength, required = true, style = TextInputStyle.Paragraph) {
    return new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(maxLength);
}

function validarTexto(value, label, maxLength, required = true) {
    const texto = value.trim();
    if (required && !texto) throw new Error(`${label} não pode ficar vazio.`);
    if (texto.length > maxLength) throw new Error(`${label} excede ${maxLength} caracteres.`);
    return texto;
}

async function mostrarCédula(interaction, client, proposicaoId) {
    const proposicao = db.obterProposicao(proposicaoId, interaction.guildId);
    if (!proposicao) throw new Error('Proposição não encontrada neste servidor.');
    const votação = db.obterVotacaoAberta(proposicao.id);
    if (!votação) throw new Error('Não há votação aberta para esta proposição.');
    await sistema.validarEleitor(votação, interaction.user.id, client);
    const componentes = new ActionRowBuilder().addComponents(
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
    );
    return interaction.reply({
        content: [
            `Votação #${votação.id} — ${proposicao.tipo}: **${proposicao.titulo}**`,
            `Etapa: ${votação.etapa} · Casa: ${votação.casa}`,
            `Quórum: ${sistema.valorDeQuorum(votação.regra, votação.total_membros)}`,
            `Presença mínima: ${votação.quórum_presença}/${votação.total_membros}`,
            `Prazo: <t:${Math.floor(Date.parse(votação.encerra_em) / 1000)}:F>`
        ].join('\n'),
        components: [componentes],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
    });
}

function criarEmbeds(proposicao) {
    const config = db.obterConfiguracao(proposicao.guild_id);
    const histórico = db.listarHistorico(proposicao.id)
        .slice(-8)
        .map(item => `• ${item.criada_em.slice(0, 16)} — ${item.evento}: ${item.detalhe}`)
        .join('\n')
        .slice(0, 1024);
    const principal = new EmbedBuilder()
        .setColor(proposicao.status === 'CONCLUIDA' ? 0x1f7a45 : 0x2457a7)
        .setTitle(`#${String(proposicao.id).padStart(4, '0')} · ${proposicao.tipo} — ${proposicao.titulo}`.slice(0, 256))
        .setDescription(proposicao.ementa.slice(0, 4000))
        .addFields(
            {
                name: proposicao.tipo === 'IMPEACHMENT' ? 'Denunciante' : 'Autor',
                value: `<@${proposicao.autor_id ?? proposicao.denunciante_id}>`,
                inline: true
            },
            { name: 'Etapa', value: proposicao.etapa, inline: true },
            { name: 'Estado', value: proposicao.status, inline: true },
            { name: 'Texto integral', value: proposicao.texto.slice(0, 4000) || '—' }
        );
    const complementar = new EmbedBuilder()
        .setColor(0x506080)
        .setTitle(`Justificativa e tramitação #${String(proposicao.id).padStart(4, '0')}`)
        .addFields(
            { name: 'Justificativa', value: proposicao.justificativa.slice(0, 1024) || '—' },
            { name: 'Histórico recente', value: histórico || 'Sem movimentações.' }
        );
    if (proposicao.referencias) {
        complementar.addFields({ name: 'Referências/provas', value: proposicao.referencias.slice(0, 1024) });
    }
    if (proposicao.denunciado) {
        complementar.addFields({
            name: 'Autoridade denunciada',
            value: `${proposicao.denunciado} · ${proposicao.cargo_denunciado}`
        });
    }
    if (proposicao.resultado) {
        complementar.addFields({ name: 'Última apuração', value: proposicao.resultado.slice(0, 1024) });
    }
    if (proposicao.etapa === 'ADMISSIBILIDADE') {
        complementar.addFields({
            name: 'Apoiamentos',
            value: [
                `Câmara: ${db.contarApoios(proposicao.id, 'CAMARA')}/${Math.ceil(config.camara_total / 3)} (1/3)`,
                `Senado: ${db.contarApoios(proposicao.id, 'SENADO')}/${Math.ceil(config.senado_total / 3)} (1/3)`,
                `Popular: ${db.contarApoios(proposicao.id, 'POPULAR')}/${config.apoios_populares_minimos}`
            ].join('\n')
        });
    }
    return [principal, complementar];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('proposta')
        .setDescription('Apresenta e acompanha proposições legislativas')
        .addSubcommand(sub =>
            sub
                .setName('criar')
                .setDescription('Apresenta uma proposta ou denúncia para análise')
                .addStringOption(option =>
                    option
                        .setName('modalidade')
                        .setDescription('Tipo de proposição')
                        .setChoices(...TIPO_CHOICES)
                        .setRequired(true)
                )
                .addUserOption(option =>
                    option
                        .setName('autoridade')
                        .setDescription('Obrigatório para denúncia: selecione a conta Discord denunciada')
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('consultar')
                .setDescription('Consulta o texto e o andamento de uma proposição')
                .addIntegerOption(option =>
                    option.setName('numero').setDescription('Número da proposição').setMinValue(1).setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('apoiar')
                .setDescription('Registra apoio autenticado à iniciativa de uma proposição')
                .addIntegerOption(option =>
                    option.setName('numero').setDescription('Número da proposição').setMinValue(1).setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('tipo')
                        .setDescription('Casa parlamentar ou apoio popular')
                        .addChoices(
                            { name: 'Deputado da Câmara', value: 'CAMARA' },
                            { name: 'Senador', value: 'SENADO' },
                            { name: 'Apoio popular', value: 'POPULAR' }
                        )
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('admissibilidade')
                .setDescription('Decide a admissibilidade de uma proposta (administradores)')
                .addIntegerOption(option =>
                    option.setName('numero').setDescription('Número da proposição').setMinValue(1).setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('decisao')
                        .setDescription('Admitir ou rejeitar')
                        .addChoices(
                            { name: 'Admitir', value: 'ADMITIR' },
                            { name: 'Rejeitar', value: 'REJEITAR' }
                        )
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('justificativa').setDescription('Fundamento da decisão').setMaxLength(1000).setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('casa-iniciadora')
                        .setDescription('Necessária para PL e PLP admitidos')
                        .addChoices(
                            { name: 'Câmara dos Deputados', value: 'CAMARA' },
                            { name: 'Senado Federal', value: 'SENADO' }
                        )
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('iniciar-votacao')
                .setDescription('Abre a votação da etapa atual (administradores)')
                .addIntegerOption(option =>
                    option.setName('numero').setDescription('Número da proposição').setMinValue(1).setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('votar')
                .setDescription('Abre sua cédula privada da votação parlamentar')
                .addIntegerOption(option =>
                    option.setName('numero').setDescription('Número da proposição').setMinValue(1).setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('encerrar-votacao')
                .setDescription('Encerra e apura uma votação (administradores)')
                .addIntegerOption(option =>
                    option.setName('numero').setDescription('Número da proposição').setMinValue(1).setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('alterar-texto')
                .setDescription('Registra alterações da Casa revisora antes da votação (administradores)')
                .addIntegerOption(option =>
                    option.setName('numero').setDescription('Número da proposição').setMinValue(1).setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('texto')
                        .setDescription('Redação integral alterada pela Casa revisora')
                        .setMinLength(1)
                        .setMaxLength(4000)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('decisao-presidencial')
                .setDescription('Registra sanção, veto total ou veto parcial de PL/PLP')
                .addIntegerOption(option =>
                    option.setName('numero').setDescription('Número da proposição').setMinValue(1).setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('decisao')
                        .setDescription('Sanção integral, veto total ou veto parcial')
                        .addChoices(
                            { name: 'Sancionar integralmente', value: 'SANCIONAR' },
                            { name: 'Vetar integralmente', value: 'VETAR' },
                            { name: 'Vetar parcialmente', value: 'VETAR_PARCIAL' }
                        )
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('justificativa').setDescription('Fundamento da decisão').setMaxLength(1000).setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('dispositivos')
                        .setDescription('Para veto parcial: texto exato integral de cada dispositivo, separados por uma linha ---')
                        .setMaxLength(4000)
                )
        ),

    async execute(interaction, client) {
        if (!interaction.guildId) return responder(interaction, 'Use este comando dentro do servidor.');
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'criar') {
            const tipo = interaction.options.getString('modalidade', true);
            const autoridade = interaction.options.getUser('autoridade');
            if (tipo === 'IMPEACHMENT' && !autoridade) {
                return responder(
                    interaction,
                    'Para verificar que a autoridade está em exercício, selecione a conta Discord denunciada no campo autoridade.'
                );
            }
            const campos = tipo === 'IMPEACHMENT'
                ? [
                    input('alvo', 'Nome e cargo da autoridade', 100, true, TextInputStyle.Short),
                    input('fatos', 'Descrição detalhada dos fatos', 1500),
                    input('fundamento', 'Possível crime/fundamentação jurídica', 1000),
                    input('justificativa', 'Justificativa da denúncia', 1000),
                    input('provas', 'URLs, documentos e data dos fatos (se conhecida)', 1000, false)
                ]
                : [
                    input('titulo', 'Título oficial', 100, true, TextInputStyle.Short),
                    input('ementa', 'Ementa', 1000),
                    input('texto', 'Texto integral com artigos e dispositivos', 4000),
                    input('justificativa', 'Justificativa', 1000),
                    input('referencias', 'Documentos e fontes (opcional)', 1000, false)
                ];
            const modal = new ModalBuilder()
                .setCustomId(`leg:submit:${tipo}:${autoridade?.id ?? 'none'}`)
                .setTitle(tipo === 'IMPEACHMENT' ? 'Apresentar denúncia' : `Apresentar ${tipo}`)
                .addComponents(
                    ...campos.map(campo => new ActionRowBuilder().addComponents(campo))
                );
            return interaction.showModal(modal);
        }

        if (subcommand === 'consultar') {
            const proposicao = db.obterProposicao(
                interaction.options.getInteger('numero', true),
                interaction.guildId
            );
            if (!proposicao) return responder(interaction, 'Proposição não encontrada.');
            const [principal, complementar] = criarEmbeds(proposicao);
            await interaction.reply({
                embeds: [principal],
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] }
            });
            return interaction.followUp({
                embeds: [complementar],
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] }
            });
        }

        const id = interaction.options.getInteger('numero', true);
        const proposicao = db.obterProposicao(id, interaction.guildId);
        if (!proposicao) return responder(interaction, 'Proposição não encontrada neste servidor.');

        if (subcommand === 'apoiar') {
            const config = db.obterConfiguracao(interaction.guildId);
            const tipoApoio = interaction.options.getString('tipo', true);
            if (tipoApoio === 'CAMARA' || tipoApoio === 'SENADO') {
                const roleId = tipoApoio === 'CAMARA'
                    ? config.deputados_role_id
                    : config.senadores_role_id;
                if (!roleId || !interaction.member?.roles?.cache?.has(roleId)) {
                    return responder(interaction, 'Apoios parlamentares exigem o cargo correspondente atualmente ativo.');
                }
            }
            try {
                db.registrarApoio(proposicao, interaction.user.id, tipoApoio);
            } catch (error) {
                if (
                    error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
                    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
                ) {
                    return responder(interaction, 'Você já registrou um apoiamento nesta proposição.');
                }
                throw error;
            }
            return responder(
                interaction,
                `Apoio ${tipoApoio} registrado. Total nesta categoria: ${db.contarApoios(id, tipoApoio)}.`
            );
        }

        if (subcommand === 'admissibilidade') {
            const decisão = interaction.options.getString('decisao', true);
            const justificativa = validarTexto(
                interaction.options.getString('justificativa', true),
                'Justificativa',
                1000
            );
            const atualizada = decisão === 'ADMITIR'
                ? await sistema.admitir(
                    interaction,
                    proposicao,
                    interaction.options.getString('casa-iniciadora'),
                    client
                )
                : sistema.rejeitar(interaction, proposicao, justificativa);
            if (decisão === 'ADMITIR') {
                db.registrarAuditoria(
                    interaction.guildId, id, 'JUSTIFICATIVA_ADMISSIBILIDADE',
                    justificativa, interaction.user.id
                );
            }
            if (atualizada.tipo === 'IMPEACHMENT' && atualizada.status === 'REJEITADA') {
                await sistema.publicarConclusao(client, atualizada);
            } else {
                await sistema.anunciar(
                    client,
                    atualizada,
                    `Decisão de admissibilidade da proposição #${String(id).padStart(4, '0')}: ${atualizada.etapa}.`
                );
            }
            return responder(interaction, `Decisão registrada. Nova etapa: **${atualizada.etapa}**.`);
        }

        if (subcommand === 'iniciar-votacao') {
            const resultado = await sistema.abrirVotacao(interaction, client, proposicao);
            await sistema.anunciar(
                client,
                proposicao,
                `Votação aberta para ${proposicao.tipo} #${String(id).padStart(4, '0')} — ${proposicao.etapa}.`
            );
            return responder(
                interaction,
                `Votação #${resultado.votação.id} aberta na **${resultado.casa}**. DMs entregues: ${resultado.entregues}/${resultado.total}; falhas: ${resultado.falhas}. Quem não recebeu DM pode usar \`/proposta votar numero:${id}\` para abrir uma cédula efêmera no servidor.`
            );
        }

        if (subcommand === 'votar') {
            return mostrarCédula(interaction, client, id);
        }

        if (subcommand === 'encerrar-votacao') {
            const votação = db.obterVotacaoAberta(id);
            if (!votação) return responder(interaction, 'Não há votação aberta para esta proposição.');
            const resultado = await sistema.encerrarVotacao(interaction, client, votação);
            return responder(interaction, resultado.mensagem);
        }

        if (subcommand === 'alterar-texto') {
            if (!sistema.éAdministrador(interaction)) {
                return responder(interaction, 'Somente administradores autorizados podem registrar alterações da Casa revisora.');
            }
            const texto = validarTexto(
                interaction.options.getString('texto', true),
                'Texto integral alterado',
                4000
            );
            const atualizada = db.revisarTexto(
                proposicao,
                texto,
                interaction.user.id
            );
            await sistema.anunciar(
                client,
                atualizada,
                `Texto de ${atualizada.tipo} #${String(id).padStart(4, '0')} alterado pela Casa revisora; a votação dessa etapa decidirá a redação revisada.`
            );
            return responder(
                interaction,
                `Texto revisado registrado. Se aprovado pela Casa revisora, seguirá à Casa iniciadora (**${atualizada.casa_iniciadora}**) para nova votação antes da sanção.`
            );
        }

        if (subcommand === 'decisao-presidencial') {
            const justificativa = validarTexto(
                interaction.options.getString('justificativa', true),
                'Justificativa',
                1000
            );
            const atualizada = await sistema.decidirExecutivo(
                interaction,
                proposicao,
                interaction.options.getString('decisao', true),
                justificativa,
                client,
                interaction.options.getString('dispositivos') ?? ''
            );
            return responder(interaction, `Decisão presidencial registrada. Nova etapa: **${atualizada.etapa}**.`);
        }
    },

    componentHandlers: {
        'leg:submit:*': async (interaction, client) => {
            const [, , tipo, autoridadeId] = interaction.customId.split(':');
            if (!TIPO_CHOICES.some(choice => choice.value === tipo)) {
                return responder(interaction, 'Modalidade de proposição inválida.');
            }
            const comuns = {
                guildId: interaction.guildId,
                tipo,
                autorId: interaction.user.id,
                autorNome: interaction.user.username,
                denuncianteId: interaction.user.id,
                denuncianteNome: interaction.user.username
            };
            let dados;
            if (tipo === 'IMPEACHMENT') {
                const alvo = validarTexto(interaction.fields.getTextInputValue('alvo'), 'Autoridade', 100);
                const fatos = validarTexto(interaction.fields.getTextInputValue('fatos'), 'Fatos', 1500);
                const fundamento = validarTexto(interaction.fields.getTextInputValue('fundamento'), 'Fundamentação', 1000);
                const justificativa = validarTexto(interaction.fields.getTextInputValue('justificativa'), 'Justificativa', 1000);
                const provas = validarTexto(
                    interaction.fields.getTextInputValue('provas'), 'Provas e data', 1000, false
                );
                dados = {
                    ...comuns,
                    titulo: `Denúncia contra ${alvo}`,
                    ementa: fatos.slice(0, 1000),
                    texto: fatos,
                    justificativa: `${fundamento}\n\n${justificativa}`,
                    referencias: provas,
                    denunciadoId: autoridadeId === 'none' ? null : autoridadeId,
                    denunciado: alvo,
                    cargoDenunciado: alvo
                };
            } else {
                dados = {
                    ...comuns,
                    titulo: validarTexto(interaction.fields.getTextInputValue('titulo'), 'Título', 100),
                    ementa: validarTexto(interaction.fields.getTextInputValue('ementa'), 'Ementa', 1000),
                    texto: validarTexto(interaction.fields.getTextInputValue('texto'), 'Texto integral', 4000),
                    justificativa: validarTexto(interaction.fields.getTextInputValue('justificativa'), 'Justificativa', 1000),
                    referencias: validarTexto(
                        interaction.fields.getTextInputValue('referencias'), 'Referências', 1000, false
                    )
                };
            }

            if (!interaction.guildId) return responder(interaction, 'Use este formulário dentro do servidor.');
            if (tipo === 'IMPEACHMENT' && !dados.denunciadoId) {
                return responder(interaction, 'A conta Discord da autoridade denunciada é obrigatória.');
            }
            try {
                const proposicao = db.criarProposicao(dados);
                await sistema.anunciar(
                    client,
                    proposicao,
                    tipo === 'IMPEACHMENT'
                        ? `Nova denúncia #${String(proposicao.id).padStart(4, '0')} registrada como alegação contra ${proposicao.denunciado}; aguarda análise de admissibilidade.`
                        : `Nova sugestão legislativa ${tipo} #${String(proposicao.id).padStart(4, '0')} apresentada por <@${interaction.user.id}>; aguarda análise de admissibilidade.`
                );
                return responder(
                    interaction,
                    `Registro **#${String(proposicao.id).padStart(4, '0')}** criado para análise de admissibilidade. Uma sugestão individual não equivale, por si só, à iniciativa parlamentar ou popular formal.`
                );
            } catch (error) {
                if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    return responder(interaction, 'Esta proposição é uma duplicação exata de outra já apresentada por você.');
                }
                throw error;
            }
        },
        'leg:vote:*': async (interaction, client) => {
            const [, , rawId, escolha] = interaction.customId.split(':');
            const voteId = Number(rawId);
            if (!Number.isSafeInteger(voteId) || !['SIM', 'NAO', 'BRANCO'].includes(escolha)) {
                return responder(interaction, 'Cédula inválida.');
            }
            const votação = db.obterVotacao(voteId);
            if (!votação) return responder(interaction, 'Votação não encontrada.');
            try {
                await sistema.validarEleitor(votação, interaction.user.id, client);
                db.registrarVoto(voteId, interaction.user.id, escolha);
                return interaction.update({
                    content: `Voto **${escolha}** registrado na votação #${voteId}. O voto não pode ser alterado.`,
                    components: [],
                    allowedMentions: { parse: [] }
                });
            } catch (error) {
                if (/já foi encerrada|expirou|não pertence|não fazia parte|mandato|já foi registrado/i.test(error.message) ||
                    error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
                    error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    return responder(interaction, error.code?.startsWith('SQLITE_CONSTRAINT')
                        ? 'Seu voto já foi registrado.'
                        : error.message);
                }
                throw error;
            }
        }
    }
};
