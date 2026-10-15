'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const database = require('../database');

const responder = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

module.exports = {
    data: new SlashCommandBuilder()
        .setName('filiar')
        .setDescription('Solicita filiação a um partido')
        .addStringOption(option =>
            option
                .setName('partido')
                .setDescription('Partido ao qual deseja se filiar')
                .setAutocomplete(true)
                .setRequired(true)
        ),

    async autocomplete(interaction) {
        if (!interaction.guildId) return interaction.respond([]);
        const termo = interaction.options.getFocused().toLocaleLowerCase('pt-BR');
        const partidos = database
            .listarPartidosParaFiliacao(interaction.guildId)
            .filter(partido =>
                `${partido.nome} ${partido.sigla}`
                    .toLocaleLowerCase('pt-BR')
                    .includes(termo)
            )
            .slice(0, 25);

        return interaction.respond(
            partidos.map(partido => ({
                name: `${partido.emoji} ${partido.nome} (${partido.sigla})`.slice(
                    0,
                    100
                ),
                value: String(partido.id)
            }))
        );
    },

    async execute(interaction) {
        if (!interaction.guildId) {
            return responder(interaction, 'Use este comando dentro de um servidor.');
        }

        const partidoId = Number(
            interaction.options.getString('partido', true)
        );
        if (!Number.isSafeInteger(partidoId) || partidoId < 1) {
            return responder(
                interaction,
                'Selecione um partido válido usando as sugestões do comando.'
            );
        }

        try {
            const pedidoId = database.solicitarFiliacao({
                guildId: interaction.guildId,
                partidoId,
                discordId: interaction.user.id,
                nome: interaction.member?.displayName ?? interaction.user.username
            });
            return responder(
                interaction,
                `Solicitação de filiação enviada. O fundador do partido poderá analisá-la em \`/pedidos-filiacao\` (pedido **${pedidoId}**).`
            );
        } catch (error) {
            if (
                error.message.includes('Partido não encontrado') ||
                error.message.includes('já é filiado') ||
                error.message.includes('já tem uma solicitação')
            ) {
                return responder(interaction, error.message);
            }
            throw error;
        }
    }
};
