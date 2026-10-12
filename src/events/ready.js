'use strict';

module.exports = {
    name: 'ready',
    once: true,

    execute(client) {
        console.log(`[TRE BOT] Logado como ${client.user.username}`);
    }
};
