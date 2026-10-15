'use strict';

const { MessageFlags } = require('discord.js');

module.exports = {
    name: 'interactionCreate',

    async execute(interaction, client) {
        try {
            if (interaction.isAutocomplete()) {
                const command = client.commands.get(interaction.commandName);
                if (!command?.autocomplete) {
                    await interaction.respond([]);
                    return;
                }
                await command.autocomplete(interaction, client);
                return;
            }

            if (interaction.isChatInputCommand()) {
                const command = client.commands.get(interaction.commandName);

                if (!command) return;

                await command.execute(interaction, client);
                return;
            }

            // Modais, botões e selects são roteados pelo customId, registrado
            // por cada comando em `componentHandlers`.
            if (interaction.isModalSubmit() || interaction.isMessageComponent()) {
                let handler = client.componentHandlers.get(interaction.customId);
                if (!handler) {
                    for (const [customId, registeredHandler] of client.componentHandlers) {
                        if (
                            customId.endsWith('*') &&
                            interaction.customId.startsWith(
                                customId.slice(0, -1)
                            )
                        ) {
                            handler = registeredHandler;
                            break;
                        }
                    }
                }

                if (!handler) return;

                await handler(interaction, client);
            }
        } catch (error) {
            console.error('[INTERACTION ERROR]', error);

            if (!interaction.isRepliable()) return;

            const reply = {
                content: 'Ocorreu um erro ao processar essa interação.',
                flags: MessageFlags.Ephemeral
            };

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply).catch(() => {});
            } else {
                await interaction.reply(reply).catch(() => {});
            }
        }
    }
};
