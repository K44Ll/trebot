'use strict';

const packageInfo = require('../../package.json');
const { renderDashboard } = require('../ui/console');
const schedulerService = require('../services/eleicoes/scheduler-service');
const legislativoService = require('../services/legislativo/sistema');

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

        try {
            await legislativoService.recuperarPublicacoes(client);
            await legislativoService.recuperarConsequencias(client);
        } catch (error) {
            console.error('[LEGISLATIVO ERROR] Falha ao recuperar publicações pendentes:', error);
        }

        const encerrarExpiradas = async () => {
            if (client.legislativoRun) return client.legislativoRun;
            const tarefa = legislativoService.encerrarVotacoesExpiradas(client);
            client.legislativoRun = tarefa;
            try {
                await tarefa;
            } finally {
                client.legislativoRun = null;
            }
        };
        client.legislativoScheduler = setInterval(() => {
            encerrarExpiradas().catch(error => {
                console.error('[LEGISLATIVO ERROR] Falha ao encerrar votações expiradas:', error);
            });
        }, 60_000);
        client.legislativoScheduler.unref();
        try {
            await encerrarExpiradas();
        } catch (error) {
            console.error('[LEGISLATIVO ERROR] Falha ao encerrar votações expiradas:', error);
        }
    }
};
