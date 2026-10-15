'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const database = require('../database');

const ID_DECISAO = 'tb_filiacao_decidir:*';
const PREFIXO_DECISAO = 'tb_filiacao_decidir:';
const LIMITE_PEDIDOS = 10;

const responder = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

async function decidir(interaction) {
    const [, acao, idTexto] = interaction.customId.split(':');
    const pedidoId = Number(idTexto);
    if (
        !interaction.guildId ||
        !Number.isSafeInteger(pedidoId) ||
        pedidoId < 1 ||
        !['aceitar', 'recusar'].includes(acao)
    ) {
        return responder(interaction, 'Este botão não contém um pedido válido.');
    }

    const resultado = database.decidirPedidoFiliacao({
        guildId: interaction.guildId,
        pedidoId,
        donoId: interaction.user.id,
        aceitar: acao === 'aceitar'
    });

    const mensagens = {
        aceito: 'Filiação aceita.',
        recusado: 'Solicitação recusada.',
        nao_autorizado: 'Somente o fundador do partido pode decidir este pedido.',
        indisponivel: 'Este pedido já foi respondido ou não está mais disponível.',
        partido_inativo: 'O partido foi liquidado; este pedido foi cancelado.',
        ja_filiado: 'Pedido cancelado: a pessoa já está filiada a outro partido.'
    };
    const conteudo =
        mensagens[resultado.resultado] ??
        'Não foi possível concluir a decisão.';

    if (
        ['aceito', 'recusado', 'partido_inativo', 'ja_filiado'].includes(
            resultado.resultado
        )
    ) {
        await interaction.update({ content: conteudo, embeds: [], components: [] });
        return;
    }
    return responder(interaction, conteudo);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pedidos-filiacao')
        .setDescription('Analisa os pedidos de filiação dos seus partidos'),

    async execute(interaction) {
        if (!interaction.guildId) {
            return responder(interaction, 'Use este comando dentro de um servidor.');
        }

        const pedidos = database.listarPedidosFiliacaoPorDono(
            interaction.guildId,
            interaction.user.id
        );
        if (!pedidos.length) {
            return responder(interaction, 'Você não tem pedidos de filiação pendentes.');
        }

        const exibidos = pedidos.slice(0, LIMITE_PEDIDOS);
        const embed = new EmbedBuilder()
            .setColor(0x2457a7)
            .setTitle('Pedidos de filiação pendentes')
            .setDescription(
                exibidos
                    .map(
                        pedido =>
                            `**${pedido.nome}** (<@${pedido.discord_id}>)\n` +
                            `${pedido.partido_emoji} ${pedido.partido_nome} (${pedido.partido_sigla}) · pedido #${pedido.id}`
                    )
                    .join('\n\n')
            );

        const rows = [];
        for (let index = 0; index < exibidos.length; index += 2) {
            const row = new ActionRowBuilder();
            for (const pedido of exibidos.slice(index, index + 2)) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`${PREFIXO_DECISAO}aceitar:${pedido.id}`)
                        .setLabel(`Aceitar #${pedido.id}`)
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`${PREFIXO_DECISAO}recusar:${pedido.id}`)
                        .setLabel(`Recusar #${pedido.id}`)
                        .setStyle(ButtonStyle.Danger)
                );
            }
            rows.push(row);
        }

        const aviso =
            pedidos.length > exibidos.length
                ? `Mostrando ${exibidos.length} de ${pedidos.length} pedidos; execute o comando novamente para ver os próximos.`
                : 'Os pedidos são privados e só podem ser decididos pelo fundador de cada partido.';

        return interaction.reply({
            content: aviso,
            embeds: [embed],
            components: rows,
            flags: MessageFlags.Ephemeral
        });
    },

    componentHandlers: {
        [ID_DECISAO]: decidir
    }
};
