'use strict';

const assert = require('node:assert/strict');
const { RECUSA, responder, selecionarArtigos } = require('../src/services/roteia');

const respostas = [
    'O voto é individual e secreto [Art. 2] [Art. 6].',
    'O eleitor pode votar em branco [Art. 50].',
    'RECUSA',
    'Resposta sem base [Art. 999].',
    'não é JSON'
];
const requisicoes = [];
const fetchFn = async (url, options) => {
    requisicoes.push({ url, options: JSON.parse(options.body) });
    return {
        ok: true,
        json: async () => ({
            choices: [{ message: { content: respostas.shift() } }]
        })
    };
};

async function main() {
    const primeira = await responder({
        pergunta: 'O voto é secreto?',
        chaveConversa: 'teste:canal:usuario',
        apiKey: 'chave-de-teste',
        fetchFn
    });
    assert.match(primeira, /Art\. 2º, Art\. 6º/);
    assert.equal(requisicoes[0].url, 'https://api.roteia.ai/v1/chat/completions');
    assert.equal(
        requisicoes[0].options.model,
        'nvidia/nemotron-3.5-lightning:free'
    );
    assert.equal(requisicoes[0].options.max_tokens, 2000);
    assert.ok(requisicoes[0].options.messages[0].content.length < 5000);
    assert.ok(selecionarArtigos('O voto é secreto?').some(artigo => artigo.numero === 2));

    const segunda = await responder({
        pergunta: 'E o voto em branco?',
        chaveConversa: 'teste:canal:usuario',
        apiKey: 'chave-de-teste',
        fetchFn
    });
    assert.match(segunda, /Art\. 50º/);
    const mensagens = requisicoes[1].options.messages;
    assert.ok(mensagens.some(mensagem =>
        mensagem.role === 'user' && mensagem.content === 'O voto é secreto?'
    ));
    assert.ok(mensagens.some(mensagem =>
        mensagem.role === 'assistant' && mensagem.content === primeira
    ));

    const foraDeEscopo = await responder({
        pergunta: 'Qual é a capital da França?',
        chaveConversa: 'teste:canal:usuario',
        apiKey: 'chave-de-teste',
        fetchFn
    });
    assert.equal(foraDeEscopo, RECUSA);
    assert.equal(await responder({
        pergunta: 'Pergunta eleitoral',
        chaveConversa: 'teste:canal:usuario',
        apiKey: 'chave-de-teste',
        fetchFn
    }), RECUSA);
    assert.equal(await responder({
        pergunta: 'Pergunta eleitoral',
        chaveConversa: 'teste:canal:usuario',
        apiKey: 'chave-de-teste',
        fetchFn
    }), RECUSA);

    await assert.rejects(
        responder({
            pergunta: 'Pergunta',
            chaveConversa: 'teste',
            apiKey: '',
            fetchFn
        }),
        /ROTEIA_KEY/
    );
    console.log('Testes do assistente Roteia passaram.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
