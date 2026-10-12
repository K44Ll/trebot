'use strict';

const {
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');

const database = require('../database');

const responder = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configura o sistema eleitoral deste servidor')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('ver')
                .setDescription('Mostra as configurações eleitorais atuais')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('canal-apoio')
                .setDescription('Define onde as propostas de partidos serão publicadas')
                .addChannelOption(option =>
                    option
                        .setName('canal')
                        .setDescription('Canal de texto para propostas e apoios')
                        .addChannelTypes(
                            ChannelType.GuildText,
                            ChannelType.GuildAnnouncement
                        )
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('minimo-apoios')
                .setDescription('Define quantos apoios fundam um partido')
                .addIntegerOption(option =>
                    option
                        .setName('quantidade')
                        .setDescription('Número de pessoas distintas, de 1 a 500')
                        .setMinValue(1)
                        .setMaxValue(500)
                        .setRequired(true)
                )
        ),

    async execute(interaction) {
        if (!interaction.guildId) {
            return responder(
                interaction,
                'Este comando só pode ser usado dentro de um servidor.'
            );
        }

        if (
            !interaction.memberPermissions?.has(
                PermissionFlagsBits.ManageGuild
            )
        ) {
            return responder(
                interaction,
                'Você precisa da permissão **Gerenciar servidor** para alterar a configuração.'
            );
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (subcommand === 'ver') {
            const config = database.obterConfiguracao(guildId);
            const embed = new EmbedBuilder()
                .setColor(0x2457a7)
                .setTitle('Configuração eleitoral')
                .addFields(
                    {
                        name: 'Canal de apoio',
                        value: config.canalApoioId
                            ? `<#${config.canalApoioId}>`
                            : 'Não configurado',
                        inline: true
                    },
                    {
                        name: 'Apoios para fundação',
                        value: String(config.minimoApoios),
                        inline: true
                    }
                );

            return interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral
            });
        }

        if (subcommand === 'canal-apoio') {
            const canal = interaction.options.getChannel('canal');
            if (
                !canal ||
                ![
                    ChannelType.GuildText,
                    ChannelType.GuildAnnouncement
                ].includes(canal.type)
            ) {
                return responder(
                    interaction,
                    'Escolha um canal de texto ou de anúncios deste servidor.'
                );
            }

            database.configurarCanalApoio(guildId, canal.id);
            return responder(
                interaction,
                `Canal de publicação das propostas definido para <#${canal.id}>.`
            );
        }

        if (subcommand === 'minimo-apoios') {
            const quantidade =
                interaction.options.getInteger('quantidade');
            if (
                !Number.isInteger(quantidade) ||
                quantidade < 1 ||
                quantidade > 500
            ) {
                return responder(
                    interaction,
                    'O mínimo de apoios deve ser um número inteiro entre 1 e 500.'
                );
            }

            database.configurarMinimoApoios(guildId, quantidade);
            return responder(
                interaction,
                `A fundação de um partido agora exige **${quantidade}** apoio(s).`
            );
        }

        return responder(interaction, 'Subcomando de configuração desconhecido.');
    }
};
