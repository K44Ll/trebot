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

## Painel web administrativo

O painel é opcional e só inicia quando `ADMIN_PASSWORD` está definida. Escolha
uma senha aleatória com pelo menos 16 caracteres no `.env`; depois de iniciar o
bot, o console exibe um resumo animado com as rotas disponíveis. Acesse
`http://localhost:3000`. O painel permite selecionar servidores
onde o bot está conectado, consultar propostas/apoios/partidos fundados e
configurar o canal de apoio e o número mínimo de apoios.

Rotas: `GET /login` e `POST /login` são públicas (login com limite de
tentativas); `GET /` requer sessão administrativa; `POST /config` e
`POST /logout` requerem sessão e token CSRF. As demais rotas retornam 404.

`ADMIN_HOST` e `ADMIN_PORT` alteram a interface e a porta de escuta. O padrão
é `127.0.0.1:3000`, acessível somente na máquina do bot. Para acesso remoto,
mantenha `ADMIN_COOKIE_SECURE=true`, coloque o painel atrás de um proxy com
HTTPS e restrinja o acesso pela rede. Não exponha o painel diretamente à
internet nem desative o atributo `Secure` em uma conexão pública. A senha não
é armazenada no banco; sessões expiram após 8 horas.

O painel valida `Origin` contra o `Host` e, quando há proxy reverso, também
contra `X-Forwarded-Host`. Se o proxy não enviar esse cabeçalho e o formulário
responder **“Origem da requisição inválida”**, preencha `ADMIN_PUBLIC_ORIGIN`
com a origem exibida no navegador, incluindo esquema e porta se houver, sem
caminho (por exemplo, `https://trebot.exemplo.com`). Nesse caso, só essa origem
exata será aceita nos formulários POST.

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
| `/config`         | Configura apoios e cria eleições (permissão Gerenciar servidor). |
| `/fundar-partido` | Inicia o fluxo de fundação de um partido político. |
| `/filiar` | Solicita filiação a um partido fundado. |
| `/pedidos-filiacao` | Permite ao fundador aceitar ou recusar filiações. |
| `/candidatar` | Solicita candidatura em uma eleição, escolhendo cargo e complemento do número. |
| `/pedidos-candidatura` | Permite ao fundador aceitar ou recusar candidaturas. |
| `/eleicao` | Sistema eleitoral completo com Urna Eletrônica (criar, iniciar, votar, encerrar, resultados, status, cancelar). |

### Sistema Eleitoral e Urna Eletrônica (`/eleicao`)

Inspirado no funcionamento das urnas eletrônicas brasileiras do TSE, o comando `/eleicao` gerencia eleições completas com votação em cédula única e privada por cargo.

#### Subcomandos:
- `/eleicao criar`: Cria uma nova eleição com nome, eleição base de candidatos (`partidos.db`), eleitorado (`todos` ou `filiados`), publicação parcial e duração em minutos. Apenas administradores.
- `/eleicao iniciar`: Abre a votação da eleição e publica a mensagem oficial da cabine de votação com o botão interativo para os eleitores. Apenas administradores.
- `/eleicao votar`: Abre diretamente a interface privada e efêmera da Urna Eletrônica. Disponível para todos os eleitores autorizados.
- `/eleicao encerrar`: Encerra a votação, consolida a apuração dos votos no SQLite e, caso presidente ou governador não atinjam mais de 50% dos votos válidos, agenda automaticamente o segundo turno para 10 minutos após a apuração. Apenas administradores.
- `/eleicao resultados`: Consulta os dados consolidados e a situação da disputa por cargo (se a publicação parcial estiver desativada, somente administradores podem consultar antes do encerramento).
- `/eleicao status`: Exibe o estado geral das eleições e o comparecimento de eleitores.
- `/eleicao cancelar`: Cancela a eleição e seus agendamentos com registro de auditoria e justificativa obrigatória. Apenas administradores.

#### Funcionamento da Urna Eletrônica
A urna apresenta um visor dinâmico e 5 fileiras de botões no Discord:
- Fileira 1 a 3: Botões numéricos de `1` a `9`.
- Fileira 4: Botões `BRANCO` e `0`.
- Fileira 5: Botões `CORRIGE` (vermelho) e `CONFIRMA` (verde).
- **Ordem de cargos:** proporcional antes de majoritário (Deputado Federal → Senador → Governador → Presidente).
- **Dígitos:** Presidente (2), Governador (2), Senador (3), Deputado Federal (4), Deputado Estadual (6). Zeros à esquerda são preservados como strings.
- **Voto Branco:** selecionado explicitamente pelo botão `BRANCO` e confirmado.
- **Voto Nulo:** número incorreto ou candidato inexistente confirmado pelo eleitor.
- **Proteção contra concorrência:** transações imediatas no SQLite e travas de interação impedem duplicação de votos ou confirmação repetida do mesmo cargo.
- Ao concluir todos os cargos, a tela exibe a mensagem `GRAVANDO VOTO... FIM 🗳️` e tenta enviar uma DM discreta sem expor as escolhas individuais.

#### Regras de Segundo Turno
- Aplica-se exclusivamente aos cargos majoritários de **Presidente** e **Governador**.
- Se o candidato líder obtiver **mais de 50% dos votos válidos** (excluindo brancos e nulos), é declarado eleito no primeiro turno.
- Caso contrário, os dois candidatos mais votados se classificam para o 2º turno, agendado para 10 minutos após a apuração.
- **Critério de desempate:** maior número de votos; persistindo empate, avança o candidato com menor ID de cadastro (registro mais antigo no sistema). O motivo é auditado e gravado no banco de dados.
- O agendamento é persistido na tabela `agendamentos` do SQLite. Caso o bot reinicie durante a espera, a rotina recupera o agendamento no evento `ready` e abre o segundo turno no momento exato.

#### Sigilo e Limitações do Sistema no Discord
> [!IMPORTANT]
> **Aviso de Sigilo e Auditoria:**
> Este sistema é uma simulação para comunidades no Discord e **não equivale à segurança ou ao sigilo oficial do Tribunal Superior Eleitoral (TSE)**.
> - O conteúdo do voto (tabela `votos`) não armazena o ID do eleitor; o controle de participação fica na tabela separada `eleitores_cargos`.
> - Administradores com acesso direto ao arquivo do banco SQLite (`eleicoes.db`) podem teoricamente correlacionar votos pela ordem temporal de inserção nas transações.
> - A identidade do eleitor baseia-se no ID do Discord, sujeito a invasões de conta ou permissões do servidor.

## Estrutura

```
src/
├── index.js                    # entrypoint: carrega comandos/eventos e loga
├── deploy-commands.js          # registra os slash commands na API
├── commands/
│   ├── ping.js
│   ├── config.js
│   ├── fundar-partido.js
│   ├── filiar.js
│   ├── pedidos-filiacao.js
│   ├── candidatar.js
│   ├── pedidos-candidatura.js
│   └── eleicao.js              # comando /eleicao e handlers da urna
├── database/
│   ├── index.js                # partidos, filiações e cadastro (partidos.db)
│   ├── eleicoes.js             # eleições, votos, apuração e agendamento (eleicoes.db)
│   ├── partidos.db             # banco de partidos
│   └── eleicoes.db             # banco relacional de eleições
├── services/
│   └── eleicoes/
│       ├── candidatos-service.js   # leitura e congelamento de candidaturas
│       ├── permissoes-service.js   # validação admin, eleitorado e auditoria
│       ├── apuracao-service.js     # regras de 1º/2º turno e desempate
│       ├── scheduler-service.js    # agendamentos com resiliência a reboot
│       └── urna-service.js         # construtor da urna e sessão de votação
├── events/
│   ├── ready.js
│   └── InteractionCreate.js    # roteia comandos e componentes por customId
├── ui/
│   └── console.js              # banner animado e resumo de inicialização
└── web/
    └── admin.js                # painel web e endpoints administrativos
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
