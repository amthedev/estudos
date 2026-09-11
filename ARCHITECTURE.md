# Foco Elite — Arquitetura e convenções

Plataforma de estudos (ENEM, Academia do Barro Branco / Cadete PM-SP e outros vestibulares) com
cronograma adaptativo, aulas, questões, simulados, redação e tutor com IA, assinaturas via Stripe e
painel administrativo completo. Nome comercial: **Foco de Elite**. Domínio de produção: **focoelite.com.br**.

Este documento é o contrato entre todos os módulos. Quem escreve código lê isto antes.

---

## 1. Stack e execução

| Camada     | Tecnologia                                                                 |
|------------|-----------------------------------------------------------------------------|
| Backend    | Node.js 22, Express 4, `pg` (SQL puro, parametrizado), `zod`, `jsonwebtoken`, `bcryptjs` |
| Banco      | PostgreSQL 16 — schema em `server/db/migrations/*.sql`, seeds em `server/db/seed/` |
| Frontend   | HTML + CSS + JavaScript puro (ES modules), sem framework. SPA leve com roteador próprio |
| Libs front | `public/vendor/` (Chart.js, marked, DOMPurify) — sem CDN                    |
| IA         | Cliente HTTP do OpenRouter, **somente no backend** (`server/services/ai.js`)     |
| Pagamentos | Stripe Checkout + Billing Portal + Webhooks (`server/services/stripe.js`)    |
| E-mail     | nodemailer (SMTP). Sem SMTP em dev → link impresso no console                |

Comandos:

```bash
npm run migrate        # aplica migrations pendentes (tabela schema_migrations)
npm run seed           # estrutura base: provas, áreas, matérias, assuntos, critérios de redação, planos, settings
npm run seed:demo      # + conteúdo de demonstração (aulas e questões de exemplo) — opcional
npm run create-admin   # repõe o acesso ao painel pelo terminal (o admin normal se cria na própria tela)
npm run dev            # servidor com reload em http://localhost:4100
npm test               # testes de integração (usa DATABASE_URL_TEST, recria o schema)
```

Porta padrão local: **4100** (a 3000 está ocupada nesta máquina).

---

## 2. Estrutura de pastas e responsabilidade

```
server/
  index.js                 sobe o servidor (lê config, cria app, escuta porta)
  app.js                   fábrica do Express: middlewares globais, estáticos, auto-mount de rotas, erros
  config.js                lê .env com validação e defaults; exporta objeto congelado
  db/
    pool.js                pool pg + helpers: query(text, params), one(), many(), tx(fn)
    migrate.js             runner: aplica server/db/migrations/NNN_*.sql em ordem (registra em schema_migrations)
    migrations/            001_init.sql (schema completo). Novas migrations: 010_, 020_… por módulo
    seed/run.js            seed idempotente (upsert por slug); --demo inclui data/demo.js
    seed/data/*.js         dados estruturais (ver §9)
  middleware/
    auth.js                requireStudent, requireAdmin, optionalUser (JWT em cookie httpOnly)
    access.js              requireAccess: bloqueia aluno sem assinatura quando REQUIRE_SUBSCRIPTION=true
    validate.js            validate({ body, query, params }) com zod → req.valid
    errors.js              AppError, notFound, errorHandler (loga em error_logs)
    rateLimit.js           limitadores: auth (login), ai (tutor/redação), api geral
    audit.js               audit(req, action, entity, entityId, data)
  routes/
    <modulo>.js            exporta { basePath: '/api/<modulo>', router }
    admin/<modulo>.js      exporta { basePath: '/api/admin/<modulo>', router } (já protegidas por requireAdmin)
  services/                regras de negócio reutilizáveis (schedule, reviews, stats, ai, essay, stripe, mailer, search, settings)
  utils/                   helpers puros (slug, dates, video, pagination, tokens)
public/
  index.html               landing pública
  login.html cadastro.html recuperar-senha.html redefinir-senha.html   páginas de autenticação do aluno
  app.html                 shell do aluno (SPA) — rotas /app/*
  admin.html admin-login.html   shell do painel administrativo — rotas /admin/*
  css/
    tokens.css base.css components.css layout.css utilities.css
    auth.css landing.css app.css admin.css
    pages/<pagina>.css     estilos específicos (importados por app.css / admin.css)
  js/
    core/ api.js router.js store.js ui.js icons.js charts.js markdown.js format.js
    components/ question-runner.js video-player.js notes-editor.js calendar.js data-table.js form.js
    app/ shell.js routes.js pages/<pagina>.js
    admin/ shell.js routes.js pages/<pagina>.js
    auth.js landing.js
  assets/ logo.svg logo-mark.svg icons.svg favicon.svg
  vendor/ chart.umd.js marked.umd.js purify.min.js
scripts/ create-admin.js build-icons.js vendor.js
tests/   *.test.js (node --test)
docs/    manual do administrador, guia de deploy, guia de conteúdo
```

Regra de ouro: **cada módulo escreve apenas nos arquivos que lhe pertencem**. Arquivos compartilhados
(`app.js`, `routes.js`, `app.css`, `admin.css`) já listam todos os módulos; um módulo só cria os
arquivos que o manifesto espera.

---

## 3. Backend — convenções

### 3.1 Rotas e auto-mount
`server/app.js` carrega todos os arquivos de `server/routes/*.js` e `server/routes/admin/*.js`.
Cada arquivo exporta:

```js
const router = require('express').Router();
// ...
module.exports = { basePath: '/api/lessons', router };
```

Rotas em `routes/admin/` são montadas **depois** de `requireAdmin` (o app aplica em `/api/admin`).
Rotas de aluno aplicam `requireStudent` (e `requireAccess` quando faz sentido) explicitamente no
próprio router: `router.use(requireStudent, requireAccess)`.

### 3.2 Handlers
Sempre `async` e envolvidos por `wrap()` (de `middleware/errors.js`) — nada de try/catch repetitivo:

```js
router.get('/:id', validate({ params: z.object({ id: z.string().uuid() }) }), wrap(async (req, res) => {
  const lesson = await db.one('SELECT ... WHERE id = $1 AND active', [req.valid.params.id]);
  if (!lesson) throw new AppError(404, 'not_found', 'Aula não encontrada');
  res.json(lesson);
}));
```

### 3.3 Formato de resposta
* Sucesso: **o dado direto** (objeto ou array) com status 200/201. Listas paginadas:
  `{ items, total, page, limit }`.
* Erro: `{ error: { code, message, details? } }` com status HTTP adequado.
  Códigos: `validation_error` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404),
  `conflict` (409), `payment_required` (402), `rate_limited` (429), `ai_unavailable` (503), `internal` (500).
* Mensagens de erro em português, curtas, voltadas ao usuário.
* Datas em ISO 8601 (o pg devolve `Date`; o JSON serializa). Datas sem hora (`date`) são strings `YYYY-MM-DD`
  (pool configurado com parser para tipo DATE → string).

### 3.4 Autenticação
* Aluno: `POST /api/auth/login` → cookie `fe_session` (JWT, httpOnly, SameSite=Lax, Secure em prod, 7 dias).
  Payload: `{ sub: userId, scope: 'student', tv: token_version }`.
* Admin: `POST /api/admin/auth/login` → cookie `fe_admin` (JWT com `ADMIN_JWT_SECRET`, `scope: 'admin'`).
  Só usuários com `role = 'admin'`. Um aluno **nunca** obtém cookie de admin.
* `requireStudent` valida cookie `fe_session`, carrega `req.user` (sem password_hash), rejeita bloqueados e
  token_version divergente; atualiza `last_seen_at` no máximo 1x/5min.
* `requireAdmin` valida `fe_admin`, carrega `req.admin`.
* CSRF: toda requisição mutável (POST/PUT/PATCH/DELETE) exige header `X-Requested-With: FocoElite`
  (checado em `app.js`, exceto `/api/billing/webhook`). O `api.js` do front envia sempre.
* Todas as consultas de dados do aluno filtram por `user_id = req.user.id`. Sem exceções.
* Senhas: bcryptjs custo 12. Mínimo 8 caracteres.
* Rate limit: login/recuperação 10/15min por IP; IA 30/min por usuário; API 600/15min por IP.
* Helmet com CSP: scripts/estilos próprios (`'self'`), frames de YouTube/Vimeo, imagens `https:` e `data:`,
  fontes do Google Fonts, conexões `'self'` (+ Stripe js quando usado).

### 3.5 Banco
`server/db/pool.js`:
```js
const { query, one, many, tx } = require('../db/pool');
const rows = await many('SELECT * FROM subjects WHERE active ORDER BY sort_order');
const row  = await one('SELECT * FROM users WHERE id = $1', [id]);       // null se não existir
await tx(async (client) => { await client.query(...); });               // transação
```
Nomes de colunas seguem o schema (snake_case). O backend devolve snake_case; o front usa snake_case
também (sem conversão) — consistência acima de estética.

### 3.6 Settings (configurações administráveis)
`services/settings.js` → `getSetting(key, default)`, `setSetting(key, value)`, `getAll()`. Cache em
memória com invalidação ao gravar. Chaves iniciais (seed):
`brand_name` ('Foco de Elite'), `logo_url`, `support_email`, `require_subscription`, `openrouter_model`, `openrouter_essay_model`,
`openrouter_monthly_token_limit`, `tutor_system_prompt`, `review_intervals` ([1,7,30]),
`schedule_defaults` ({questions_block_min: 20, review_block_min: 15, essay_weekly: true, simulado_every_days: 14}),
`private_lessons_enabled` (true).
Segredos (chaves OpenRouter/Stripe/SMTP) ficam **apenas** em variáveis de ambiente. O admin vê só status e
os 4 últimos caracteres.

### 3.7 Auditoria e erros
Ações administrativas de escrita chamam `audit(req, 'lesson.update', 'lesson', id, { diff })`.
`errorHandler` grava 5xx em `error_logs` (mensagem, stack, path, user) e responde `internal` sem vazar stack.

---

## 4. Catálogo de API

Prefixo `/api`. Aluno autenticado salvo indicação. `[pub]` = público, `[adm]` = admin.

### auth / onboarding / perfil
* `POST /auth/register` `{name,email,password}` → `{user}` + cookie `[pub]`
* `POST /auth/login` `{email,password}` → `{user}` `[pub]`
* `POST /auth/logout`
* `POST /auth/forgot-password` `{email}` → 200 sempre `[pub]`
* `POST /auth/reset-password` `{token,password}` `[pub]`
* `GET  /auth/me` → `{ user, profile, exam, access: { allowed, reason, subscription } }` (o shell chama ao carregar)
* `PUT  /profile` (nome, metas, disponibilidade…) → `{user, profile}`; ao mudar disponibilidade/prova regenera cronograma
* `PUT  /profile/password` `{current_password,new_password}`
* `POST /onboarding` payload completo do onboarding → salva perfil, `onboarding_completed=true`, gera cronograma
* `GET  /exams` `[pub]` lista provas ativas `{id,slug,name,short_name,track,exam_date,has_essay}`
* `GET  /exams/:id/subjects` matérias e pesos da prova

### conteúdo
* `GET /subjects` → matérias da prova do aluno (ou todas se `?all=1`) com `progress_pct`, `lessons_total`, `lessons_done`
* `GET /subjects/:id` → matéria + `topics[]` (cada um com `lessons_total`, `lessons_done`, `accuracy_pct`)
* `GET /topics/:id` → assunto + `subtopics[]` + `lessons[]` (com `completed`, `favorited`)
* `GET /lessons` `?subject_id&topic_id&status=done|pending&q&page` → paginado
* `GET /lessons/:id` → aula + `exams[]` (onde cai) + `progress` + `note` + `favorited` + `next_lesson`
* `POST /lessons/:id/complete` → marca concluída, registra study_log, agenda revisões, marca item do cronograma; devolve `{ progress, reviews_created }`
* `GET /lessons/:id/practice` → 5 questões do assunto (prioriza subassunto, evita já respondidas recentemente)
* `GET /lessons/continue` → últimas aulas em andamento

### questões
* `GET /questions` filtros `exam_id, subject_id, topic_id, subtopic_id, difficulty, year, board, q, page, limit` → paginado (sem `is_correct` nas alternativas)
* `GET /questions/:id` → questão com alternativas (sem gabarito)
* `POST /questions/:id/answer` `{ option_id, context: 'practice'|'bank'|'review'|'errors_redo', context_id?, time_spent_sec? }`
  → `{ is_correct, correct_option_id, resolution, explanation, attempt_id }`. Erros entram no caderno automaticamente.
* `GET /questions/filters` → anos, bancas, dificuldades disponíveis
* `GET /errors` (caderno) `?subject_id&topic_id&resolved&page` ; `GET /errors/summary`; `POST /errors/redo` `{ids?|subject_id?, limit}` → questões para refazer; `DELETE /errors/:id`

### cronograma / revisões
* `GET  /schedule?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ days: [{date, items:[...], total_min, done_min}] }`
* `GET  /schedule/today` → `{ date, items, next_item, summary }`
* `POST /schedule/generate` → (re)gera a partir de hoje, preservando itens concluídos
* `PATCH /schedule/items/:id` `{ status?, date?, start_time?, position? }` (concluir, reagendar, alterar horário, não realizada)
* `POST /schedule/items` item manual `{date,title,type:'custom',subject_id?,duration_min}`
* `DELETE /schedule/items/:id` (só manuais)
* `POST /schedule/skip-today` → "Não consegui estudar hoje": redistribui pendentes
* `GET  /reviews?status=pending|done&from&to` ; `GET /reviews/:id/questions` ; `POST /reviews/:id/complete` `{score?}` ; `POST /reviews/:id/skip`

### simulados / provas anteriores
* `GET  /simulados` → modelos disponíveis (admin) + resumo de tentativas
* `POST /simulados/attempts` `{ type:'exam'|'subject'|'topic'|'custom', simulado_id?, exam_id?, subject_id?, topic_id?, question_count?, duration_min?, filters? }` → tentativa criada com questões
* `GET  /simulados/attempts` (histórico) ; `GET /simulados/attempts/:id` ; `PATCH /simulados/attempts/:id/answers` `{question_id, option_id}` ; `POST /simulados/attempts/:id/finish` → resultado com `breakdown`
* `GET  /past-exams?exam_id&year` → agrupado por prova/ano

### anotações / favoritos / busca
* `GET /notes?subject_id&topic_id&from&to&q&page` ; `GET /notes/:id` ; `POST /notes` ; `PUT /notes/:id` ; `DELETE /notes/:id`
* `PUT /lessons/:id/note` `{content}` (autosave, upsert)
* `GET /favorites?type=` ; `POST /favorites` `{item_type,item_id}` ; `DELETE /favorites` `{item_type,item_id}`
* `GET /search?q=` → `{ lessons[], questions[], topics[], notes[] }` (máx. 8 por grupo)

### desempenho / dashboard
* `GET /dashboard` → tudo que a tela Início precisa em uma chamada (ver §6)
* `GET /performance` → `{ overall, by_subject[], by_topic[], weekly[], monthly[], hours, lessons_done, simulados[], essays[], strengths[], weaknesses[] }`

### IA
* `GET  /tutor/conversations` ; `POST /tutor/conversations` `{subject_id?,topic_id?,lesson_id?,question_id?}` ; `GET /tutor/conversations/:id` ; `DELETE /tutor/conversations/:id`
* `POST /tutor/conversations/:id/messages` `{content}` → **SSE** (`text/event-stream`): eventos `delta` `{text}`, `done` `{message_id, usage}`, `error` `{message}`
* `GET  /essays/themes?exam_id` ; `POST /essays/themes/generate` `{exam_id}` (IA) ; `GET /essays` ; `POST /essays` `{exam_id, theme_id?, theme_title?, content}` (rascunho) ; `PUT /essays/:id` ; `POST /essays/:id/submit` → corrige com IA (síncrono, até ~60s) ; `GET /essays/:id` ; `GET /essays/stats`
* `GET /essays/criteria?exam_id` → critérios que serão usados (exibidos ao aluno)

### assinatura / aulas particulares
* `GET  /billing/plans` `[pub]` ; `GET /billing/status` ; `POST /billing/checkout` `{plan_id}` → `{url}` ; `POST /billing/portal` → `{url}`
* `POST /billing/webhook` (raw body, assinatura Stripe; sem CSRF/cookie)
* `GET  /tutoring/teachers?subject_id` ; `GET /tutoring/teachers/:id/slots?from&to` ; `GET /tutoring/bookings` ; `POST /tutoring/bookings` `{teacher_id, subject_id?, starts_at, notes?}` ; `POST /tutoring/bookings/:id/cancel`

### admin (`/api/admin/...`, todos `[adm]`)
* `auth/login`, `auth/logout`, `auth/me`
* `dashboard` → métricas
* `students` CRUD + `POST students/:id/block|unblock|grant-access {until}` + `GET students/:id/progress`
* `content/areas`, `content/subjects`, `content/topics`, `content/subtopics` CRUD + `PATCH .../reorder {ids[]}` + `GET content/tree`
* `lessons` CRUD (com `exam_ids[]`) + `POST lessons/parse-video {url}` → provider/thumbnail/duração quando disponível
* `questions` CRUD (com `options[]`, `exam_ids[]`) + `POST questions/import` (JSON/CSV) + `GET questions/export`
* `past-exams` CRUD
* `exams` (vestibulares) CRUD + `PUT exams/:id/subjects {[{subject_id, weight}]}` + `PUT exams/:id/topics {[{topic_id, weight}]}`
* `simulados` CRUD (modelos)
* `essays/themes` CRUD ; `essays/criteria` GET/PUT por exam ; `essays/submissions` lista
* `teachers` CRUD (+availability) ; `bookings` lista/confirm/cancel
* `plans` CRUD + `POST plans/:id/sync-stripe` ; `subscriptions` lista
* `settings` GET/PUT ; `settings/integrations` → status OpenRouter/Stripe/SMTP (chaves mascaradas) ; `ai/usage` (métricas, por dia, por feature, por aluno)
* `platform/health` → uptime, versão, DB, últimos erros, atividade recente ; `platform/errors` ; `platform/audit`

---

## 5. Motor do cronograma (`services/schedule.js`)

Entrada: perfil (prova, dias `study_days`, `hours_per_day`, nível, matéria fraca, data da prova), pesos de
`exam_subjects`, syllabus `exam_topics`, aulas ativas por assunto (ordenadas), progresso (`lesson_progress`),
desempenho (`question_attempts` por assunto, últimos 60 dias), revisões pendentes, settings.

Geração (`generateSchedule(userId, { from = hoje, days = 14 })`):
1. Remove itens `pending` gerados (`generated = true`) a partir de `from`; mantém concluídos/manuais.
2. Para cada dia de estudo em `study_days` no intervalo, capacidade = `hours_per_day * 60`.
3. Preenche na ordem de prioridade:
   1. **Revisões** vencidas/do dia (`reviews.due_date <= dia`) — 15 min cada, até 30% do dia.
   2. **Redação** — 1x por semana (último dia de estudo da semana), 60 min, se a prova tem redação.
   3. **Simulado** — a cada `simulado_every_days` (padrão 14), 90 min, no último dia de estudo da quinzena.
   4. **Aulas / assuntos** — blocos por matéria escolhidos por pontuação:
      `score = peso_da_matéria × (1 + fraqueza) × (1.25 se matéria_fraca_do_perfil) × (1 − progresso_da_matéria) × urgência`
      onde `fraqueza = 1 − acurácia` no assunto (0.5 se sem dados), `urgência` cresce quando a data da prova está
      a menos de 60 dias e há muito conteúdo pendente. Rotaciona 2–3 matérias por dia; dentro da matéria pega
      o **próximo assunto não estudado** na ordem do syllabus; se o assunto tem aula, item `lesson` (duração da
      aula + 10 min de prática); se ainda não tem aula cadastrada, item `topic` ("Estudar: <assunto>") de 40 min.
      Assuntos com acurácia < 60% voltam à fila com prioridade (item `questions` do assunto).
   5. **Questões** — bloco de 20 min por dia com as matérias do dia (mix de assuntos fracos).
4. Grava itens com `position` sequencial e `generated = true`.

Adaptação: chamada `regenerateFromTomorrow(userId)` após: onboarding, mudança de disponibilidade,
prática com acurácia < 60%, conclusão de simulado, `skip-today`. "Não consegui estudar hoje" move os
pendentes de hoje para os próximos dias de estudo respeitando capacidade e empurrando o restante.

Revisões (`services/reviews.js`): ao concluir aula, cria revisões em `+1, +7, +30` dias
(`review_intervals`) para o assunto; ao concluir revisão registra `score`; o cronograma insere as revisões
devidas automaticamente. Revisão = 5 questões do assunto (fallback: marcar como revisada).

Sequência de dias (`streak`): dias consecutivos com pelo menos um `study_log` (até hoje ou ontem).

---

## 6. Frontend — convenções

### 6.1 Shells e roteamento
* `app.html` carrega `css/app.css` e `js/app/shell.js` (type=module). O shell renderiza sidebar (desktop),
  topbar com busca global, menu inferior (mobile) e `<main id="page">`. Chama `GET /api/auth/me`; se 401 →
  redireciona para `/login?next=`; se `onboarding_completed=false` → `/app/onboarding`; se `access.allowed=false`
  → `/app/assinatura` (exceto rotas liberadas: perfil, assinatura).
* Roteador (`core/router.js`): History API. `routes.js` exporta lista `[{ path: '/app/aulas/:id', page: () => import('./pages/lesson.js'), title }]`.
  Cada página exporta `default async function render(ctx)`; `ctx = { el, params, query, user, profile, navigate, setTitle }`.
  Pode exportar `unmount()` para limpar timers/listeners. O roteador mostra skeleton enquanto importa/carrega.
* Links internos: `<a href="/app/...">` — o roteador intercepta cliques. Programaticamente: `navigate('/app/...')`.
* Estado global (`core/store.js`): `store.user`, `store.profile`, `store.exam`, `store.access`, `store.on(event, fn)`,
  `store.emit(event)`. Eventos: `user:updated`, `progress:updated`, `schedule:updated`.

### 6.2 Núcleo
* `core/api.js`: `api.get(path, {query})`, `api.post(path, body)`, `api.put`, `api.patch`, `api.del`, `api.stream(path, body, { onDelta, onDone, onError })` para SSE.
  Lança `ApiError { status, code, message, details }`. 401 em rota de app → redireciona para login.
* `core/ui.js`: `html` (tagged template com escape automático; `raw()` para HTML confiável), `render(el, htmlString)`,
  `toast(msg, { type: 'success'|'error'|'info'|'warning' })`, `modal({ title, body, actions, size })`, `confirm({ title, message, danger })`,
  `pageHeader({ title, subtitle, actions, breadcrumb })`, `emptyState({ icon, title, text, action })`, `skeleton(kind)`,
  `progressBar(pct, { color, label })`, `badge(text, tone)`, `statCard({ label, value, hint, icon, tone, delta })`,
  `tabs(el, [{id,label}], onChange)`, `dropdown(...)`, `debounce`, `qs`, `qsa`, `on(el, evt, sel, fn)`.
* `core/icons.js`: `icon('calendar', { size })` → `<svg class="icon">` usando `assets/icons.svg#i-<nome>`. Nomes = Lucide.
* `core/format.js`: `fmtDate`, `fmtDateLong`, `fmtRelative`, `fmtMinutes(125) → '2h 05min'`, `fmtPct`, `fmtNumber`, `fmtMoney(cents)`, `weekdayName`, `difficultyLabel`.
* `core/charts.js`: Chart.js já configurado com tema escuro; `lineChart(canvas, {labels, datasets})`, `barChart`, `doughnutChart`, `radarChart`; devolve instância; destrói a anterior no mesmo canvas.
* `core/markdown.js`: `md(text)` → HTML sanitizado (marked + DOMPurify). Usado em resumos, resoluções e respostas do tutor.

### 6.3 Componentes
* `components/question-runner.js` — `mountQuestionRunner(el, { questions, mode, answer(questionId, optionId) → Promise<result>, onFinish(summary), showTimer, immediateFeedback, startIndex })`
  Modo `immediateFeedback=true` (prática, revisão, caderno de erros, banco): ao responder mostra **ACERTOU** / **ERROU**, alternativa correta, resolução, explicação, botões "Perguntar ao Tutor" e "Próxima".
  Modo `immediateFeedback=false` (simulado): navegação livre entre questões, marca respondidas, cronômetro, "Finalizar".
  `summary = { total, correct, wrong, blank, answers: [{question_id, option_id, is_correct}] }`.
* `components/video-player.js` — `renderVideo(el, { video_url, video_provider, thumbnail_url, title })` (YouTube/Vimeo iframe, externo `<video>`/link, `none` → placeholder "Vídeo em breve").
* `components/notes-editor.js` — `mountNotesEditor(el, { value, onSave(content) → Promise, delay: 1200 })` autosave com indicador "Salvo".
* `components/calendar.js` — visão semanal e mensal do cronograma; `mountCalendar(el, { view, date, days, onItemClick, onDayClick, onViewChange })`.
* `components/data-table.js` (admin) — `mountTable(el, { columns, fetch(page, query) → {items,total}, rowActions, search, filters })`.
* `components/form.js` (admin) — `buildForm(el, fields, { values, onSubmit })` com validação e feedback.

### 6.4 Páginas do aluno (`js/app/pages/`)
| Rota | Arquivo | Conteúdo |
|------|---------|----------|
| `/app` | dashboard.js | "Olá, Nome", próxima atividade (COMEÇAR A ESTUDAR), sequência, horas, aulas, questões, acertos, redações, progresso geral, matérias difíceis, meta semanal, cronograma de hoje |
| `/app/onboarding` | onboarding.js | sequência de perguntas em etapas (prova → disponibilidade → nível → dificuldade → específicas da prova) |
| `/app/cronograma` | schedule.js | hoje / semana / mês; concluir, reagendar, alterar horário, não realizada, "Não consegui estudar hoje", item manual, recalcular |
| `/app/materias`, `/app/materias/:subjectId`, `/app/materias/:subjectId/assuntos/:topicId` | subjects.js, subject.js, topic.js | cards com progresso → assuntos → subassuntos e aulas |
| `/app/aulas`, `/app/aulas/:id`, `/app/aulas/:id/praticar` | lessons.js, lesson.js, practice.js | lista/continuar; player + resumo + anotações + provas onde cai + concluir; Pratique agora (5 questões) |
| `/app/questoes` | questions.js | banco com filtros, resolver com feedback |
| `/app/simulados`, `/app/simulados/:id`, `/app/simulados/:id/resultado` | simulados.js, simulado-run.js, simulado-result.js | tipos, iniciar, executar, resultado com gráficos |
| `/app/redacao`, `/app/redacao/nova`, `/app/redacao/:id` | essays.js, essay-new.js, essay.js | Minhas Redações + evolução; escolher/gerar tema, escrever, enviar; correção detalhada |
| `/app/tutor`, `/app/tutor/:id` | tutor.js | conversas + chat com streaming, contexto da aula |
| `/app/provas-anteriores` | past-exams.js | por prova/ano/dia, PDF + gabarito |
| `/app/revisoes` | reviews.js | hoje/atrasadas/próximas; revisar (5 questões) |
| `/app/caderno-de-erros`, `/app/caderno-de-erros/refazer` | errors.js, errors-redo.js | lista, filtros, refazer |
| `/app/desempenho` | performance.js | métricas + gráficos |
| `/app/resumos`, `/app/resumos/:id` | notes.js, note.js | filtros por matéria/assunto/data, editor |
| `/app/favoritos` | favorites.js | abas: aulas, questões, assuntos, resumos |
| `/app/perfil` | profile.js | dados, metas, disponibilidade, senha, assinatura (status + portal) |
| `/app/assinatura` | subscription.js | planos e checkout (também usada quando acesso bloqueado) |
| `/app/aulas-particulares` | tutoring.js | professores, horários, agendar, minhas aulas |
| `/app/busca` | search.js | resultados agrupados |

Menu lateral (desktop), nesta ordem: Início, Meu Cronograma, Matérias, Aulas, Questões, Simulados,
Redação IA, Tutor IA, Provas Anteriores, Revisões, Caderno de Erros, Meu Desempenho, Meus Resumos,
Favoritos, Aulas Particulares, Perfil. Menu inferior (mobile): Início, Cronograma, Estudar, Tutor IA, Perfil.

### 6.5 Páginas do admin (`js/admin/pages/`)
`/admin` dashboard.js · `/admin/alunos` students.js · `/admin/alunos/:id` student.js · `/admin/conteudo` content.js (árvore área→matéria→assunto→subassunto, reordenar, criar/editar inline) · `/admin/aulas` lessons.js · `/admin/aulas/nova|:id` lesson-form.js · `/admin/questoes` questions.js · `/admin/questoes/nova|:id` question-form.js · `/admin/questoes/importar` questions-import.js · `/admin/provas-anteriores` past-exams.js · `/admin/vestibulares` exams.js · `/admin/vestibulares/:id` exam-form.js (dados, matérias+pesos, assuntos, redação/critérios) · `/admin/simulados` simulados.js · `/admin/redacao` essays.js (temas, critérios por prova, redações corrigidas) · `/admin/professores` teachers.js · `/admin/agendamentos` bookings.js · `/admin/planos` plans.js · `/admin/configuracoes` settings.js (marca, acesso, OpenRouter, Stripe, e-mail) · `/admin/plataforma` platform.js (saúde, uso de IA, erros, auditoria).

---

## 7. Design system

Marca: **Foco de Elite** (domínio focoelite.com.br). A logo do cliente é dourada sobre preto
(assets/logo.svg, logo-mark.svg, favicon.svg) — o dourado fica restrito à marca e a um ou outro acento
(`--brand-gold`), nunca vira cor de interface. Lema: "Disciplina transforma sonhos em realidade."
Frases de apoio, usadas com moderação: "Disciplina hoje, aprovação amanhã." / "Pequenas evoluções, grandes conquistas."

Identidade (base = especificação escrita do cliente): escuro, sóbrio, premium. Fundo azul-marinho quase
preto, grafite azulado, cards azul-escuro, texto branco, destaques em azul elétrico, verde para progresso
e acertos, laranja para alertas, vermelho suave para erros. **Não parece infantil, não parece "gerado por
IA"**: nada de gradiente roxo, nada de emojis na interface (ícones Lucide), nada de texto genérico.
Copy em português do Brasil, direta, sem exclamações em excesso.

Referência de composição (mockup enviado pelo cliente, serve de norte, não de paleta): dashboard com
sidebar à esquerda, barra "Seu plano de estudos" com % geral, card "Continue estudando" com thumbnail da
última aula, seção "Seu progresso" com anéis por matéria, checklist do dia no celular (Aula concluída ·
Questões resolvidas · Meta do dia atingida), frase motivacional discreta. Faixa de recursos na landing:
Videoaulas, Cronograma personalizado, Questões e simulados, Acompanhamento de progresso, IA para tirar
dúvidas, Resumos estratégicos, Correção de redação.

### 7.1 Tokens (`tokens.css`)
```
--bg:        #07111F   fundo principal (azul-marinho quase preto)
--bg-2:      #0B1626   fundo secundário / sidebar / topbar (grafite azulado)
--card:      #0D1B2A   cards
--card-2:    #13243A   cards secundários, hover, inputs
--border:    rgba(148,163,184,.12)
--border-2:  rgba(148,163,184,.22)
--text:      #F5F7FA
--text-2:    #94A3B8
--text-3:    #64748B
--primary:   #2F80ED   azul principal (ações)
--primary-2: #4DA3FF   azul de destaque (links, foco, gráficos)
--primary-soft: rgba(47,128,237,.14)
--success:   #2ECC71   verde (progresso, acertos)
--success-soft: rgba(46,204,113,.14)
--warning:   #F5A623   laranja (alertas)
--danger:    #FF6B6B   vermelho suave (erros)
--brand-gold: #D9B25C  somente marca/acento pontual (logo, lema)
--radius:    12px   --radius-lg: 16px   --radius-sm: 8px
--shadow:    0 8px 24px rgba(0,0,0,.28)
--font:      'Inter', system-ui, sans-serif
--font-display: 'Manrope', 'Inter', sans-serif   (títulos)
espaçamento em múltiplos de 4px: --s-1: 4px … --s-8: 32px, --s-10: 40px, --s-12: 48px
```
Fontes via Google Fonts (`Inter` 400/500/600, `Manrope` 600/700/800) com fallback do sistema.
Gráficos: série principal `--primary-2`, progresso/acertos `--success`, alerta `--warning`, neutra `--text-3`.

### 7.2 Componentes CSS (`components.css`) — classes canônicas
`.btn` `.btn-primary` `.btn-secondary` `.btn-ghost` `.btn-danger` `.btn-sm` `.btn-lg` `.btn-icon` ·
`.card` `.card-hover` `.card-header` `.card-title` `.card-body` · `.input` `.select` `.textarea` `.field` `.label` `.hint` `.error-text` ·
`.badge` `.badge-blue` `.badge-green` `.badge-orange` `.badge-red` `.badge-gray` · `.progress` `.progress-bar` · `.ring` (anel de progresso em SVG, cor via `--ring-color`) ·
`.stat` (`.stat-value` `.stat-label` `.stat-hint`) · `.tabs` `.tab` `.tab.active` · `.table` `.table-wrap` ·
`.modal-backdrop` `.modal` · `.toast` · `.empty` · `.skeleton` · `.avatar` · `.chip` · `.divider` · `.kbd` ·
`.list` `.list-item` · `.grid` `.grid-2` `.grid-3` `.grid-4` (responsivos) · `.page-header` · `.breadcrumb` ·
`.alert` `.alert-info|success|warning|danger` · `.tooltip` · `.dropdown` `.dropdown-menu` · `.switch` · `.checklist` (itens com check verde).

Layout (`layout.css`): `.app-shell` (sidebar 260px fixa ≥1024px, colapsa em ícones 72px em 768–1023px,
oculta abaixo com menu inferior `.bottom-nav`), `.topbar` (busca, prova atual, streak, avatar), `.page`
(max-width 1240px, padding 32px / 16px mobile).

### 7.3 Padrões de tela
* Toda página começa com `pageHeader` (título Manrope 28px, subtítulo cinza). Ações à direita.
* Cards com 1px de borda `--border` + fundo `--card`; sem bordas coloridas grossas.
* Números grandes em `--font-display` 600. Verde só para progresso/acerto, vermelho só para erro.
* Dashboard: barra "Seu plano de estudos" (progresso geral), "Continue estudando" (última aula em andamento com thumbnail), "Seu progresso" com anéis por matéria, checklist do dia, frase do dia discreta — além do card "Próxima atividade" com COMEÇAR A ESTUDAR e das métricas exigidas na especificação.
* Estados: carregando (skeleton), vazio (`emptyState` com ação), erro (alert + tentar novamente).
* Animações: transição 150ms em hover/focus; entrada de página com fade 200ms; nada saltitante.
* Acessibilidade: foco visível (`outline: 2px solid var(--primary-2)`), contraste AA, botões com `aria-label`.
* Responsivo: grids colapsam; tabelas em `.table-wrap` com scroll horizontal; modais em tela cheia no mobile.

---

## 8. Definição de pronto por módulo
1. Endpoints implementados com validação zod, escopo por usuário, erros no formato padrão.
2. Páginas do front consumindo a API real, com estados de carregamento/vazio/erro e responsivas.
3. Testes em `tests/<modulo>.test.js` cobrindo o fluxo principal e as regras de segurança do módulo
   (usar `tests/helpers.js`: `createApp()`, `resetDb()`, `registerStudent()`, `loginAdmin()`, `agent`).
4. Nenhum conteúdo importante fixo em código: tudo que o admin cadastra vem do banco.
5. `npm test` verde e servidor sobe sem erros; smoke com `curl` dos endpoints principais.

---

## 9. Seeds (`server/db/seed/data/`)
* `exams.js` — ENEM (track enem, INEP), Academia do Barro Branco / Cadete PM-SP (barro_branco, VUNESP),
  FUVEST, UNICAMP (Comvest), UNESP (VUNESP), FGV, Mackenzie, PUC-SP (vestibular).
* `areas.js`, `subjects.js` — Linguagens (Língua Portuguesa, Interpretação de Texto, Gramática, Literatura,
  Artes, Educação Física, Inglês, Espanhol, Tecnologias da Informação e Comunicação), Matemática, Ciências
  Humanas (História, Geografia, Filosofia, Sociologia), Ciências da Natureza (Biologia, Física, Química),
  Redação, Específicas (Informática, Administração Pública, Atualidades, Legislação).
* `topics.js` — conteúdo programático completo por matéria (assuntos e subassuntos), com mapeamento de
  quais provas cada assunto cobre (`exams: ['enem','barro-branco','fuvest',...]`).
* `exam_subjects.js` — pesos por prova. `essay_criteria.js` — ENEM (5 competências de 0–200),
  Barro Branco (critérios do edital VUNESP, escala 0–100, editáveis), FUVEST/UNICAMP/UNESP (modelos próprios).
* `essay_themes.js` — temas iniciais por prova. `plans.js` — Mensal e Anual (preço editável).
  `settings.js` — chaves do §3.6. `demo.js` — aulas e questões de exemplo (opcional).
