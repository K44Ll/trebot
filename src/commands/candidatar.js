'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');

const database = require('../database');

const CARGOS = [
    ['presidente', 'Presidente'],
    ['vice-presidente', 'Vice-presidente'],
    ['governador', 'Governador'],
    ['senador', 'Senador'],
    ['deputado-federal', 'Deputado federal']
];

const responder = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

module.exports = {
    data: new SlashCommandBuilder()
        .setName('candidatar')
        .setDescription('Solicita candidatura em uma eleição do servidor')
        .addIntegerOption(option =>
            option
                .setName('eleicao')
                .setDescription('Eleição na qual deseja concorrer')
                .setAutocomplete(true)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('cargo')
                .setDescription('Cargo ao qual deseja concorrer')
                .addChoices(
                    ...CARGOS.map(([value, name]) => ({ name, value }))
                )
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('complemento')
                .setDescription(
                    'Senador: 1 dígito; deputado federal: 4 dígitos; demais cargos não usam complemento'
                )
                .setMinLength(1)
                .setMaxLength(4)
        ),

    async autocomplete(interaction) {
        if (!interaction.guildId) return interaction.respond([]);
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'eleicao') return interaction.respond([]);

        const termo = String(focused.value);
        const eleicoes = database
            .listarEleicoes(interaction.guildId)
            .filter(eleicao => String(eleicao.id).includes(termo))
            .slice(-25)
            .reverse();

        return interaction.respond(
            eleicoes.map(eleicao => ({
                name: `Eleição #${eleicao.id} · n=${eleicao.n}`.slice(0, 100),
                value: eleicao.id
            }))
        );
    },

    async execute(interaction) {
        if (!interaction.guildId) {
            return responder(interaction, 'Use este comando dentro de um servidor.');
        }

        const eleicaoId = interaction.options.getInteger('eleicao', true);
        const cargo = interaction.options.getString('cargo', true);
        const sufixo = interaction.options.getString('complemento') ?? '';

        try {
            const candidatura = database.solicitarCandidatura({
                guildId: interaction.guildId,
                eleicaoId,
                politicoId: interaction.user.id,
                nome: interaction.member?.displayName ?? interaction.user.username,
                cargo,
                sufixo
            });
            const cargoNome =
                CARGOS.find(([value]) => value === cargo)?.[1] ?? cargo;

            return responder(
                interaction,
                [
                    `Solicitação enviada ao fundador de **${candidatura.partido_nome} (${candidatura.partido_sigla})**.`,
                    `Seu número será **${candidatura.numero}** para **${cargoNome}** se for aprovado.`,
                    'O fundador do partido pode analisar o pedido em `/pedidos-candidatura`.'
                ]
                    .join('\n')
            );
        } catch (error) {
            if (
                error.message.includes('eleição não existe') ||
                error.message.includes('precisa estar filiado') ||
                error.message.includes('número') ||
                error.message.includes('complemento') ||
                error.message.includes('candidatura nesta eleição') ||
                error.message.includes('cargo eleitoral válido') ||
                error.message.includes('Partido não encontrado')
            ) {
                return responder(interaction, error.message);
            }
            throw error;
        }
    }
};
