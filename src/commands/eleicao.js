'use strict';

const {
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');

const dbEleicoes = require('../database/eleicoes');
const databasePartidos = require('../database');
const candidatosService = require('../services/eleicoes/candidatos-service');
const permissoesService = require('../services/eleicoes/permissoes-service');
const apuracaoService = require('../services/eleicoes/apuracao-service');
const schedulerService = require('../services/eleicoes/scheduler-service');
const urnaService = require('../services/eleicoes/urna-service');

const responder = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral });

module.exports = {
    data: new SlashCommandBuilder()
        .setName('eleicao')
        .setDescription('Gerencia e participa do sistema eleitoral e urnas eletrônicas')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub
                .setName('criar')
                .setDescription('Configura uma nova eleição no servidor')
                .addStringOption(opt =>
                    opt
                        .setName('nome')
                        .setDescription('Nome ou identificação da eleição (ex: Eleição Geral 2026)')
                        .setRequired(true)
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('eleicao_base')
                        .setDescription('Eleição do cadastro de partidos onde estão os candidatos')
                        .setAutocomplete(true)
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('n')
                        .setDescription('Tamanho do distrito (n) caso deseje criar um novo cadastro')
                        .setMinValue(1)
                        .setMaxValue(500)
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('duracao')
                        .setDescription('Duração da votação em minutos (opcional para encerramento automático)')
                        .setMinValue(1)
                        .setMaxValue(10080)
                )
                .addStringOption(opt =>
                    opt
                        .setName('eleitorado')
                        .setDescription('Quem pode votar nesta eleição')
                        .addChoices(
                            { name: 'Todos os membros', value: 'todos' },
                            { name: 'Apenas membros filiados a partidos', value: 'filiados' }
                        )
                )
                .addBooleanOption(opt =>
                    opt
                        .setName('publicar_parcial')
                        .setDescription('Permitir consulta pública da apuração parcial antes de encerrar')
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('iniciar')
                .setDescription('Abre o período de votação de uma eleição configurada')
                .addIntegerOption(opt =>
                    opt
                        .setName('eleicao')
                        .setDescription('Eleição a ser aberta')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addChannelOption(opt =>
                    opt
                        .setName('canal')
                        .setDescription('Canal de texto onde a cabine de votação da urna será publicada')
                        .addChannelTypes(
                            ChannelType.GuildText,
                            ChannelType.GuildAnnouncement
                        )
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('votar')
                .setDescription('Abre sua tela privada da Urna Eletrônica para votar')
                .addIntegerOption(opt =>
                    opt
                        .setName('eleicao')
                        .setDescription('Eleição na qual deseja votar (padrão: eleição aberta atual)')
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('encerrar')
                .setDescription('Encerra a votação de uma eleição e processa a apuração dos votos')
                .addIntegerOption(opt =>
                    opt
                        .setName('eleicao')
                        .setDescription('Eleição a ser encerrada')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('resultados')
                .setDescription('Consulta os resultados e apuração de uma eleição')
                .addIntegerOption(opt =>
                    opt
                        .setName('eleicao')
                        .setDescription('Eleição para consulta')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('turno')
                        .setDescription('Turno dos resultados')
                        .addChoices(
                            { name: '1º Turno', value: 1 },
                            { name: '2º Turno', value: 2 }
                        )
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('status')
                .setDescription('Verifica o estado atual das eleições no servidor')
                .addIntegerOption(opt =>
                    opt
                        .setName('eleicao')
                        .setDescription('Eleição específica para detalhes')
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('cancelar')
                .setDescription('Cancela uma eleição')
                .addIntegerOption(opt =>
                    opt
                        .setName('eleicao')
                        .setDescription('Eleição a cancelar')
                        .setAutocomplete(true)
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt
                        .setName('motivo')
                        .setDescription('Motivo do cancelamento')
                        .setRequired(true)
                )
        ),

    async autocomplete(interaction) {
        if (!interaction.guildId) return interaction.respond([]);
        const focused = interaction.options.getFocused(true);

        if (focused.name === 'eleicao') {
            const termo = String(focused.value).toLowerCase();
            const eleicoes = dbEleicoes
                .listarEleicoes(interaction.guildId)
                .filter(el =>
                    el.nome.toLowerCase().includes(termo) ||
                    String(el.id).includes(termo)
                )
                .slice(0, 25);

            return interaction.respond(
                eleicoes.map(el => ({
                    name: `[#${el.id}] ${el.nome} (${el.status} · T${el.turno})`.slice(0, 100),
                    value: el.id
                }))
            );
        }

        if (focused.name === 'eleicao_base') {
            const termo = String(focused.value).toLowerCase();
            const eleicoesBase = databasePartidos
                .listarEleicoes(interaction.guildId)
                .filter(el => String(el.id).includes(termo) || String(el.n).includes(termo))
                .slice(0, 25);

            return interaction.respond(
                eleicoesBase.map(el => ({
                    name: `Base #${el.id} · n=${el.n}`.slice(0, 100),
                    value: el.id
                }))
            );
        }

        return interaction.respond([]);
    },

    async execute(interaction, client) {
        if (!interaction.guildId) {
            return responder(interaction, 'Este comando só pode ser utilizado dentro de um servidor.');
        }

        const subcommand = interaction.options.getSubcommand();
        const isAdmin = permissoesService.verificarPermissaoAdmin(interaction);

        // Subcomando: VOTAR (disponível para todos os eleitores)
        if (subcommand === 'votar') {
            let eleicaoId = interaction.options.getInteger('eleicao');
            if (!eleicaoId) {
                const abertas = dbEleicoes
                    .listarEleicoes(interaction.guildId)
                    .filter(el => el.status === dbEleicoes.STATUS_ELEICAO.ABERTA);
                if (abertas.length === 0) {
                    return responder(interaction, 'Não há nenhuma eleição aberta para votação no momento.');
                }
                eleicaoId = abertas[0].id;
            }
            return urnaService.iniciarUrnaParaEleitor(interaction, eleicaoId);
        }

        // Subcomando: RESULTADOS (verificação de publicação parcial para não-admins)
        if (subcommand === 'resultados') {
            const eleicaoId = interaction.options.getInteger('eleicao', true);
            const turnoSolicitado = interaction.options.getInteger('turno');

            const eleicao = dbEleicoes.obterEleicao(interaction.guildId, eleicaoId);
            if (!eleicao) {
                return responder(interaction, 'Eleição não encontrada neste servidor.');
            }

            if (!isAdmin && !eleicao.publicarParcial && eleicao.status !== dbEleicoes.STATUS_ELEICAO.ENCERRADA) {
                return responder(
                    interaction,
                    '🔒 A apuração parcial desta eleição é restrita à administração e só será divulgada ao público após o encerramento da votação.'
                );
            }

            const turno = turnoSolicitado ?? eleicao.turno;
            const resultadosCargos = dbEleicoes.listarResultadoCargosEleicao(eleicao.id, turno);

            if (resultadosCargos.length === 0) {
                return responder(
                    interaction,
                    `Ainda não há apuração consolidada para o **${turno}º Turno** desta eleição. A apuração é realizada ao encerrar ou atualizar a eleição.`
                );
            }

            const embed = new EmbedBuilder()
                .setColor(0x004d40)
                .setTitle(`📊 RESULTADO DA APURAÇÃO: ${eleicao.nome}`)
                .setDescription(
                    `**Status:** ${eleicao.status.toUpperCase()} · **Turno:** ${turno}º Turno\n` +
                    `*Resultados consolidados a partir dos votos gravados no banco de dados SQLite.*`
                )
                .setFooter({ text: 'Justiça Eleitoral do Discord · TRE Bot' })
                .setTimestamp();

            for (const resCargo of resultadosCargos) {
                const itens = dbEleicoes.listarResultadosCargo(eleicao.id, resCargo.cargo, turno);
                const nomeCargo = candidatosService.NOMES_CARGOS[resCargo.cargo] ?? resCargo.cargo;

                const linhasCandidatos = itens
                    .filter(item => item.tipo === dbEleicoes.TIPO_VOTO.VALIDO)
                    .map(cand => {
                        const eleitoStr = cand.eleito ? ' 👑 **(ELEITO)**' : '';
                        const pctStr = cand.percentual_validos !== null
                            ? `${cand.percentual_validos.toFixed(2)}%`
                            : '0%';
                        return `• \`${cand.numero}\` **${cand.nome}** (${cand.partido_sigla}): **${cand.votos}** voto(s) (${pctStr})${eleitoStr}`;
                    });

                const totalBrancos = resCargo.votos_brancos ?? 0;
                const totalNulos = resCargo.votos_nulos ?? 0;
                const totalValidos = resCargo.votos_validos ?? 0;
                const totalGeral = resCargo.total_votos ?? 0;

                const textoSituacao = resCargo.aguarda_segundo_turno
                    ? '⚠️ **Aguardando 2º Turno**'
                    : resCargo.vencedor_nome
                    ? `🏆 **Vencedor:** ${resCargo.vencedor_nome} (${resCargo.vencedor_partido_sigla})`
                    : `ℹ️ **Situação:** ${resCargo.situacao}`;

                const valorCampo = [
                    textoSituacao,
                    linhasCandidatos.length > 0 ? linhasCandidatos.join('\n') : '*(Nenhum candidato votado)*',
                    `🗳️ Válidos: **${totalValidos}** | Brancos: **${totalBrancos}** | Nulos: **${totalNulos}** | Total: **${totalGeral}**`,
                    resCargo.observacao ? `📝 *${resCargo.observacao}*` : null
                ]
                    .filter(Boolean)
                    .join('\n');

                embed.addFields({
                    name: `📌 ${nomeCargo}`,
                    value: valorCampo.slice(0, 1024),
                    inline: false
                });
            }

            return interaction.reply({ embeds: [embed] });
        }

        // Subcomando: STATUS (disponível para todos)
        if (subcommand === 'status') {
            const eleicaoId = interaction.options.getInteger('eleicao');
            if (eleicaoId) {
                const el = dbEleicoes.obterEleicao(interaction.guildId, eleicaoId);
                if (!el) return responder(interaction, 'Eleição não encontrada.');

                const cargos = dbEleicoes.listarCargos(el.id);
                const eleitores = dbEleicoes.contarEleitores(el.id, el.turno);

                const embed = new EmbedBuilder()
                    .setColor(0x1a5f7a)
                    .setTitle(`📋 Informações da Eleição: ${el.nome}`)
                    .setDescription(
                        `• **ID:** #${el.id}\n` +
                        `• **Status:** \`${el.status}\`\n` +
                        `• **Turno:** ${el.turno}º Turno\n` +
                        `• **Eleitorado:** ${el.eleitorado === 'filiados' ? 'Somente filiados' : 'Todos os membros'}\n` +
                        `• **Publicação parcial:** ${el.publicarParcial ? 'Pública' : 'Restrita a admins'}\n` +
                        `• **Participação atual:** ${eleitores.concluidos} eleitor(es) concluíram o voto\n` +
                        (el.abertaEm ? `• **Aberta em:** <t:${Math.floor(new Date(el.abertaEm).getTime() / 1000)}:R>\n` : '') +
                        (el.encerraEm ? `• **Encerra em:** <t:${Math.floor(new Date(el.encerraEm).getTime() / 1000)}:R>\n` : '') +
                        (el.encerradaEm ? `• **Encerrada em:** <t:${Math.floor(new Date(el.encerradaEm).getTime() / 1000)}:R>\n` : '')
                    );

                const listaCargos = cargos.map(c =>
                    `• **${candidatosService.NOMES_CARGOS[c.cargo] ?? c.cargo}:** ${c.status} (${c.digitos} dígitos${c.segundoTurno ? ', 2º turno se necessário' : ''})`
                ).join('\n');

                embed.addFields({ name: 'Cargos em disputa', value: listaCargos || 'Nenhum cargo' });

                return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }

            const eleicoes = dbEleicoes.listarEleicoes(interaction.guildId);
            if (eleicoes.length === 0) {
                return responder(interaction, 'Nenhuma eleição registrada neste servidor.');
            }

            const lista = eleicoes.map(el =>
                `• **#${el.id} - ${el.nome}:** status \`${el.status}\` (Turno ${el.turno})`
            ).join('\n');

            return responder(interaction, `**Eleições no Servidor:**\n${lista}`);
        }

        // Daqui para baixo, TODOS os comandos exigem permissão de administrador:
        if (!isAdmin) {
            return responder(
                interaction,
                '❌ Você precisa de permissão de administrador (**Gerenciar servidor**) para executar ações de configuração ou controle eleitoral.'
            );
        }

        // Subcomando: CRIAR
        if (subcommand === 'criar') {
            const nome = interaction.options.getString('nome', true).trim();
            const duracaoMinutos = interaction.options.getInteger('duracao');
            const eleitorado = interaction.options.getString('eleitorado') ?? dbEleicoes.ELEITORADO.TODOS;
            const publicarParcial = interaction.options.getBoolean('publicar_parcial') ?? false;

            let eleicaoRefId = interaction.options.getInteger('eleicao_base');
            let n = interaction.options.getInteger('n');

            if (!eleicaoRefId) {
                if (!n) {
                    const ultima = databasePartidos.listarEleicoes(interaction.guildId).slice(-1)[0];
                    if (ultima) {
                        eleicaoRefId = ultima.id;
                        n = ultima.n;
                    } else {
                        n = 10;
                        const novaEleicaoBase = databasePartidos.criarEleicao(interaction.guildId, n);
                        eleicaoRefId = novaEleicaoBase.id;
                    }
                } else {
                    const novaEleicaoBase = databasePartidos.criarEleicao(interaction.guildId, n);
                    eleicaoRefId = novaEleicaoBase.id;
                }
            } else {
                const baseExistente = databasePartidos.obterEleicao(interaction.guildId, eleicaoRefId);
                if (!baseExistente) {
                    return responder(interaction, `Eleição base #${eleicaoRefId} não encontrada no cadastro de partidos.`);
                }
                n = baseExistente.n;
            }

            const cargos = candidatosService.gerarCargosPadrao();

            try {
                const novaEleicao = dbEleicoes.criarEleicao({
                    guildId: interaction.guildId,
                    eleicaoRefId,
                    n,
                    nome,
                    eleitorado,
                    publicarParcial,
                    duracaoMinutos,
                    criadaPor: interaction.user.id,
                    cargos
                });

                // Importa e congela os candidatos aprovados para garantir preservação histórica
                const importados = candidatosService.importarCandidatosParaEleicao(
                    novaEleicao.id,
                    interaction.guildId,
                    eleicaoRefId
                );

                permissoesService.registrarAuditoria(
                    novaEleicao.id,
                    interaction.guildId,
                    'eleicao_criada',
                    `Eleição #${novaEleicao.id} "${nome}" criada com ${importados.length} candidato(s) importado(s).`,
                    interaction.user.id
                );

                return responder(
                    interaction,
                    `✅ Eleição **#${novaEleicao.id} - ${novaEleicao.nome}** criada com sucesso!\n` +
                    `• Base de partidos: #${eleicaoRefId} (n=${n})\n` +
                    `• Candidatos aprovados vinculados: **${importados.length}**\n` +
                    `• Eleitorado: ${eleitorado}\n` +
                    `• Cargos configurados: ${cargos.map(c => c.cargo).join(', ')}\n\n` +
                    `Para iniciar a votação, utilize \`/eleicao iniciar eleicao:${novaEleicao.id}\`.`
                );
            } catch (err) {
                if (err.message?.includes('UNIQUE')) {
                    return responder(interaction, '❌ Já existe uma eleição com este nome vinculada a esta base de partidos.');
                }
                throw err;
            }
        }

        // Subcomando: INICIAR
        if (subcommand === 'iniciar') {
            const eleicaoId = interaction.options.getInteger('eleicao', true);
            const canalEscolhido = interaction.options.getChannel('canal') ?? interaction.channel;

            const eleicao = dbEleicoes.obterEleicao(interaction.guildId, eleicaoId);
            if (!eleicao) return responder(interaction, 'Eleição não encontrada.');

            if (eleicao.status === dbEleicoes.STATUS_ELEICAO.ABERTA) {
                return responder(interaction, 'Esta eleição já está com a votação aberta.');
            }
            if (eleicao.status === dbEleicoes.STATUS_ELEICAO.ENCERRADA || eleicao.status === dbEleicoes.STATUS_ELEICAO.CANCELADA) {
                return responder(interaction, `Esta eleição não pode ser iniciada pois está \`${eleicao.status}\`.`);
            }

            const agora = new Date();
            const abertaEm = agora.toISOString();
            let encerraEm = null;

            if (eleicao.duracaoMinutos) {
                encerraEm = new Date(agora.getTime() + eleicao.duracaoMinutos * 60 * 1000).toISOString();
            }

            // Publica cabine de votação com o botão interativo
            const payloadCabine = urnaService.construirMensagemCabine(eleicao);
            const msgPublica = await canalEscolhido.send(payloadCabine);

            dbEleicoes.atualizarEleicao(eleicao.id, {
                status: dbEleicoes.STATUS_ELEICAO.ABERTA,
                aberta_em: abertaEm,
                encerra_em: encerraEm,
                canal_id: canalEscolhido.id,
                mensagem_id: msgPublica.id
            });

            dbEleicoes.abrirCargos(eleicao.id, abertaEm);

            // Se possuir duração limite, agenda encerramento automático
            if (encerraEm) {
                schedulerService.agendarEncerramentoEleicao({
                    eleicaoId: eleicao.id,
                    guildId: eleicao.guildId,
                    encerraEm,
                    client
                });
            }

            permissoesService.registrarAuditoria(
                eleicao.id,
                interaction.guildId,
                'eleicao_iniciada',
                `Votação iniciada no canal <#${canalEscolhido.id}>.`,
                interaction.user.id
            );

            return responder(
                interaction,
                `🗳️ A votação para a eleição **${eleicao.nome}** foi iniciada com sucesso em <#${canalEscolhido.id}>!`
            );
        }

        // Subcomando: ENCERRAR
        if (subcommand === 'encerrar') {
            const eleicaoId = interaction.options.getInteger('eleicao', true);
            const eleicao = dbEleicoes.obterEleicao(interaction.guildId, eleicaoId);
            if (!eleicao) return responder(interaction, 'Eleição não encontrada.');

            if (eleicao.status !== dbEleicoes.STATUS_ELEICAO.ABERTA) {
                return responder(interaction, `A eleição não está aberta (status atual: \`${eleicao.status}\`).`);
            }

            const agora = new Date().toISOString();
            dbEleicoes.encerrarEleicao(eleicao.id, agora);

            // Executa a apuração completa
            const resultadoApuracao = apuracaoService.apurarEleicaoCompleta(eleicao.id, eleicao.guildId);

            permissoesService.registrarAuditoria(
                eleicao.id,
                interaction.guildId,
                'eleicao_encerrada_manualmente',
                `Eleição encerrada pelo administrador ${interaction.user.tag}.`,
                interaction.user.id
            );

            let msgSegundoTurno = '';
            if (resultadoApuracao.necessitaSegundoTurno && eleicao.turno === 1) {
                schedulerService.agendarSegundoTurno({
                    eleicaoId: eleicao.id,
                    guildId: eleicao.guildId,
                    client
                });
                msgSegundoTurno = '\n\n⏳ **Segundo turno necessário!** O 2º turno para os cargos de presidente/governador foi agendado e abrirá automaticamente em 10 minutos.';
            }

            return responder(
                interaction,
                `✅ Votação da eleição **${eleicao.nome}** encerrada com sucesso! A apuração foi consolidada.${msgSegundoTurno}\n\nConsulte os resultados com \`/eleicao resultados eleicao:${eleicao.id}\`.`
            );
        }

        // Subcomando: CANCELAR
        if (subcommand === 'cancelar') {
            const eleicaoId = interaction.options.getInteger('eleicao', true);
            const motivo = interaction.options.getString('motivo', true).trim();

            const eleicao = dbEleicoes.obterEleicao(interaction.guildId, eleicaoId);
            if (!eleicao) return responder(interaction, 'Eleição não encontrada.');

            dbEleicoes.cancelarEleicao(eleicao.id, motivo);
            dbEleicoes.cancelarAgendamentosEleicao(eleicao.id);

            permissoesService.registrarAuditoria(
                eleicao.id,
                interaction.guildId,
                'eleicao_cancelada',
                `Motivo: ${motivo}`,
                interaction.user.id
            );

            return responder(interaction, `🛑 A eleição **#${eleicao.id} - ${eleicao.nome}** foi cancelada.`);
        }

        return responder(interaction, 'Subcomando não reconhecido.');
    },

    // Component handlers registrados no client.componentHandlers pelo índice
    componentHandlers: {
        'urna_abrir:*': async (interaction, client) => {
            const partes = interaction.customId.split(':');
            const eleicaoId = Number(partes[1]);
            return urnaService.iniciarUrnaParaEleitor(interaction, eleicaoId);
        },

        'urna_btn:*': async (interaction, client) => {
            return urnaService.processarCliqueUrna(interaction, client);
        }
    }
};
