'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags
} = require('discord.js');

const dbEleicoes = require('../../database/eleicoes');
const candidatosService = require('./candidatos-service');
const permissoesService = require('./permissoes-service');

// Sessões ativas de digitação em memória: chave = `${eleicaoId}:${discordId}:${turno}`
const sessoesEleitores = new Map();
const travasConcorrencia = new Set();
const TTL_SESSAO_MS = 10 * 60 * 1000;

function chaveSessao(eleicaoId, discordId, turno) {
    return `${eleicaoId}:${discordId}:${turno}`;
}

function obterOuCriarSessao(eleicaoId, discordId, turno, cargoAtual) {
    const chave = chaveSessao(eleicaoId, discordId, turno);
    let sessao = sessoesEleitores.get(chave);

    const agora = Date.now();
    if (!sessao || agora - sessao.atualizadoEm > TTL_SESSAO_MS) {
        sessao = {
            eleicaoId,
            discordId,
            turno,
            cargoAtual,
            digitos: '',
            branco: false,
            atualizadoEm: agora
        };
        sessoesEleitores.set(chave, sessao);
    } else if (cargoAtual && sessao.cargoAtual !== cargoAtual) {
        sessao.cargoAtual = cargoAtual;
        sessao.digitos = '';
        sessao.branco = false;
        sessao.atualizadoEm = agora;
    }

    return sessao;
}

function limparSessao(eleicaoId, discordId, turno) {
    sessoesEleitores.delete(chaveSessao(eleicaoId, discordId, turno));
}

/**
 * Monta os componentes de botão da Urna Eletrônica (máximo 5 ActionRows).
 */
function construirTecladoUrna(eleicaoId, cargo, desabilitado = false) {
    const btn = (label, customAcao, style = ButtonStyle.Secondary) =>
        new ButtonBuilder()
            .setCustomId(`urna_btn:${eleicaoId}:${cargo}:${customAcao}`)
            .setLabel(label)
            .setStyle(style)
            .setDisabled(desabilitado);

    const row1 = new ActionRowBuilder().addComponents(
        btn('1', '1'),
        btn('2', '2'),
        btn('3', '3')
    );

    const row2 = new ActionRowBuilder().addComponents(
        btn('4', '4'),
        btn('5', '5'),
        btn('6', '6')
    );

    const row3 = new ActionRowBuilder().addComponents(
        btn('7', '7'),
        btn('8', '8'),
        btn('9', '9')
    );

    const row4 = new ActionRowBuilder().addComponents(
        btn('BRANCO', 'branco', ButtonStyle.Secondary),
        btn('0', '0')
    );

    const row5 = new ActionRowBuilder().addComponents(
        btn('CORRIGE', 'corrige', ButtonStyle.Danger),
        btn('CONFIRMA', 'confirma', ButtonStyle.Success)
    );

    return [row1, row2, row3, row4, row5];
}

/**
 * Renderiza o visor da tela de votação com base no estado atual da urna.
 */
function construirEmbedUrna({
    eleicao,
    cargo,
    digitos,
    branco,
    candidato = null,
    aviso = null
}) {
    const nomeCargo = candidatosService.NOMES_CARGOS[cargo.cargo] ?? cargo.cargo;
    const qtdDigitos = cargo.digitos;

    // Formatação visual dos dígitos: `[ 1 ] [ 3 ]` ou `[ 1 ] [ _ ]`
    const espacos = [];
    for (let i = 0; i < qtdDigitos; i++) {
        if (branco) {
            espacos.push('[   ]');
        } else if (i < digitos.length) {
            espacos.push(`[ ${digitos[i]} ]`);
        } else {
            espacos.push('[ _ ]');
        }
    }
    const visualDigitos = espacos.join(' ');

    const embed = new EmbedBuilder()
        .setColor(0x1a5f7a)
        .setTitle('⚖️ JUSTIÇA ELEITORAL · URNA ELETRÔNICA')
        .setDescription(
            `**Eleição:** ${eleicao.nome} (${eleicao.turno}º Turno)\n` +
            `**Cargo:** ${nomeCargo}\n` +
            `**Número exigido:** ${qtdDigitos} dígito(s)\n`
        );

    if (branco) {
        embed.setColor(0xf0f0f0);
        embed.addFields(
            {
                name: 'Voto selecionado',
                value: '⚪ **VOTO EM BRANCO**\n\nAperte **CONFIRMA** para validar seu voto em branco ou **CORRIGE** para reiniciar.'
            }
        );
    } else if (candidato) {
        embed.setColor(0x2e7d32);
        embed.addFields(
            {
                name: 'Número digitado',
                value: `\`${visualDigitos}\``,
                inline: false
            },
            {
                name: 'Candidato',
                value: `**${candidato.nome}**`,
                inline: true
            },
            {
                name: 'Partido',
                value: `${candidato.partidoEmoji ? candidato.partidoEmoji + ' ' : ''}**${candidato.partidoNome}** (${candidato.partidoSigla})`,
                inline: true
            },
            {
                name: 'Instruções',
                value: 'Aperte **CONFIRMA** para registrar o voto ou **CORRIGE** para alterar o número.',
                inline: false
            }
        );
    } else if (digitos.length === qtdDigitos) {
        embed.setColor(0xd32f2f);
        embed.addFields(
            {
                name: 'Número digitado',
                value: `\`${visualDigitos}\``,
                inline: false
            },
            {
                name: '⚠️ NÚMERO ERRADO / CANDIDATO INEXISTENTE',
                value: 'Este número não corresponde a nenhum candidato aprovado para este cargo.\n\nSe você apertar **CONFIRMA**, seu voto será computado como **NULO**.\nPara tentar outro número, aperte **CORRIGE**.',
                inline: false
            }
        );
    } else {
        embed.addFields(
            {
                name: 'Digite o número do candidato',
                value: `\`${visualDigitos}\``,
                inline: false
            },
            {
                name: 'Instruções',
                value: 'Utilize o teclado abaixo para digitar os números.\n**BRANCO:** Votar em branco.\n**CORRIGE:** Limpar os dígitos.\n**CONFIRMA:** Gravar o voto.',
                inline: false
            }
        );
    }

    if (aviso) {
        embed.setFooter({ text: aviso });
    }

    return embed;
}

/**
 * Localiza o próximo cargo em aberto para o eleitor nesta eleição.
 */
function obterProximoCargoParaEleitor(eleicaoId, discordId, turno) {
    const cargosAbertos = dbEleicoes.listarCargosAbertos(eleicaoId);
    const confirmados = dbEleicoes.listarCargosConfirmados(eleicaoId, discordId, turno);

    return cargosAbertos.find(cargo => !confirmados.includes(cargo.cargo)) ?? null;
}

/**
 * Cria os componentes para a mensagem pública de votação da eleição.
 */
function construirMensagemCabine(eleicao) {
    const embed = new EmbedBuilder()
        .setColor(0x004d40)
        .setTitle(`🗳️ ELEIÇÃO OFICIAL: ${eleicao.nome}`)
        .setDescription(
            `A votação para o **${eleicao.turno}º Turno** está aberta!\n\n` +
            `• **Eleitorado:** ${eleicao.eleitorado === 'filiados' ? 'Somente filiados a partidos' : 'Todos os membros do servidor'}\n` +
            `• **Sigilo do voto:** Sua cédula é individual, privada e secreta.\n\n` +
            `Clique no botão abaixo para abrir a **Urna Eletrônica** na sua tela privada.`
        )
        .setFooter({ text: 'Justiça Eleitoral do Discord · Urna Eletrônica' })
        .setTimestamp();

    const botaoVotar = new ButtonBuilder()
        .setCustomId(`urna_abrir:${eleicao.id}`)
        .setLabel('Votar na Urna Eletrônica')
        .setEmoji('🗳️')
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(botaoVotar);

    return { embeds: [embed], components: [row] };
}

/**
 * Inicia a experiência de votação para um eleitor abrindo a urna de forma efêmera.
 */
async function iniciarUrnaParaEleitor(interaction, eleicaoId) {
    const discordId = interaction.user.id;
    const eleicao = dbEleicoes.obterEleicaoPorId(eleicaoId);

    const checagem = permissoesService.verificarElegibilidadeEleitor(eleicao, discordId);
    if (!checagem.autorizacao) {
        const mensagensErro = {
            eleicao_inexistente: 'Esta eleição não foi encontrada.',
            eleicao_nao_iniciada: 'A votação para esta eleição ainda não foi iniciada.',
            eleicao_cancelada: 'Esta eleição foi cancelada pela comissão eleitoral.',
            eleicao_encerrada: 'A votação desta eleição já foi encerrada.',
            prazo_encerrado: 'O prazo para votação nesta eleição expirou.',
            somente_filiados: 'Esta eleição é restrita a membros filiados a partidos políticos.',
            ja_votou: 'Você já registrou seu voto e concluiu sua participação nesta eleição!'
        };
        const msg = mensagensErro[checagem.motivo] ?? 'Você não está autorizado a votar nesta eleição.';
        return interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
    }

    const proximoCargo = obterProximoCargoParaEleitor(eleicao.id, discordId, eleicao.turno);
    if (!proximoCargo) {
        // Todos os cargos foram confirmados
        dbEleicoes.concluirEleitor(eleicao.id, discordId, eleicao.turno, new Date().toISOString());
        return interaction.reply({
            content: '✅ Você já confirmou o voto para todos os cargos deste turno!',
            flags: MessageFlags.Ephemeral
        });
    }

    // Registra início de participação no banco
    dbEleicoes.iniciarEleitor(eleicao.id, discordId, eleicao.turno, new Date().toISOString());

    const sessao = obterOuCriarSessao(eleicao.id, discordId, eleicao.turno, proximoCargo.cargo);
    const embed = construirEmbedUrna({
        eleicao,
        cargo: proximoCargo,
        digitos: sessao.digitos,
        branco: sessao.branco
    });
    const components = construirTecladoUrna(eleicao.id, proximoCargo.cargo);

    return interaction.reply({
        embeds: [embed],
        components,
        flags: MessageFlags.Ephemeral
    });
}

/**
 * Processa as interações com os botões da Urna Eletrônica (dígitos, branco, corrige, confirma).
 */
async function processarCliqueUrna(interaction, client = null) {
    const partes = interaction.customId.split(':');
    if (partes.length < 4) return;

    const eleicaoId = Number(partes[1]);
    const cargoNome = partes[2];
    const acao = partes[3];
    const discordId = interaction.user.id;

    const travaChave = `${eleicaoId}:${discordId}`;
    if (travasConcorrencia.has(travaChave)) {
        return interaction.deferUpdate().catch(() => {});
    }
    travasConcorrencia.add(travaChave);

    try {
        const eleicao = dbEleicoes.obterEleicaoPorId(eleicaoId);
        if (!eleicao || eleicao.status !== dbEleicoes.STATUS_ELEICAO.ABERTA) {
            return interaction.update({
                content: '⚠️ Esta eleição não está mais aberta para votação.',
                embeds: [],
                components: []
            });
        }

        const checagem = permissoesService.verificarElegibilidadeEleitor(eleicao, discordId);
        if (!checagem.autorizacao) {
            return interaction.update({
                content: '⚠️ Sua participação nesta eleição já foi concluída ou você não tem permissão para votar.',
                embeds: [],
                components: []
            });
        }

        // Garante que o eleitor está registrado em curso no banco
        if (!dbEleicoes.obterEleitor(eleicao.id, discordId, eleicao.turno)) {
            dbEleicoes.iniciarEleitor(eleicao.id, discordId, eleicao.turno, new Date().toISOString());
        }

        const cargo = dbEleicoes.obterCargo(eleicao.id, cargoNome);
        if (!cargo || cargo.status !== dbEleicoes.STATUS_CARGO.ABERTA) {
            return interaction.update({
                content: '⚠️ A votação para este cargo foi encerrada.',
                embeds: [],
                components: []
            });
        }

        const confirmados = dbEleicoes.listarCargosConfirmados(eleicao.id, discordId, eleicao.turno);
        if (confirmados.includes(cargo.cargo)) {
            // Este cargo já foi confirmado, avança para o próximo
            const proximoCargo = obterProximoCargoParaEleitor(eleicao.id, discordId, eleicao.turno);
            if (!proximoCargo) {
                return interaction.update({
                    content: '✅ Sua votação já foi completamente concluída!',
                    embeds: [],
                    components: []
                });
            }
            const novaSessao = obterOuCriarSessao(eleicao.id, discordId, eleicao.turno, proximoCargo.cargo);
            const embed = construirEmbedUrna({
                eleicao,
                cargo: proximoCargo,
                digitos: novaSessao.digitos,
                branco: novaSessao.branco
            });
            const components = construirTecladoUrna(eleicao.id, proximoCargo.cargo);
            return interaction.update({ embeds: [embed], components });
        }

        const sessao = obterOuCriarSessao(eleicao.id, discordId, eleicao.turno, cargo.cargo);
        let aviso = null;

        // 1. Botão BRANCO
        if (acao === 'branco') {
            sessao.branco = true;
            sessao.digitos = '';
            sessao.atualizadoEm = Date.now();
        }
        // 2. Botão CORRIGE
        else if (acao === 'corrige') {
            sessao.branco = false;
            sessao.digitos = '';
            sessao.atualizadoEm = Date.now();
        }
        // 3. Dígitos 0-9
        else if (/^[0-9]$/.test(acao)) {
            sessao.branco = false;
            if (sessao.digitos.length < cargo.digitos) {
                sessao.digitos += acao;
            }
            sessao.atualizadoEm = Date.now();
        }
        // 4. Botão CONFIRMA
        else if (acao === 'confirma') {
            if (!sessao.branco && sessao.digitos.length < cargo.digitos) {
                aviso = `Aperte CORRIGE ou complete os ${cargo.digitos} dígitos antes de confirmar.`;
            } else {
                let tipoVoto = dbEleicoes.TIPO_VOTO.VALIDO;
                let candidato = null;

                if (sessao.branco) {
                    tipoVoto = dbEleicoes.TIPO_VOTO.BRANCO;
                } else {
                    candidato = dbEleicoes.buscarCandidatoPorNumero(
                        eleicao.id,
                        cargo.cargo,
                        sessao.digitos,
                        eleicao.turno
                    );
                    if (!candidato) {
                        tipoVoto = dbEleicoes.TIPO_VOTO.NULO;
                    }
                }

                // Gravação atômica do voto
                const resultadoVoto = dbEleicoes.registrarVoto({
                    eleicaoId: eleicao.id,
                    guildId: eleicao.guildId,
                    cargo: cargo.cargo,
                    discordId,
                    tipo: tipoVoto,
                    numero: sessao.digitos
                });

                if (resultadoVoto.resultado === 'duplicado') {
                    aviso = 'Este cargo já havia sido confirmado anteriormente.';
                } else if (resultadoVoto.resultado !== 'registrado') {
                    aviso = 'Falha ao registrar o voto. Tente novamente.';
                } else {
                    // Voto registrado com sucesso!
                    limparSessao(eleicao.id, discordId, eleicao.turno);

                    if (resultadoVoto.concluido) {
                        // Concluiu todos os cargos da eleição
                        const embedFim = new EmbedBuilder()
                            .setColor(0x2e7d32)
                            .setTitle('🗳️ JUSTIÇA ELEITORAL · FIM')
                            .setDescription(
                                '### GRAVANDO VOTO...\n\n' +
                                '# F I M 🗳️\n\n' +
                                'Seu voto foi registrado com sucesso e sua cédula foi lacrada com sigilo absoluto!\n' +
                                'Obrigado por exercer seu direito de voto.'
                            )
                            .setFooter({ text: 'TRE Bot · Sistema Eleitoral Seguro' })
                            .setTimestamp();

                        await interaction.update({
                            embeds: [embedFim],
                            components: []
                        });

                        // Notificação discreta por mensagem privada (DM), sem revelar as opções votadas
                        try {
                            await interaction.user.send(
                                `Seu voto foi registrado com sucesso na eleição **${eleicao.nome}**. A participação foi concluída.`
                            );
                        } catch {
                            // Usuário pode ter DMs desativadas; o voto permanece salvo com sucesso
                        }

                        return;
                    }

                    // Avança para o próximo cargo
                    const proximoCargo = obterProximoCargoParaEleitor(eleicao.id, discordId, eleicao.turno);
                    if (proximoCargo) {
                        const novaSessao = obterOuCriarSessao(eleicao.id, discordId, eleicao.turno, proximoCargo.cargo);
                        const embed = construirEmbedUrna({
                            eleicao,
                            cargo: proximoCargo,
                            digitos: novaSessao.digitos,
                            branco: novaSessao.branco
                        });
                        const components = construirTecladoUrna(eleicao.id, proximoCargo.cargo);
                        return interaction.update({ embeds: [embed], components });
                    }
                }
            }
        }

        // Renderiza o estado atualizado
        let candidato = null;
        if (!sessao.branco && sessao.digitos.length === cargo.digitos) {
            candidato = dbEleicoes.buscarCandidatoPorNumero(
                eleicao.id,
                cargo.cargo,
                sessao.digitos,
                eleicao.turno
            );
        }

        const embed = construirEmbedUrna({
            eleicao,
            cargo,
            digitos: sessao.digitos,
            branco: sessao.branco,
            candidato,
            aviso
        });
        const components = construirTecladoUrna(eleicao.id, cargo.cargo);

        return interaction.update({ embeds: [embed], components });
    } finally {
        travasConcorrencia.delete(travaChave);
    }
}

module.exports = {
    construirTecladoUrna,
    construirEmbedUrna,
    construirMensagemCabine,
    obterProximoCargoParaEleitor,
    iniciarUrnaParaEleitor,
    processarCliqueUrna,
    limparSessao
};
