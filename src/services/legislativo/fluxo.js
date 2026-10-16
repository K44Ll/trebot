'use strict';

const ETAPAS_INICIAIS = Object.freeze({
    PEC: 'ADMISSIBILIDADE',
    PL: 'ADMISSIBILIDADE',
    PLP: 'ADMISSIBILIDADE',
    IMPEACHMENT: 'ADMISSIBILIDADE'
});

function etapaDeVotacao(proposicao) {
    const tipo = proposicao.tipo;
    const etapa = proposicao.etapa;

    if (tipo === 'PEC') {
        const regras = {
            CAMARA_TURNO_1: ['CAMARA', 'tres_quintos', 'CAMARA_TURNO_2'],
            CAMARA_TURNO_2: ['CAMARA', 'tres_quintos', 'SENADO_TURNO_1'],
            SENADO_TURNO_1: ['SENADO', 'tres_quintos', 'SENADO_TURNO_2'],
            SENADO_TURNO_2: ['SENADO', 'tres_quintos', 'PROMULGADA']
        };
        return regras[etapa] ?? null;
    }

    if (tipo === 'PL' || tipo === 'PLP') {
        const regra = tipo === 'PLP' ? 'maioria_absoluta' : 'maioria_simples';
        const regras = {
            CAMARA_TURNO_1: [
                'CAMARA',
                regra,
                proposicao.casa_iniciadora === 'SENADO' ? 'SANCAO' : 'SENADO_TURNO_1'
            ],
            SENADO_TURNO_1: [
                'SENADO',
                regra,
                proposicao.casa_iniciadora === 'SENADO' ? 'CAMARA_TURNO_1' : 'SANCAO'
            ],
            RETORNO_CAMARA: ['CAMARA', regra, 'SANCAO'],
            RETORNO_SENADO: ['SENADO', regra, 'SANCAO'],
            VETO_CAMARA: ['CAMARA', 'maioria_absoluta', 'VETO_SENADO'],
            VETO_SENADO: ['SENADO', 'maioria_absoluta', 'PROMULGADA']
        };
        return regras[etapa] ?? null;
    }

    if (tipo === 'IMPEACHMENT') {
        const regras = {
            CAMARA_AUTORIZACAO: ['CAMARA', 'dois_tercos', 'SENADO_JULGAMENTO'],
            SENADO_JULGAMENTO: ['SENADO', 'dois_tercos', 'CONDENADA']
        };
        return regras[etapa] ?? null;
    }

    return null;
}

function próximaEtapa(proposicao, aprovado) {
    if (!aprovado) return 'REJEITADA';
    const votação = etapaDeVotacao(proposicao);
    if (
        votação &&
        proposicao.revisao_pendente &&
        proposicao.tipo !== 'PEC' &&
        ['CAMARA_TURNO_1', 'SENADO_TURNO_1'].includes(proposicao.etapa)
    ) {
        if (
            proposicao.etapa === 'SENADO_TURNO_1' &&
            proposicao.casa_iniciadora === 'CAMARA'
        ) return 'RETORNO_CAMARA';
        if (
            proposicao.etapa === 'CAMARA_TURNO_1' &&
            proposicao.casa_iniciadora === 'SENADO'
        ) return 'RETORNO_SENADO';
    }
    return votação?.[2] ?? null;
}

module.exports = { ETAPAS_INICIAIS, etapaDeVotacao, próximaEtapa };
