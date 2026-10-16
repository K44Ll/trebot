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
   | `ROTEIA_KEY` | Chave da API Roteia (opcional; usada pelo assistente eleitoral) |

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

5. Para habilitar respostas ao mencionar o bot, ative **Message Content Intent**
   no Developer Portal e defina `ROTEIA_KEY` no `.env`. O bot usa o modelo
   `nvidia/nemotron-3.5-lightning:free`, consulta `src/database/TRE.MD` e só
   responde quando consegue fundamentar a resposta em artigos desse código;
   perguntas fora do escopo eleitoral são recusadas. O contexto recente é
   separado por usuário e canal, mantido apenas enquanto o processo está ativo
   e expira após uma hora. As mensagens mencionadas são enviadas à API Roteia.

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
| `/proposta` | Apresenta sugestões legislativas/denúncias, apoia iniciativas, acompanha etapas e oferece cédulas privadas. |
| `/configleicomplementar` | Configura composição parlamentar, cargos, sessão constitucional e parâmetros da simulação (administradores). |

### Sistema legislativo (`/proposta`)

`/proposta criar` abre um modal para PEC, PL, PLP ou denúncia por crime de
responsabilidade. As proposições são sugestões até decisão de admissibilidade.
Use `/proposta apoiar` para assinaturas populares ou apoios parlamentares;
`/proposta consultar` mostra texto, justificativa e histórico. Administradores
decidem a admissibilidade, iniciam e encerram votações; `/proposta votar` abre
uma cédula efêmera quando uma DM não foi entregue. O voto também pode ser
registrado pelos botões enviados por DM. `/proposta alterar-texto` registra a
redação revisada pela Casa revisora antes da votação dessa etapa.

Etapas implementadas: PEC em quatro turnos e quórum de 3/5; PL e PLP em duas
Casas com maioria simples ou absoluta, respectivamente, e decisão presidencial
de sanção/veto total ou parcial; vetos são apreciados pelas duas Casas e só
são rejeitados com maioria absoluta em cada uma. Quando a Casa revisora altera
o texto, a votação dessa redação encaminha o projeto à Casa iniciadora para
votação adicional antes da sanção. Impeachment presidencial exige autorização
da Câmara e julgamento do Senado por 2/3. Só proposições concluídas são
publicadas no canal legislativo. Denúncias nunca são publicadas como lei. A
composição da Casa é congelada em cada votação; vagas não preenchidas contam
como ausências frente ao total configurado. Votos, apurações e auditoria
persistem em SQLite e interações concorrentes são serializadas por transações.

#### Configuração e limites jurídicos

1. Ative **Server Members Intent** no Developer Portal e configure o intent no
   bot. Ele é necessário para conferir a composição e o mandato no momento do
   voto.
2. Execute `/configleicomplementar composicao` (padrão: 513 deputados e 81
   senadores) e `/configleicomplementar cargos`. O número de membros com o
   cargo pode ser menor que a composição configurada; os assentos vagos contam
   no denominador do quórum e não podem votar. Não pode ultrapassar o total
   configurado.
3. Configure `/configleicomplementar estado-constitucional`, `/prazo` e, quando
   necessário, `/iniciativa-popular`. O padrão popular de 1.000.000 apoiamentos
   impede que uma submissão cidadã individual seja tratada como iniciativa
     formal. Na simulação, a contagem popular não verifica distribuição por
     estados nem proporção do eleitorado federal; o administrador deve configurar
     o patamar adequado ao servidor.

Para impeachment, selecione a conta Discord da autoridade denunciada e informe
seu cargo no modal. A admissibilidade só aceita o Presidente atualmente
associado ao cargo configurado; outros ritos não estão habilitados. Uma
condenação pelo Senado remove o cargo presidencial, registra oito anos de
inabilitação e bloqueia novas candidaturas/decisões pendentes no sistema
eleitoral. Eleições já abertas com listas de candidatos congeladas não são
alteradas retroativamente. O campo de provas aceita URLs; anexos binários
diretos do Discord não são capturados pelo modal.

Uma PEC exige autoria presidencial ou apoio autenticado de pelo menos 1/3 dos
membros de uma das Casas configuradas. Veto parcial permite registrar até 20
dispositivos integrais copiados exatamente do texto (cada um deve iniciar com
identificador de artigo, parágrafo, inciso ou alínea); a publicação remove o
trecho vetado. A análise automatizada não consegue certificar que o texto
fornecido corresponde à unidade jurídica completa, portanto a autoridade
responsável deve revisar isso antes da decisão. A Casa revisora pode registrar
uma redação consolidada, votá-la e enviá-la à Casa iniciadora; diferenças
específicas de tramitação de emendas, rejeição apenas de emendas e retorno de
textos não consolidados dependem de deliberação administrativa. O rito de
impeachment de outros cargos, iniciativa de Assembleias Legislativas e
comissões, e reapresentação de matéria substancialmente semelhante dependem de
instituições/dados não existentes e não são simulados. A análise
dos limites materiais do art. 60 é uma decisão de admissibilidade humana, não
uma classificação automática do texto. A simulação presidencial cobre as
etapas fundamentais, mas não substitui a Lei nº 1.079/1950 nem assessoria
jurídica. Os canais de publicação e anúncios são os IDs definidos pelo
servidor no código.

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
│   ├── eleicao.js              # comando /eleicao e handlers da urna
│   ├── proposta.js             # proposições, tramitação e cédulas legislativas
│   └── configleicomplementar.js # composição e regras legislativas
├── database/
│   ├── index.js                # partidos, filiações e cadastro (partidos.db)
│   ├── eleicoes.js             # eleições, votos, apuração e agendamento (eleicoes.db)
│   └── legislativo.js          # proposições, votos parlamentares e auditoria
│   ├── partidos.db             # banco de partidos
│   └── eleicoes.db             # banco relacional de eleições
├── services/
│   ├── legislativo/
│   │   ├── quorum.js            # regras centrais de presença e aprovação
│   │   ├── fluxo.js             # etapas de PEC, PL, PLP e impeachment
│   │   └── sistema.js           # elegibilidade, votação e publicação
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
