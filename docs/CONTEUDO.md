# Guia de conteúdo — Foco Elite

Este guia explica como o conteúdo da plataforma é organizado, como o cronograma usa essa
organização, o que o seed cria e como operar o conteúdo de demonstração.

---

## 1. Como o conteúdo se organiza

A biblioteca de conteúdo tem cinco níveis, todos administráveis em `/admin/conteudo` e `/admin/aulas`:

```
Área                    Matemática e suas Tecnologias
└── Matéria             Matemática
    └── Assunto         Porcentagem
        └── Subassunto  Fator de aumento e de desconto
            └── Aula    Porcentagem: do conceito ao fator multiplicativo
```

| Nível       | Tabela      | Chave estável                | Para que serve |
|-------------|-------------|------------------------------|----------------|
| Área        | `areas`     | `slug` único                 | Agrupa matérias nos cards e relatórios (Linguagens, Matemática, Humanas, Natureza, Redação, Específicas). |
| Matéria     | `subjects`  | `slug` único                 | Unidade de progresso, de peso no cronograma e de filtro nas questões. Tem ícone e cor próprios. |
| Assunto     | `topics`    | `(subject_id, slug)` único   | Unidade do syllabus: é o que o cronograma agenda, o que as revisões repetem e o que o desempenho mede. |
| Subassunto  | `subtopics` | `(topic_id, slug)` único     | Detalha o assunto; aulas e questões podem apontar para ele para a prática ser mais precisa. |
| Aula        | `lessons`   | `slug` único                 | Vídeo enviado pelo painel + resumo em Markdown + duração + dificuldade. |

Questões (`questions`) apontam para matéria, assunto e, opcionalmente, subassunto. Uma questão
respondida alimenta o desempenho do assunto, o caderno de erros e as revisões.

### Uma aula, várias provas (regra de não duplicar)

O conteúdo **nunca é duplicado por prova**. "Porcentagem" existe uma única vez em Matemática e é
vinculada às provas em que cai por tabelas de ligação:

* `exam_topics (exam_id, topic_id, weight)` — em quais provas o **assunto** cai e com qual peso.
* `lesson_exams (lesson_id, exam_id)` — em quais provas a **aula** é relevante (tags "onde cai").
* `question_exams (question_id, exam_id)` — em quais provas a **questão** faz sentido (filtro "prova").

Quando um assunto novo passa a ser cobrado por outra prova, o caminho certo é acrescentar a prova
em `exam_topics` (no painel: `/admin/vestibulares/:id`, aba Assuntos), não criar outro assunto.
O mesmo vale para aulas: marque as provas no formulário da aula em vez de cadastrar a aula de novo.

Benefícios práticos: o aluno do ENEM e o aluno do Barro Branco assistem à mesma aula de porcentagem,
o progresso é contado uma vez só e uma correção no resumo vale para todos.

---

## 2. Como o cronograma usa `exam_subjects` e `exam_topics`

O motor do cronograma (`server/services/schedule.js`, §5 do ARCHITECTURE.md) trabalha com a prova
escolhida pelo aluno no onboarding:

1. **`exam_subjects`** define *quais matérias* entram no cronograma daquela prova e o *peso* de cada
   uma. O peso é o primeiro fator da pontuação de prioridade:
   `score = peso_da_matéria × (1 + fraqueza) × (1,25 se matéria fraca do perfil) × (1 − progresso) × urgência`.
   Uma matéria ausente de `exam_subjects` para a prova **não é agendada**. Os pesos iniciais estão em
   `server/db/seed/data/exam_subjects.js` e podem ser ajustados por prova em `/admin/vestibulares/:id`.
2. **`exam_topics`** é o syllabus: dentro de cada matéria, o cronograma percorre os assuntos da prova
   na ordem de estudo (`topics.sort_order`) e escolhe o **próximo assunto não estudado**. O peso do
   assunto em `exam_topics.weight` prioriza assuntos de alta incidência. Um assunto fora de
   `exam_topics` para a prova não aparece no cronograma daquela prova, mesmo que exista na biblioteca.
3. Se o assunto tem aula ativa, o item é do tipo `lesson` (duração da aula + 10 min de prática); se
   ainda não tem aula, o item é do tipo `topic` ("Estudar: Porcentagem", 40 min). Por isso o seed cria
   o syllabus completo mesmo antes de existirem aulas: o cronograma já funciona, e cada aula cadastrada
   depois enriquece o plano automaticamente.
4. Revisões (+1, +7, +30 dias) e o item diário de questões usam o assunto (`topic_id`) como unidade.

Ao alterar pesos ou assuntos de uma prova, os cronogramas são regenerados a partir do dia seguinte
na próxima adaptação (onboarding, mudança de disponibilidade, prática com baixa acurácia, simulado,
"não consegui estudar hoje" ou `POST /api/schedule/generate`).

---

## 3. O que o seed cria

Arquivos em `server/db/seed/data/`; o runner é `server/db/seed/run.js`.

| Arquivo              | Tabela(s)                                   | Conteúdo |
|----------------------|---------------------------------------------|----------|
| `settings.js`        | `settings`                                  | Chaves do §3.6 (marca, e-mail de suporte, modelos OpenAI, prompt do tutor, intervalos de revisão, padrões do cronograma). |
| `exams.js`           | `exams`                                     | ENEM, Academia do Barro Branco / Cadete PM-SP, FUVEST, UNICAMP, UNESP, FGV, Mackenzie, PUC-SP, com datas estimadas de 2026. |
| `areas.js`           | `areas`                                     | 6 áreas. |
| `subjects.js`        | `subjects`                                  | 22 matérias com ícone e cor. |
| `topics.js`          | `topics`, `subtopics`, `exam_topics`        | 305 assuntos e 1.494 subassuntos, cada assunto com a lista de provas em que cai (`exams`) e peso opcional. |
| `exam_subjects.js`   | `exam_subjects`                             | Pesos das matérias por prova. |
| `essay_criteria.js`  | `essay_criteria_sets`                       | Critérios de correção por prova: ENEM (5 competências, 0–1000), Barro Branco (VUNESP, 0–100), FUVEST, UNICAMP, UNESP e modelo 0–10 para FGV, Mackenzie e PUC-SP. |
| `essay_themes.js`    | `essay_themes`                              | 17 temas autorais com proposta e textos motivadores. |
| `plans.js`           | `plans`                                     | Mensal e Anual (preço em centavos, sem ids do Stripe). |
| `demo.js` (`--demo`) | `lessons`, `lesson_exams`, `questions`, `question_options`, `question_exams`, `teachers`, `teacher_subjects`, `teacher_availability`, `simulados` | Conteúdo de demonstração (ver §5). |

### Idempotência

Rodar o seed várias vezes não duplica registros. Cada tabela tem uma chave estável:

| Tabela                 | Chave                       | Comportamento ao rodar de novo |
|------------------------|-----------------------------|--------------------------------|
| `settings`             | `key`                       | Só cria chaves ausentes (o painel é o dono dos valores). `--force-settings` restaura. |
| `exams`                | `slug`                      | Atualiza nome, banca, descrição e pesos; **`exam_date` só é preenchida se estiver vazia** (o admin ajusta a data real quando o edital sai). `--force` sobrescreve a data. |
| `areas`, `subjects`    | `slug`                      | Atualiza. `active` não é tocado. |
| `topics`               | `(subject_id, slug)`        | Atualiza nome, descrição e ordem. Assuntos criados pelo admin são mantidos. |
| `subtopics`            | `(topic_id, slug)` — slug derivado do nome | Atualiza nome e ordem. Renomear um subassunto no seed cria um novo (o antigo permanece). |
| `exam_topics`, `exam_subjects` | pares de ids        | Atualiza o peso; vínculos criados pelo admin são mantidos. |
| `essay_criteria_sets`  | `exam_id`                   | Só cria os que faltam. `--force-criteria` restaura os critérios do seed. |
| `essay_themes`         | `(exam_id, title)`          | Atualiza proposta e textos. |
| `plans`                | `slug`                      | Só cria os que faltam (preço e descrição são editados no painel). `--force-plans` restaura. |

O seed roda em uma transação (estrutura base) e em outra (demo): se algo falhar, nada fica pela metade.

---

## 4. Como rodar

```bash
npm run migrate          # aplica migrations pendentes (obrigatório antes do seed)
npm run seed             # estrutura base — idempotente
npm run seed:demo        # estrutura base + conteúdo de demonstração — idempotente
npm run setup            # migrate + seed

# opções do runner
node server/db/seed/run.js --demo
node server/db/seed/run.js --force            # restaura settings, planos, critérios e datas das provas
node server/db/seed/run.js --force-criteria   # restaura só os critérios de redação
node server/db/seed/run.js --force-plans      # restaura só os planos
node server/db/seed/run.js --force-settings   # restaura só as configurações
node server/db/seed/run.js --quiet            # imprime apenas o resumo
```

Ao terminar, o runner imprime um resumo por tabela (criadas / sincronizadas / mantidas / total).
Na segunda execução, "criadas" deve ser zero em todas as linhas e "total" deve ser igual ao da primeira.

Uso programático (por exemplo em testes ou scripts de deploy):

```js
const { runSeed } = require('./server/db/seed/run');
await runSeed({ demo: true, quiet: true });
```

Fluxo recomendado em um ambiente novo:

```bash
cp .env.example .env     # preencha DATABASE_URL, segredos e ADMIN_*
npm run migrate
npm run seed:demo        # ou npm run seed, se não quiser a demonstração
npm run create-admin
npm run dev
```

---

## 5. Conteúdo de demonstração

`npm run seed:demo` cria, além da estrutura base:

* **6 aulas** sem vídeo (`video_provider = 'none'`, o player mostra "Vídeo em breve") com resumo
  didático em Markdown de 400–500 palavras, `teacher_name = 'Equipe Foco Elite'` e tags de prova:
  Porcentagem, Regra de três, Interpretação de texto (inferência), Revolução Industrial,
  Cinemática (MRU/MRUV) e Estequiometria.
* **45 questões originais** (5 alternativas, uma correta, resolução passo a passo e explicação), com
  dificuldade variada, `board = 'Foco Elite'`, `source = 'demo:<n> — conteúdo de demonstração'` e
  `question_exams` coerentes com o assunto. Cobrem os 6 assuntos das aulas e também funções,
  probabilidade, concordância verbal/nominal e urbanização.
* **1 professor** (Ana Beatriz Moreira, e-mail `@demo.focoelite.com.br`) em Matemática e Física, com
  disponibilidade de segunda a sexta, 18:00–21:00.
* **2 modelos de simulado** do tipo `exam` (ENEM e Barro Branco), sem `question_ids` fixos: as questões
  são sorteadas pelos filtros da prova. Identificados por `config->>'seed_key'`.

Identificadores estáveis garantem a idempotência: aulas por `slug`, questões por `source`, professor
por e-mail e simulados por `config.seed_key`. Editar uma aula demo no painel e rodar o seed de novo
**sobrescreve** a edição (o seed é a fonte da verdade do conteúdo demo); para manter a edição, remova
o conteúdo demo antes de reexecutar ou não use `--demo` novamente.

### Como remover o conteúdo de demonstração

Execute no banco (`psql "$DATABASE_URL"`). As tabelas dependentes (`question_options`, `question_exams`,
`lesson_exams`, `teacher_subjects`, `teacher_availability`, `lesson_progress`, `notes.lesson_id`,
`question_attempts`, `error_notebook`) são limpas por `ON DELETE CASCADE` / `SET NULL` do schema.

```sql
BEGIN;

-- questões de demonstração (e alternativas, vínculos com provas, tentativas e caderno de erros)
DELETE FROM questions WHERE source LIKE 'demo:%';

-- aulas de demonstração (e progresso, favoritos ficam órfãos apenas em favorites.item_id)
DELETE FROM lessons WHERE slug IN (
  'porcentagem-conceito-e-fator-multiplicativo',
  'regra-de-tres-simples-e-composta',
  'interpretacao-de-texto-como-fazer-inferencias',
  'revolucao-industrial-causas-fases-e-consequencias',
  'cinematica-mru-e-mruv',
  'estequiometria-calculos-a-partir-das-equacoes'
);

-- modelos de simulado de demonstração
DELETE FROM simulados WHERE config->>'seed_key' LIKE 'demo:%';

-- professor de demonstração (agendamentos existentes são removidos em cascata)
DELETE FROM teachers WHERE email LIKE '%@demo.focoelite.com.br';

-- favoritos que apontavam para itens removidos
DELETE FROM favorites f
 WHERE (f.item_type = 'lesson'   AND NOT EXISTS (SELECT 1 FROM lessons   l WHERE l.id = f.item_id))
    OR (f.item_type = 'question' AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.id = f.item_id));

COMMIT;
```

A estrutura base (áreas, matérias, assuntos, provas, critérios, temas e planos) não é afetada por
essa remoção. Se preferir manter apenas parte da demonstração (por exemplo, as questões), execute
somente os comandos correspondentes.

---

## 6. Boas práticas ao cadastrar conteúdo

* **Slugs**: o painel gera slugs a partir do nome (`server/utils/slug.js`). Mantenha-os estáveis; mudar
  o slug de um assunto que já tem aulas e questões não é necessário e quebra links salvos.
* **Ordem de estudo**: `sort_order` dos assuntos é a sequência sugerida; o cronograma a respeita. Coloque
  pré-requisitos antes (razão e proporção antes de regra de três; MRU antes de MRUV).
* **Assunto sem aula**: é normal e esperado. O cronograma agenda "Estudar: <assunto>"; quando a aula
  for cadastrada, os próximos cronogramas passam a usá-la.
* **Tags de prova nas aulas e questões**: marque todas as provas em que o item faz sentido. Uma aula sem
  tag aparece na biblioteca, mas não é listada em "onde cai".
* **Questões**: cinco alternativas (A–E), exatamente uma correta, resolução passo a passo e explicação
  curta do erro mais comum. O aluno vê resolução e explicação após responder.
* **Resumos das aulas**: Markdown simples (títulos `##`, listas, negrito). Evite HTML; o front sanitiza.
