'use strict';

const { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const db = require('../database/legislativo');
const quorum = require('../services/legislativo/quorum');

const responder = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

function validarAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('configleicomplementar')
        .setDescription('Configura composição, cargos e regras do sistema legislativo')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub
                .setName('ver')
                .setDescription('Consulta composição e quóruns atuais')
        )
        .addSubcommand(sub =>
            sub
                .setName('composicao')
                .setDescription('Define o número de membros de cada Casa')
                .addIntegerOption(option =>
                    option
                        .setName('deputados')
                        .setDescription('Total da Câmara dos Deputados')
                        .setMinValue(1)
                        .setMaxValue(10000)
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option
                        .setName('senadores')
                        .setDescription('Total do Senado Federal')
                        .setMinValue(1)
                        .setMaxValue(10000)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('cargos')
                .setDescription('Associa cargos de Discord às Casas e à Presidência')
                .addRoleOption(option =>
                    option.setName('deputados').setDescription('Cargo de deputado federal').setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('senadores').setDescription('Cargo de senador').setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('presidente').setDescription('Cargo de Presidente da República')
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('estado-constitucional')
                .setDescription('Registra estados que impedem tramitação de PEC')
                .addStringOption(option =>
                    option
                        .setName('sessao')
                        .setDescription('Identificador da sessão legislativa')
                        .setMaxLength(50)
                        .setRequired(true)
                )
                .addBooleanOption(option =>
                    option.setName('intervencao-federal').setDescription('Há intervenção federal?').setRequired(true)
                )
                .addBooleanOption(option =>
                    option.setName('estado-defesa').setDescription('Há estado de defesa?').setRequired(true)
                )
                .addBooleanOption(option =>
                    option.setName('estado-sitio').setDescription('Há estado de sítio?').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('prazo')
                .setDescription('Define o prazo padrão das votações parlamentares')
                .addIntegerOption(option =>
                    option
                        .setName('horas')
                        .setDescription('Duração de 1 a 720 horas')
                        .setMinValue(1)
                        .setMaxValue(720)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('iniciativa-popular')
                .setDescription('Define o mínimo de apoios para uma iniciativa popular simulada')
                .addIntegerOption(option =>
                    option
                        .setName('apoios')
                        .setDescription('Apoiamentos necessários; o padrão conservador é 1.000.000')
                        .setMinValue(1)
                        .setMaxValue(100000000)
                        .setRequired(true)
                )
        ),

    async execute(interaction) {
        if (!interaction.guildId) {
            return responder(interaction, 'Use este comando dentro do servidor.');
        }
        if (!validarAdmin(interaction)) {
            return responder(interaction, 'Você precisa de Gerenciar servidor para alterar a configuração legislativa.');
        }

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'composicao') {
            const config = db.configurar(interaction.guildId, {
                camara_total: interaction.options.getInteger('deputados', true),
                senado_total: interaction.options.getInteger('senadores', true)
            }, interaction.user.id);
            return responder(
                interaction,
                `Composição atualizada: Câmara ${config.camara_total} (maioria absoluta ${quorum.maioriaAbsoluta(config.camara_total)}, 3/5 ${quorum.trêsQuintos(config.camara_total)}, 2/3 ${quorum.doisTerços(config.camara_total)}); Senado ${config.senado_total} (maioria absoluta ${quorum.maioriaAbsoluta(config.senado_total)}, 3/5 ${quorum.trêsQuintos(config.senado_total)}, 2/3 ${quorum.doisTerços(config.senado_total)}).`
            );
        }

        if (subcommand === 'cargos') {
            const deputados = interaction.options.getRole('deputados', true);
            const senadores = interaction.options.getRole('senadores', true);
            if (deputados.id === senadores.id) {
                return responder(interaction, 'Câmara e Senado precisam usar cargos diferentes.');
            }
            const presidente = interaction.options.getRole('presidente');
            const config = db.configurar(interaction.guildId, {
                deputados_role_id: deputados.id,
                senadores_role_id: senadores.id,
                ...(presidente ? { presidente_role_id: presidente.id } : {})
            }, interaction.user.id);
            return responder(
                interaction,
                `Cargos configurados. Câmara: <@&${config.deputados_role_id}>; Senado: <@&${config.senadores_role_id}>; Presidência: ${config.presidente_role_id ? `<@&${config.presidente_role_id}>` : 'não configurada'}.`
            );
        }

        if (subcommand === 'estado-constitucional') {
            const config = db.configurar(interaction.guildId, {
                sessao_legislativa: interaction.options.getString('sessao', true).trim(),
                intervencao_federal: Number(interaction.options.getBoolean('intervencao-federal', true)),
                estado_defesa: Number(interaction.options.getBoolean('estado-defesa', true)),
                estado_sitio: Number(interaction.options.getBoolean('estado-sitio', true))
            }, interaction.user.id);
            return responder(
                interaction,
                `Sessão ${config.sessao_legislativa} registrada. PEC indisponível: ${Boolean(config.intervencao_federal || config.estado_defesa || config.estado_sitio)}.`
            );
        }

        if (subcommand === 'prazo') {
            const config = db.configurar(interaction.guildId, {
                duracao_votacao_horas: interaction.options.getInteger('horas', true)
            }, interaction.user.id);
            return responder(interaction, `Prazo padrão configurado: ${config.duracao_votacao_horas} horas.`);
        }

        if (subcommand === 'iniciativa-popular') {
            const config = db.configurar(interaction.guildId, {
                apoios_populares_minimos: interaction.options.getInteger('apoios', true)
            }, interaction.user.id);
            return responder(
                interaction,
                `Mínimo de apoiamentos populares: ${config.apoios_populares_minimos}. Esta configuração é uma adaptação da simulação; não verifica os requisitos territoriais e eleitorais federais.`
            );
        }

        const config = db.obterConfiguracao(interaction.guildId);
        return responder(
            interaction,
            [
                `Câmara: ${config.camara_total} membros; maioria absoluta ${quorum.maioriaAbsoluta(config.camara_total)}, 3/5 ${quorum.trêsQuintos(config.camara_total)}, 2/3 ${quorum.doisTerços(config.camara_total)}.`,
                `Senado: ${config.senado_total} membros; maioria absoluta ${quorum.maioriaAbsoluta(config.senado_total)}, 3/5 ${quorum.trêsQuintos(config.senado_total)}, 2/3 ${quorum.doisTerços(config.senado_total)}.`,
                `Cargos: Câmara ${config.deputados_role_id ? `<@&${config.deputados_role_id}>` : 'não configurado'}; Senado ${config.senadores_role_id ? `<@&${config.senadores_role_id}>` : 'não configurado'}; Presidente ${config.presidente_role_id ? `<@&${config.presidente_role_id}>` : 'não configurado'}.`,
                `Prazo: ${config.duracao_votacao_horas}h; sessão: ${config.sessao_legislativa}; apoios populares: ${config.apoios_populares_minimos}.`
            ].join('\n'),
        );
    }
};
