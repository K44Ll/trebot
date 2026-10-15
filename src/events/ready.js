'use strict';

const packageInfo = require('../../package.json');
const { renderDashboard } = require('../ui/console');
const schedulerService = require('../services/eleicoes/scheduler-service');

module.exports = {
    name: 'ready',
    once: true,

    async execute(client) {
        await client.animacaoInicializacao;
        renderDashboard({
            client,
            version: packageInfo.version
        });

        try {
            const recuperados = await schedulerService.recuperarAgendamentos(client);
            if (recuperados > 0) {
                console.log(`[ELEIÇÕES] ${recuperados} agendamento(s) recuperado(s) do banco.`);
            }
        } catch (error) {
            console.error('[ELEIÇÕES ERROR] Falha ao recuperar agendamentos:', error);
        }
    }
};

