# Foco de Elite

Plataforma de estudos para o **ENEM**, para a **Academia do Barro Branco / Cadete PM-SP** e para os
**vestibulares** de FUVEST, UNICAMP, UNESP, FGV, Mackenzie e PUC-SP.

O aluno escolhe a prova, informa quantos dias e quantas horas tem para estudar e recebe um cronograma
diário que se ajusta ao desempenho dele. A plataforma reúne videoaulas organizadas por assunto, banco de
questões com resolução, simulados, revisões espaçadas, caderno de erros, anotações, tutor com IA,
correção de redação pelos critérios da prova escolhida, acompanhamento de desempenho, aulas
particulares e assinatura recorrente pelo Stripe. Um painel administrativo completo cuida de todo o
conteúdo, dos alunos, das provas, dos planos e das integrações.

Domínio de produção: **focoelite.com.br**

| Documento | Para que serve |
|-----------|----------------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Contrato técnico: convenções de backend e frontend, catálogo da API, design system, motor do cronograma. |
| [`docs/CONTEUDO.md`](docs/CONTEUDO.md) | Como o conteúdo se organiza (área → matéria → assunto → subassunto → aula) e como operar os seeds. |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Publicação em VPS ou PaaS, Stripe, OpenRouter, SMTP e DNS. |
| [`docs/CHECKLIST-ENTREGA.md`](docs/CHECKLIST-ENTREGA.md) | O que já foi entregue e o que o cliente precisa providenciar. |
| [`docs/ROTEIRO-VIDEO.md`](docs/ROTEIRO-VIDEO.md) | Roteiro da demonstração gravada para o cliente. |
| [`docs/RESUMO-CLIENTE.md`](docs/RESUMO-CLIENTE.md) | Resumo da entrega em linguagem não técnica. |

---

## 1. Stack

| Camada | Tecnologia |
|--------|------------|
| Backend | Node.js 22 (mínimo 20), Express 4, `pg` com SQL puro e parametrizado, `zod`, `jsonwebtoken`, `bcryptjs` |
| Banco | PostgreSQL 16 (mínimo 14) — schema em `server/db/migrations/*.sql` |
| Frontend | HTML, CSS e JavaScript puro (ES modules), sem framework, com roteador próprio |
| Bibliotecas do front | `public/vendor/` (Chart.js, marked, DOMPurify) — servidas do próprio domínio, sem CDN |
| IA | API HTTP do OpenRouter, usada **somente no servidor** (`server/services/ai.js`) |
| Pagamentos | Stripe Checkout, Billing Portal e webhooks (`server/services/stripe.js`) |
| E-mail | nodemailer sobre SMTP (`server/services/mailer.js`) |

Não há etapa de build: o navegador carrega os módulos diretamente. `npm run build:icons` e
`npm run vendor` apenas regeneram, respectivamente, o sprite de ícones e as bibliotecas de
`public/vendor/` a partir de `node_modules`.

---

## 2. Requisitos

* **Node.js 20 ou superior** (recomendado 22 LTS) e npm 10+
* **PostgreSQL 14 ou superior** (recomendado 16), com um banco vazio para a aplicação e, se quiser
  rodar os testes, um segundo banco para testes
* Git

Opcionais, conforme o que for usado:

* Conta no **OpenRouter** com chave de API — necessária para o tutor, para a correção de redação e para a
  geração de temas. Sem a chave, o restante da plataforma funciona normalmente e essas telas informam
  que a IA está indisponível.
* Conta no **Stripe** — necessária para cobrar assinaturas. Sem ela, os planos aparecem, mas o checkout
  responde com uma mensagem clara de integração não configurada.
* Servidor **SMTP** — necessário para enviar o e-mail de recuperação de senha. Em desenvolvimento, sem
  SMTP configurado, o link de recuperação é impresso no console do servidor.

---

## 3. Instalação passo a passo

```bash
# 1. Clonar e instalar as dependências
git clone <url-do-repositorio> focoelite
cd focoelite
npm install

# 2. Criar os bancos de dados
createdb focoelite
createdb focoelite_test          # opcional, só para rodar os testes

# 3. Criar o arquivo de configuração
cp .env.example .env

# 4. Gerar os dois segredos e colar no .env (valores diferentes entre si)
openssl rand -hex 48             # → JWT_SECRET
openssl rand -hex 48             # → ADMIN_JWT_SECRET

# 5. Criar o schema e popular a estrutura base
npm run migrate
npm run check          # confere o que já está configurado e o que falta
npm run seed

# 6. (opcional) Incluir aulas e questões de exemplo para navegar com dados
npm run seed:demo

# 7. Subir o servidor
npm run dev
```

Ainda não existe administrador, e é assim mesmo: abra
`http://localhost:4100/admin/login` e a própria tela pede nome, e-mail e senha
para criar a primeira conta. As credenciais ficam guardadas no banco.

Com isso no ar:

| Endereço | O que é |
|----------|---------|
| `http://localhost:4100/` | Landing pública |
| `http://localhost:4100/cadastro` | Cadastro do aluno |
| `http://localhost:4100/app` | Área do aluno |
| `http://localhost:4100/admin/login` | Entrada do painel administrativo |

O painel administrativo tem login **separado** do login do aluno: um aluno nunca recebe sessão de
administrador, mesmo que digite a URL do painel.

---

## 4. Variáveis de ambiente

Todas ficam em `.env` na raiz (o arquivo está no `.gitignore` e **nunca** deve ser versionado). O
modelo comentado é o `.env.example`. A validação acontece em `server/config.js`: se alguma variável
estiver fora do formato esperado, o servidor não sobe e a mensagem diz exatamente qual é o problema.

### Aplicação

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `NODE_ENV` | `development` | `development`, `test` ou `production`. Em produção os segredos passam a ser obrigatórios e fortes, os cookies viram `Secure` e o CSP ativa `upgrade-insecure-requests`. |
| `PORT` | `80` na Square Cloud, `4100` no resto | Porta em que o Node escuta. Sem valor definido, a aplicação usa 80 quando reconhece a Square Cloud (que só roteia o tráfego para essa porta) e 4100 nos outros casos. Um valor explícito sempre vence. |
| `HOST` | `0.0.0.0` | Interface em que o Node escuta. A Square Cloud exige `0.0.0.0`; ligar em `localhost` faz o site dar timeout sem erro no log. |
| `APP_URL` | `http://localhost:4100` | URL pública da aplicação. Usada nos links de e-mail e nos retornos do Stripe Checkout. Em produção: `https://focoelite.com.br`. |
| `BRAND_NAME` | `Foco Elite` | Nome usado em logs e no título das páginas. O nome comercial exibido ao aluno é a configuração `brand_name`, editável no painel. |
| `TRUST_PROXY` | `1` em produção | Diz ao Express que há um proxy reverso na frente, para que o IP real chegue ao rate limit. Aceita `true`, `false`, um número de saltos ou `loopback`. |

### Banco de dados

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `DATABASE_URL` | — | Obrigatória. String de conexão do PostgreSQL, ex.: `postgres://focoelite:senha@localhost:5432/focoelite`. |
| `DATABASE_URL_TEST` | — | Obrigatória quando `NODE_ENV=test`. Aponta para um banco **separado**: o schema dele é recriado a cada execução dos testes. |
| `PGSSL` | `false` | `true` quando o banco exige TLS (Neon, Supabase, RDS e afins). |
| `PGSSL_CERT` | — | Certificado do cliente do PostgreSQL gerenciado da Square Cloud, que recusa conexão em texto puro. É o `certificate.pem` que eles entregam, com certificado e chave no mesmo arquivo. Aceita texto ou base64. |
| `PGSSL_CA` | — | A autoridade certificadora, o `ca-certificate.crt` que vem junto. Permite conferir o servidor de verdade; sem ela, o próprio certificado do cliente vira a âncora. |
| `PGSSL_CERT_FILE` / `PGSSL_CA_FILE` | — | Alternativa às duas anteriores: o caminho do arquivo dentro do projeto, em vez do conteúdo. |

### Segurança

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `JWT_SECRET` | — | Assina o cookie de sessão do aluno (`fe_session`). Em produção precisa ter ao menos 32 caracteres aleatórios. |
| `ADMIN_JWT_SECRET` | — | Assina o cookie de sessão do administrador (`fe_admin`). **Precisa ser diferente** de `JWT_SECRET` — o servidor recusa subir se forem iguais. |
| `COOKIE_SECURE` | `true` em produção | Marca os cookies como `Secure` (só trafegam por HTTPS). Deixe `false` apenas em desenvolvimento local. |
| `BCRYPT_ROUNDS` | `12` | Custo do bcrypt no hash das senhas. Só reduza em ambiente de teste. |

### OpenRouter

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `OPENROUTER_API_KEY` | vazio | Chave criada em [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). Fica **apenas** no servidor: nunca é enviada ao navegador nem exibida no painel (o administrador vê somente o status e os últimos caracteres). Vazia, o tutor e a correção de redação respondem "IA indisponível". |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint da API. Normalmente não precisa ser alterado. |
| `OPENROUTER_MODEL` | `google/gemini-3.8-flash` | Modelo do tutor e das tarefas leves. Pode ser sobrescrito pela configuração `openrouter_model` no painel. |
| `OPENROUTER_ESSAY_MODEL` | `anthropic/claude-sonnet-5` | Modelo usado na correção de redação, que exige mais qualidade. Configuração equivalente no painel: `openrouter_essay_model`. |
| `OPENROUTER_MONTHLY_TOKEN_LIMIT` | `5000000` | Teto de tokens por mês somando todos os alunos. Ao ser atingido, as funções de IA passam a recusar novas chamadas com mensagem clara, protegendo a fatura. `0` desliga o limite. |

### Stripe

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `STRIPE_SECRET_KEY` | vazio | Chave secreta da conta. Sem ela, checkout e portal respondem 503 com mensagem ao aluno. |
| `STRIPE_WEBHOOK_SECRET` | vazio | Segredo do endpoint de webhook, usado para validar a assinatura de cada evento recebido. Sem ele, o webhook é recusado. |
| `STRIPE_PUBLISHABLE_KEY` | vazio | Chave pública. Só é necessária se a interface passar a montar elementos do Stripe no navegador. |
| `REQUIRE_SUBSCRIPTION` | `false` | `true` exige assinatura ativa para o aluno usar a plataforma (perfil e tela de assinatura continuam liberados). Também existe como configuração `require_subscription` no painel. |

### E-mail

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `SMTP_HOST` | vazio | Servidor SMTP. Vazio, os e-mails não são enviados e o link de recuperação de senha é impresso no console. |
| `SMTP_PORT` | `587` | Porta do servidor. `587` para STARTTLS, `465` para TLS direto. |
| `SMTP_USER` / `SMTP_PASS` | vazio | Credenciais de autenticação do SMTP. |
| `SMTP_SECURE` | `true` quando a porta é 465 | Força ou desliga o TLS direto, quando o provedor exigir. |
| `SMTP_FROM` | `Foco Elite <no-reply@focoelite.com.br>` | Remetente exibido. Precisa ser um endereço autorizado no domínio (SPF/DKIM) para não cair em spam. |

### Primeiro administrador

Não há variável de ambiente a preencher. Enquanto o banco não tiver nenhum
administrador, `/admin/login` mostra a tela de configuração inicial: quem abrir
primeiro cria a conta ali e entra já autenticado. Depois disso a tela volta a
ser o login normal e a rota de criação passa a recusar novas contas.

As variáveis abaixo servem só para repor o acesso pelo terminal, com
`npm run create-admin`, se a senha se perder. Deixe-as vazias no uso normal.

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `ADMIN_EMAIL` | — | E-mail usado por `npm run create-admin` (ou `--email`). |
| `ADMIN_PASSWORD` | — | Senha, mínimo de 8 caracteres (ou `--password`). |
| `ADMIN_NAME` | `Administrador` | Nome exibido no painel. |

---

## 5. Comandos disponíveis

| Comando | O que faz |
|---------|-----------|
| `npm run dev` | Sobe o servidor com recarga automática ao alterar arquivos de `server/`. |
| `npm start` | Sobe o servidor sem recarga (é o comando usado em produção). |
| `npm run migrate` | Aplica as migrations pendentes de `server/db/migrations/` em ordem, cada uma dentro de uma transação, registrando o que já foi aplicado em `schema_migrations`. Rodar de novo não repete nada. |
| `npm run seed` | Popula a estrutura base: configurações, provas, áreas, matérias, assuntos e subassuntos, pesos por prova, critérios e temas de redação e planos. É idempotente. |
| `npm run seed:demo` | Faz o mesmo e ainda cria conteúdo de demonstração (aulas, questões, um professor e modelos de simulado) para navegar com dados. |
| `npm run setup` | Atalho para `migrate` seguido de `seed`. |
| `npm run create-admin` | Cria o administrador a partir do `.env`, ou atualiza o existente. Aceita `--email`, `--password` e `--name`. |
| `npm test` | Roda toda a suíte de testes de integração no banco de testes. |
| `npm run build:icons` | Regenera `public/assets/icons.svg` a partir do pacote `lucide-static`. |
| `npm run vendor` | Recopia Chart.js, marked e DOMPurify de `node_modules` para `public/vendor/`. |

O runner de seed aceita ainda algumas opções úteis na operação:

```bash
node server/db/seed/run.js --force            # sobrescreve também o que o painel administra
node server/db/seed/run.js --force-criteria   # restaura só os critérios de redação
node server/db/seed/run.js --force-plans      # restaura só os planos
node server/db/seed/run.js --force-settings   # restaura só as configurações
node server/db/migrate.js --reset             # recria o schema do zero (só em teste, ou com --force)
```

---

## 6. Estrutura de pastas

```
server/
  index.js               sobe o servidor, conecta ao banco e trata o encerramento
  app.js                 fábrica do Express: segurança, parsers, CSRF, montagem das rotas, estáticos, erros
  config.js              lê e valida o .env; exporta um objeto congelado
  db/
    pool.js              pool do pg e atalhos: query, one, many, tx
    migrate.js           runner de migrations
    migrations/          001_init.sql e as migrations seguintes
    seed/run.js          seed idempotente
    seed/data/           dados estruturais: provas, áreas, matérias, assuntos, pesos, critérios, planos
  middleware/
    auth.js              requireStudent, requireAdmin, optionalUser
    access.js            requireAccess: bloqueia aluno sem assinatura quando exigido
    validate.js          validação com zod, populando req.valid
    errors.js            AppError, wrap, notFound, errorHandler (grava 5xx em error_logs)
    rateLimit.js         limitadores de login, de IA e da API em geral
    audit.js             registro das ações administrativas em audit_logs
  routes/                uma rota por módulo; admin/ fica sob requireAdmin
  services/              regras reutilizáveis: schedule, reviews, stats, questions, progress,
                         simulados, ai, essay, stripe, mailer, settings
  utils/                 funções puras: slug, datas, vídeo, paginação, tokens
public/
  index.html             landing pública
  login.html cadastro.html recuperar-senha.html redefinir-senha.html
  app.html               área do aluno (SPA em /app/*)
  admin.html admin-login.html   painel administrativo (/admin/*)
  css/                   tokens, base, componentes, layout, utilitários e um arquivo por página
  js/core/               api, router, store, ui, icons, charts, markdown, format
  js/components/         question-runner, video-player, notes-editor, calendar, data-table, form
  js/app/                shell, rotas e páginas do aluno
  js/admin/              shell, rotas e páginas do painel
  assets/                logo, favicon, sprite de ícones, capa de compartilhamento
  vendor/                Chart.js, marked e DOMPurify servidos do próprio domínio
scripts/                 create-admin, build-icons, vendor
tests/                   testes de integração (node:test)
docs/                    guias de conteúdo, deploy, entrega e demonstração
```

---

## 7. Como rodar os testes

Os testes são de integração: sobem o app de verdade, recriam o schema no banco de testes e conversam
com a API por HTTP. Não usam mocks de banco.

```bash
createdb focoelite_test                       # uma única vez
# garanta DATABASE_URL_TEST no .env
npm test                                      # suíte completa

NODE_ENV=test node --test tests/schedule.test.js   # um arquivo específico
```

> O banco apontado por `DATABASE_URL_TEST` tem o schema **recriado** a cada execução. Nunca aponte
> essa variável para o banco de produção ou de desenvolvimento.

Os utilitários de `tests/helpers.js` (`createTestContext`, `registerStudent`, `loginAdmin`, `request`,
`resetDb`) montam o cenário de cada teste. Além dos testes de cada módulo, `tests/static.test.js` faz
uma verificação estática do frontend: confere se as páginas respondem, se todos os módulos ES têm
sintaxe válida, se cada import relativo aponta para um arquivo existente que realmente exporta aquele
nome e se as páginas listadas nos manifestos de rotas existem.

---

## 8. Como criar o administrador

O painel não tem tela de auto-cadastro: administradores são criados pela linha de comando, no servidor.

```bash
# a partir das variáveis do .env
npm run create-admin

# ou informando tudo na hora
node scripts/create-admin.js --email guilherme@focoelite.com.br --password 'senha-forte-aqui' --name 'Guilherme'
```

Se o e-mail já existir, o script atualiza o nome e a senha, promove a conta a `admin`, desbloqueia o
acesso e encerra todas as sessões anteriores daquele usuário. A senha precisa ter no mínimo 8
caracteres, e em produção o script recusa a senha de exemplo do `.env.example`.

---

## 9. Como o conteúdo se organiza

```
Área  →  Matéria  →  Assunto  →  Subassunto  →  Aula
```

Uma aula existe **uma única vez** e é ligada às provas em que cai, em vez de ser duplicada por prova.
Três tabelas de ligação fazem esse trabalho: `exam_topics` (em quais provas o assunto cai e com qual
peso), `lesson_exams` (em quais provas a aula é relevante) e `question_exams` (em quais provas a questão
faz sentido). Assim, "Porcentagem" é cadastrada uma vez em Matemática e aparece tanto para quem estuda
para o ENEM quanto para quem estuda para o Barro Branco.

O cronograma usa essa estrutura para decidir o que agendar: o peso da matéria na prova, o quanto do
conteúdo já foi concluído, a taxa de acerto do aluno naquele assunto e a proximidade da data da prova
entram na mesma pontuação. Aula concluída gera revisões em 1, 7 e 30 dias; assunto com acerto abaixo de
60% volta à fila com prioridade.

O detalhamento completo — incluindo os níveis, as chaves de idempotência, o conteúdo de demonstração e
as boas práticas de cadastro — está em [`docs/CONTEUDO.md`](docs/CONTEUDO.md).

---

## 10. Segurança

* **Sessões separadas.** O aluno recebe o cookie `fe_session` e o administrador o cookie `fe_admin`,
  assinados por segredos diferentes e obrigatoriamente distintos. Um aluno nunca obtém sessão de
  administrador. Os cookies são `httpOnly`, `SameSite=Lax` e `Secure` em produção, com validade de 7
  dias.
* **Revogação de sessão.** Cada usuário tem um `token_version`; ao trocar a senha, bloquear a conta ou
  recriar o administrador, o número muda e todas as sessões antigas deixam de valer imediatamente.
* **Senhas.** Guardadas apenas como hash bcrypt com custo 12, mínimo de 8 caracteres. O `password_hash`
  nunca sai do servidor em nenhuma resposta.
* **Proteção contra CSRF.** Toda requisição que altera dados (POST, PUT, PATCH, DELETE) exige o
  cabeçalho `X-Requested-With: FocoElite`, verificado em `server/app.js`. A única exceção é o webhook do
  Stripe, que é autenticado pela assinatura criptográfica do próprio Stripe.
* **Escopo por usuário.** Toda consulta a dados do aluno filtra por `user_id`. Um aluno não consegue ler
  nem alterar cronograma, redação, anotação ou histórico de outro, mesmo trocando o identificador na URL.
* **SQL parametrizado.** Não há concatenação de valores em SQL em lugar nenhum do projeto; todo valor
  entra por `$1, $2, ...`.
* **Validação de entrada.** Todo corpo, parâmetro e query passa por um schema `zod` antes de chegar à
  regra de negócio. Erro de validação vira uma resposta 400 padronizada, com o campo problemático.
* **Rate limit.** Login e recuperação de senha aceitam 10 tentativas por IP a cada 15 minutos; as rotas
  de IA, 30 chamadas por minuto por aluno; a API em geral, 600 requisições por IP a cada 15 minutos.
* **Cabeçalhos e CSP.** O Helmet aplica uma Content Security Policy restritiva: scripts e estilos do
  próprio domínio, mídia apenas do armazenamento da plataforma, conexões apenas para o próprio domínio e
  para o Stripe. Não há CDN de terceiros: as bibliotecas do front são servidas de `public/vendor/`.
* **Segredos fora da interface.** As chaves do OpenRouter, do Stripe e do SMTP vivem apenas em variáveis de
  ambiente, no servidor. O painel mostra somente o status da integração e os últimos caracteres da
  chave; nenhuma chave chega ao navegador em nenhum momento. Toda chamada de IA sai do backend.
* **Teto de gasto com IA.** O consumo de tokens é registrado por chamada e comparado ao limite mensal
  configurado, evitando surpresa na fatura do OpenRouter.
* **Auditoria e registro de erros.** Toda escrita administrativa é gravada em `audit_logs` com autor,
  ação, entidade e dados; erros 5xx vão para `error_logs` com caminho, usuário e stack. O aluno recebe
  apenas uma mensagem genérica, sem detalhes internos.
* **Pagamento fora da plataforma.** Nenhum dado de cartão passa pelo servidor: a cobrança acontece no
  Stripe Checkout e a gestão da assinatura, no Billing Portal do próprio Stripe.
