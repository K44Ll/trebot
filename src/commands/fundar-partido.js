'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    SlashCommandBuilder,
    TextDisplayBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const database = require('../database');

// customIds das etapas
const ID_MODAL_LEITURA = 'tb_fundacao_leitura';
const ID_MODAL_PROGRAMA = 'tb_fundacao_programa';
const ID_BOTAO_CONTINUAR = 'tb_fundacao_continuar';
const ID_BOTAO_APOIO = 'tb_apoio_partido';

// customIds dos campos
const ID_LEU_REGRAS = 'tb_leu_regras';
const ID_NOME = 'tb_nome';
const ID_SIGLA = 'tb_sigla';
const ID_EMOJI = 'tb_emoji';
const ID_POSICIONAMENTO = 'tb_posicionamento';
const ID_PROPOSTAS = 'tb_propostas';
const ID_VALORES = 'tb_valores';

const STATUS_AGUARDANDO = 'Aguardando apoiadores';
const POSICIONAMENTOS = ['Esquerda', 'Centro', 'Direita'];

// Texto digitado pelo usuário não deve disparar @everyone/@here/cargos.
const SEM_MENCOES = { allowedMentions: { parse: [] } };

const responder = (interaction, content) =>
    interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        ...SEM_MENCOES
    });

const textField = (id, label, style, placeholder, maxLength, minLength = 1) => {
    const input = new TextInputBuilder()
        .setCustomId(id)
        .setStyle(style)
        .setPlaceholder(placeholder)
        .setMinLength(minLength)
        .setMaxLength(maxLength)
        .setRequired(true);

    return new LabelBuilder()
        .setLabel(label)
        .setTextInputComponent(input);
};

// ---------------------------------------------------------------------------
// ETAPA 1 — leitura das regras + identidade partidária
// ---------------------------------------------------------------------------

function modalLeitura() {
    const instructions = new TextDisplayBuilder().setContent(
        [
            '## TRIBUNAL REGIONAL ELEITORAL',
            '### Processo de fundação partidária',
            '',
            'Antes de começar, leia as regras:',
            '',
            '1. **Apoio coletivo:** será necessário reunir apoiadores.',
            '2. **Identidade:** escolha um nome, uma sigla e um símbolo.',
            '3. **Programa:** apresente propostas e valores políticos.',
            '4. **Posicionamento:** indique a orientação política do partido.',
            '5. **Aprovação:** a proposta ficará pendente até cumprir os requisitos de fundação do servidor.',
            '',
            '-# Preencher o formulário não garante a aprovação automática.'
        ].join('\n')
    );

    const consent = new LabelBuilder()
        .setLabel('Confirmação de leitura')
        .setDescription('É necessário marcar esta opção para continuar.')
        .setCheckboxGroupComponent(checkboxes =>
            checkboxes
                .setCustomId(ID_LEU_REGRAS)
                .addOptions([
                    {
                        label: 'Li e entendi as regras de fundação',
                        value: 'aceito'
                    }
                ])
                .setMinValues(1)
                .setMaxValues(1)
        );

    // Um modal aceita no máximo 5 componentes: 1 texto + 4 labels.
    return new ModalBuilder()
        .setCustomId(ID_MODAL_LEITURA)
        .setTitle('Fundação de partido | TRE')
        .addTextDisplayComponents(instructions)
        .addLabelComponents(
            consent,
            textField(
                ID_NOME,
                'Nome completo do partido',
                TextInputStyle.Short,
                'Ex.: Partido da Renovação Nacional',
                80,
                3
            ),
            textField(
                ID_SIGLA,
                'Sigla',
                TextInputStyle.Short,
                'Ex.: PRN',
                10,
                2
            ),
            textField(
                ID_EMOJI,
                'Emoji ou símbolo',
                TextInputStyle.Short,
                'Ex.: 🗳️',
                20
            )
        );
}

async function handleLeitura(interaction) {
    const accepted = interaction.fields.getCheckboxGroup(ID_LEU_REGRAS);

    if (!accepted.includes('aceito')) {
        return responder(
            interaction,
            'Você precisa confirmar a leitura para continuar.'
        );
    }

    const nome = interaction.fields.getTextInputValue(ID_NOME).trim();
    const sigla = interaction.fields
        .getTextInputValue(ID_SIGLA)
        .trim()
        .toUpperCase();
    const emoji = interaction.fields.getTextInputValue(ID_EMOJI).trim();

    if (!nome || !sigla || !emoji) {
        return responder(
            interaction,
            'Preencha todos os campos da identidade partidária.'
        );
    }

    const propostaExistente = database.obterProposta(
        interaction.user.id,
        interaction.guildId
    );
    if (
        propostaExistente &&
        propostaExistente.status !== database.STATUS_RASCUNHO
    ) {
        return responder(
            interaction,
            `Você já tem uma proposta com status **${propostaExistente.status}** neste servidor.`
        );
    }

    if (!/^[\p{L}\p{N}]{2,10}$/u.test(sigla)) {
        return responder(
            interaction,
            'A sigla deve ter de 2 a 10 caracteres, apenas letras e números.'
        );
    }

    if (
        database.siglaEmUso(
            sigla,
            interaction.user.id,
            interaction.guildId
        )
    ) {
        return responder(
            interaction,
            `A sigla **${sigla}** já está em uso por outro partido.`
        );
    }

    if (
        database.nomeEmUso(
            nome,
            interaction.user.id,
            interaction.guildId
        )
    ) {
        return responder(
            interaction,
            `Já existe um partido com o nome **${nome}**.`
        );
    }

    try {
        database.salvarIdentidade({
            fundadorId: interaction.user.id,
            fundadorNome: interaction.user.username,
            guildId: interaction.guildId,
            nome,
            sigla,
            emoji,
            posicionamento: null
        });
    } catch (error) {
        // Índice único de sigla: outra pessoa registrou a mesma sigla entre a
        // checagem acima e a gravação.
        if (String(error.code).startsWith('SQLITE_CONSTRAINT')) {
            return responder(
                interaction,
                'Essa sigla ou nome acabou de ser registrado por outra pessoa. Tente novamente.'
            );
        }
        throw error;
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(ID_BOTAO_CONTINUAR)
            .setLabel('Continuar para o programa')
            .setStyle(ButtonStyle.Primary)
    );

    // Um modal não pode ser respondido com outro modal — só interações de
    // componente (botão) podem chamar showModal. Daí a etapa intermediária.
    return interaction.reply({
        content: [
            `Identidade registrada: **${emoji} ${nome} (${sigla})**`,
            '',
            'Clique em **Continuar** para preencher o programa partidário.',
            '',
            '-# Você tem 24 horas para concluir; depois disso a proposta expira.'
        ].join('\n'),
        components: [row],
        flags: MessageFlags.Ephemeral,
        ...SEM_MENCOES
    });
}

// ---------------------------------------------------------------------------
// ETAPA 2 — programa partidário (aberta pelo botão)
// ---------------------------------------------------------------------------

function modalPrograma() {
    const position = new LabelBuilder()
        .setLabel('Posicionamento político')
        .setDescription('Escolha a orientação principal.')
        .setRadioGroupComponent(radio =>
            radio
                .setCustomId(ID_POSICIONAMENTO)
                .setRequired(true)
                .addOptions(POSICIONAMENTOS.map(p => ({ label: p, value: p })))
        );

    return new ModalBuilder()
        .setCustomId(ID_MODAL_PROGRAMA)
        .setTitle('Programa partidário')
        .addLabelComponents(
            position,
            textField(
                ID_PROPOSTAS,
                'Propostas do partido',
                TextInputStyle.Paragraph,
                'O que o partido pretende fazer?',
                1000,
                20
            ),
            textField(
                ID_VALORES,
                'Valores e princípios',
                TextInputStyle.Paragraph,
                'Ex.: liberdade, igualdade, desenvolvimento...',
                1000,
                10
            )
        );
}

async function handleContinuar(interaction) {
    const proposta = database.obterProposta(
        interaction.user.id,
        interaction.guildId
    );

    if (!proposta || proposta.status !== database.STATUS_RASCUNHO) {
        return interaction.update({
            content:
                'Seu rascunho não está mais disponível. Execute `/fundar-partido` para iniciar uma nova proposta.',
            components: []
        });
    }

    return interaction.showModal(modalPrograma());
}

// ---------------------------------------------------------------------------
// ETAPA 3 — conclusão da proposta
// ---------------------------------------------------------------------------

function embedProposta(proposta, totalApoios, minimoApoios) {
    return new EmbedBuilder()
        .setColor(
            proposta.status === database.STATUS_FUNDADO ? 0x2a9d8f : 0xd62828
        )
        .setTitle(`${proposta.emoji} ${proposta.nome} (${proposta.sigla})`)
        .setDescription(
            proposta.status === database.STATUS_FUNDADO
                ? 'A proposta atingiu o número necessário de apoios e o partido foi fundado.'
                : 'Apoie esta proposta para participar da fundação do partido.'
        )
        .addFields(
            {
                name: 'Fundador',
                value: `<@${proposta.fundadorId}>`,
                inline: true
            },
            {
                name: 'Posicionamento',
                value: proposta.posicionamento,
                inline: true
            },
            {
                name: 'Status',
                value: proposta.status,
                inline: true
            },
            {
                name: 'Apoios',
                value: `${totalApoios} / ${minimoApoios}`,
                inline: true
            },
            { name: 'Propostas', value: proposta.propostas },
            { name: 'Valores e princípios', value: proposta.valores }
        )
        .setFooter({ text: 'TRE BOT • Fundação partidária' })
        .setTimestamp();
}

async function handleApoio(interaction) {
    const proposta = database.obterPropostaPorMensagem(
        interaction.guildId,
        interaction.channelId,
        interaction.message.id
    );

    if (!proposta) {
        return responder(
            interaction,
            'Esta proposta não está mais disponível para apoio.'
        );
    }

    const resultado = database.registrarApoio(
        interaction.guildId,
        proposta.fundadorId,
        interaction.user.id
    );

    if (resultado.resultado === 'indisponivel') {
        return responder(interaction, 'Esta proposta não está mais recebendo apoios.');
    }
    if (resultado.resultado === 'fundador') {
        return responder(interaction, 'O fundador não pode apoiar a própria proposta.');
    }

    const fundada =
        resultado.proposta.status === database.STATUS_FUNDADO;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(ID_BOTAO_APOIO)
            .setLabel(fundada ? 'Partido fundado' : 'Apoiar partido')
            .setStyle(fundada ? ButtonStyle.Success : ButtonStyle.Primary)
            .setDisabled(fundada)
    );

    await interaction.update({
        embeds: [
            embedProposta(
                resultado.proposta,
                resultado.total,
                resultado.minimoApoios ??
                    database.obterConfiguracao(interaction.guildId)
                        .minimoApoios
            )
        ],
        components: fundada ? [] : [row]
    });

    const mensagem =
        resultado.resultado === 'duplicado'
            ? `Você já apoiou esta proposta. Total: ${resultado.total} / ${resultado.minimoApoios}.`
            : fundada
              ? `Meta alcançada! **${resultado.proposta.nome} (${resultado.proposta.sigla})** foi fundado.`
              : `Apoio registrado. Total: **${resultado.total} / ${resultado.minimoApoios}**.`;

    return interaction.followUp({
        content: mensagem,
        flags: MessageFlags.Ephemeral
    });
}

async function handlePrograma(interaction) {
    const proposta = database.obterProposta(
        interaction.user.id,
        interaction.guildId
    );

    if (!proposta || proposta.status !== database.STATUS_RASCUNHO) {
        return responder(
            interaction,
            'Seu rascunho não está mais disponível. Execute `/fundar-partido` para iniciar uma nova proposta.'
        );
    }

    const posicionamento = interaction.fields.getRadioGroup(ID_POSICIONAMENTO);

    if (!POSICIONAMENTOS.includes(posicionamento)) {
        return responder(
            interaction,
            'Selecione um posicionamento político para continuar.'
        );
    }

    const propostas = interaction.fields
        .getTextInputValue(ID_PROPOSTAS)
        .trim();
    const valores = interaction.fields.getTextInputValue(ID_VALORES).trim();

    if (!propostas || !valores) {
        return responder(
            interaction,
            'Preencha as propostas e os valores do partido.'
        );
    }

    const config = database.obterConfiguracao(interaction.guildId);
    if (!config.canalApoioId) {
        return responder(
            interaction,
            'O sistema de apoio ainda não foi configurado. Peça a um administrador para definir o canal com `/config canal-apoio`.'
        );
    }

    let canal;
    let mensagem;
    try {
        canal = await interaction.guild.channels.fetch(config.canalApoioId);
        if (!canal?.isTextBased() || !canal.send) {
            return responder(
                interaction,
                'O canal de apoio configurado não está disponível. Peça a um administrador para revisar `/config canal-apoio`.'
            );
        }

        const propostaParaPublicar = {
            ...proposta,
            propostas,
            valores,
            posicionamento,
            status: STATUS_AGUARDANDO
        };
        mensagem = await canal.send({
            embeds: [
                embedProposta(
                    propostaParaPublicar,
                    0,
                    config.minimoApoios
                )
            ],
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(ID_BOTAO_APOIO)
                        .setLabel('Apoiar partido')
                        .setStyle(ButtonStyle.Primary)
                )
            ],
            ...SEM_MENCOES
        });
    } catch (error) {
        console.error('[FUNDACAO] Falha ao publicar proposta:', error);
        return responder(
            interaction,
            'Não foi possível publicar a proposta no canal configurado. Verifique as permissões do bot e tente novamente.'
        );
    }

    let atualizada;
    try {
        atualizada = database.salvarPrograma(interaction.user.id, {
            guildId: interaction.guildId,
            propostas,
            valores,
            posicionamento,
            status: STATUS_AGUARDANDO,
            canalId: canal.id,
            mensagemId: mensagem.id
        });
    } catch (error) {
        try {
            await mensagem.delete();
        } catch (erroAoRemover) {
            console.error(
                '[FUNDACAO] A proposta foi publicada mas não pôde ser removida após falha no banco:',
                erroAoRemover
            );
        }
        throw error;
    }

    if (!atualizada) {
        await mensagem.delete().catch(error =>
            console.error(
                '[FUNDACAO] Não foi possível remover proposta sem rascunho:',
                error
            )
        );
        return responder(
            interaction,
            'Sua proposta não está mais disponível. Execute `/fundar-partido` novamente.'
        );
    }

    return responder(
        interaction,
        `Proposta publicada em <#${canal.id}>. Ela precisa de **${config.minimoApoios} apoios** para que o partido seja fundado.`
    );
}

// ---------------------------------------------------------------------------

module.exports = {
    data: new SlashCommandBuilder()
        .setName('fundar-partido')
        .setDescription('Inicia o processo de fundação de um partido político'),

    async execute(interaction) {
        if (!interaction.guildId) {
            return responder(
                interaction,
                'Este comando só pode ser usado dentro de um servidor.'
            );
        }

        const config = database.obterConfiguracao(interaction.guildId);
        if (!config.canalApoioId) {
            return responder(
                interaction,
                'O sistema eleitoral ainda não foi configurado. Peça a um administrador para usar `/config canal-apoio`.'
            );
        }

        const existente = database.obterProposta(
            interaction.user.id,
            interaction.guildId
        );
        if (
            existente &&
            existente.status !== database.STATUS_RASCUNHO
        ) {
            return responder(
                interaction,
                `Você já tem uma proposta com status **${existente.status}** neste servidor.`
            );
        }

        // Aproveita para limpar rascunhos abandonados de outros usuários.
        database.limparRascunhosExpirados();

        return interaction.showModal(modalLeitura());
    },

    componentHandlers: {
        [ID_MODAL_LEITURA]: handleLeitura,
        [ID_BOTAO_CONTINUAR]: handleContinuar,
        [ID_MODAL_PROGRAMA]: handlePrograma,
        [ID_BOTAO_APOIO]: handleApoio
    }
};
