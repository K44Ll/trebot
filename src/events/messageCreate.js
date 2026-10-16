'use strict';

const { responder } = require('../services/roteia');

module.exports = {
    name: 'messageCreate',

    async execute(message, client) {
        if (message.author.bot || !client.user || !message.mentions.users.has(client.user.id)) {
            return;
        }

        const mention = message.content.match(
            new RegExp(`<@!?${client.user.id}>`, 'u')
        );
        if (!mention) return;
        const pergunta = message.content
            .slice(mention.index + mention[0].length)
            .trim();
        if (!pergunta) return;

        let respostaPendente;
        try {
            respostaPendente = await message.reply({
                content: '⏳ Consultando o Código Eleitoral…',
                allowedMentions: { parse: [], repliedUser: false }
            });
            const resposta = await responder({
                pergunta,
                chaveConversa: [
                    message.guildId ?? 'dm',
                    message.channelId,
                    message.author.id
                ].join(':'),
                apiKey: process.env.ROTEIA_KEY
            });
            await respostaPendente.edit({
                content: resposta,
                allowedMentions: { parse: [], repliedUser: false }
            });
        } catch (error) {
            console.error('[ROTEIA ERROR]', error.message);
            if (respostaPendente) {
                await respostaPendente.edit({
                    content: 'Não consegui consultar o assistente eleitoral agora. Tente novamente mais tarde.',
                    allowedMentions: { parse: [], repliedUser: false }
                }).catch(() => {});
            }
        }
    }
};
