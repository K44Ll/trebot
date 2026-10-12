# trebot

Bot do Discord para o sistema eleitoral do TRE — fundação de partidos políticos.

## Requisitos

- Node.js **22+** (exigido pelo `better-sqlite3` 13)
- Um bot criado no [Discord Developer Portal](https://discord.com/developers/applications)

## Configuração

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Crie o arquivo `.env` a partir do modelo e preencha os valores:

   ```bash
   cp .env.example .env
   ```

   | Variável    | Onde encontrar                                                   |
   | ----------- | ---------------------------------------------------------------- |
   | `TOKEN`     | Developer Portal → Bot → *Reset Token*                           |
   | `CLIENT_ID` | Developer Portal → General Information → *Application ID*         |
   | `GUILD_ID`  | (opcional) ID do servidor de testes; deixe vazio para deploy global |

   > O `.env` contém credenciais e está no `.gitignore`. Nunca faça commit dele.

3. Registre os slash commands:

   ```bash
   npm run deploy
   ```

   Com `GUILD_ID` preenchido o registro é instantâneo. Sem ele, o registro é
   global e pode levar até 1 hora para propagar.

4. Suba o bot:

   ```bash
   npm start
   ```

## Testes

```bash
npm test     # valida builders de modal, validações e camada de banco
npm run check   # checagem de sintaxe de todos os arquivos
```

Os testes não conectam ao Discord: usam interações falsas e um banco temporário.

## Comandos

| Comando           | Descrição |
| ----------------- | --- |
| `/ping`           | Responde `Pong!` (verificação de disponibilidade). |
| `/config`         | Configura o canal de apoio e o mínimo de apoios (permissão Gerenciar servidor). |
| `/fundar-partido` | Inicia o fluxo de fundação de um partido político. |

### Configuração eleitoral

Um administrador do servidor deve configurar o canal antes de iniciar o
processo de fundação:

1. `/config canal-apoio canal:#propostas` — canal de texto onde as propostas
   serão publicadas com o botão **Apoiar partido**.
2. `/config minimo-apoios quantidade:5` — número de pessoas distintas
   necessárias para fundar o partido. O valor inicial é 5; o intervalo aceito
   é de 1 a 500.
3. `/config ver` — consulta a configuração atual.

As configurações são independentes por servidor. O comando `/config` exige a
permissão **Gerenciar servidor**.

### Fluxo de `/fundar-partido`

1. **Leitura das regras** — o usuário marca a confirmação e preenche nome,
   sigla e símbolo no mesmo modal.
2. **Programa** — um botão abre o segundo modal com posicionamento político,
   propostas e valores. (Um modal não pode ser respondido com outro modal, por
   isso a etapa intermediária com botão.)
3. **Apoio público** — a proposta é publicada no canal configurado. Cada
   pessoa pode apoiar uma vez, mas o fundador não pode apoiar a própria
   proposta.
4. **Fundação** — ao atingir o mínimo configurado, o partido é registrado no
   SQLite como fundado e o botão de apoio é removido.

Regras aplicadas no caminho: sigla de 2 a 10 caracteres (letras/números),
nome e sigla únicos dentro do servidor, e rascunhos abandonados expiram em
24 h. Uma proposta já enviada ou um partido fundado não pode ser substituído
pelo mesmo fundador no servidor.

## Estrutura

```
src/
├── index.js                    # entrypoint: carrega comandos/eventos e loga
├── deploy-commands.js          # registra os slash commands na API
├── database/
│   ├── index.js                # camada SQLite (better-sqlite3)
│   └── partidos.db             # banco (gerado, fora do Git)
├── events/
│   ├── ready.js
│   └── InteractionCreate.js    # roteia comandos e componentes por customId
└── commands/
    ├── ping.js
    ├── config.js
    └── fundar-partido.js
```

### Como adicionar um comando

Crie `src/commands/meu-comando.js` exportando `data` e `execute`. Para tratar
modais ou botões, exporte também `componentHandlers`, um mapa de `customId`
para função:

```js
module.exports = {
  data: new SlashCommandBuilder().setName('exemplo').setDescription('...'),
  async execute(interaction) { /* ... */ },
  componentHandlers: {
    meu_modal: async (interaction, client) => { /* ... */ }
  }
};
```

O roteamento é automático — `InteractionCreate.js` consulta
`client.componentHandlers` pelo `customId`.
