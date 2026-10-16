'use strict';

function validarTotal(total) {
    if (!Number.isSafeInteger(total) || total < 1) {
        throw new RangeError('A composição da Casa deve ser um inteiro positivo.');
    }
}

function maioriaAbsoluta(total) {
    validarTotal(total);
    return Math.floor(total / 2) + 1;
}

function doisTerços(total) {
    validarTotal(total);
    return Math.ceil((2 * total) / 3);
}

function trêsQuintos(total) {
    validarTotal(total);
    return Math.ceil((3 * total) / 5);
}

function apurarVotacao({
    sim,
    nao,
    branco,
    totalMembros,
    regra,
    quórumPresença = maioriaAbsoluta(totalMembros)
}) {
    validarTotal(totalMembros);
    for (const [nome, valor] of Object.entries({ sim, nao, branco })) {
        if (!Number.isSafeInteger(valor) || valor < 0) {
            throw new RangeError(`Contagem inválida de votos ${nome}.`);
        }
    }

    const presença = sim + nao + branco;
    let votosFavoráveisNecessários;
    let aprovação;

    switch (regra) {
        case 'maioria_simples':
            votosFavoráveisNecessários = null;
            aprovação =
                presença >= quórumPresença && sim + nao > 0 && sim > nao;
            break;
        case 'maioria_absoluta':
            votosFavoráveisNecessários = maioriaAbsoluta(totalMembros);
            aprovação =
                presença >= quórumPresença &&
                sim >= votosFavoráveisNecessários;
            break;
        case 'dois_tercos':
            votosFavoráveisNecessários = doisTerços(totalMembros);
            aprovação =
                presença >= quórumPresença &&
                sim >= votosFavoráveisNecessários;
            break;
        case 'tres_quintos':
            votosFavoráveisNecessários = trêsQuintos(totalMembros);
            aprovação =
                presença >= quórumPresença &&
                sim >= votosFavoráveisNecessários;
            break;
        default:
            throw new RangeError(`Regra de quórum desconhecida: ${regra}`);
    }

    return {
        sim,
        nao,
        branco,
        ausências: totalMembros - presença,
        presença,
        quórumPresença,
        votosFavoráveisNecessários,
        aprovado: aprovação
    };
}

module.exports = {
    maioriaAbsoluta,
    maioriaSimples: (sim, nao) => sim > nao,
    doisTerços,
    trêsQuintos,
    apurarVotacao
};
