'use strict';

/**
 * O caminho que o cliente vai gravar em vídeo.
 *
 *   NODE_ENV=test OPENROUTER_MOCK=1 node --test tests/video-do-cliente.test.js
 *
 * Ele pediu duas coisas, nessas palavras: "pegar todas as provas enem barro
 * branco e ppl, e diluir ai as questões no banco de questões, na aba questões,
 * e jogar o ppl nas provas anteriores tbm". Depois abriu a plataforma e não viu
 * nem uma coisa nem outra.
 *
 * Este arquivo anda pelo caminho inteiro, pelas rotas de verdade, do cadastro
 * da prova até o aluno pesquisando o assunto — que é exatamente o que a câmera
 * vai mostrar. Cada passo que precisa de um humano clicando aparece aqui como
 * uma chamada explícita: se algum dia um deles sumir do teste, é porque alguém
 * automatizou, e não porque deixou de ser necessário.
 */
process.env.OPENROUTER_MOCK = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

let ctx;
let db;
let admin;
let aluno;
let enem;

/** Um trecho de prova no formato do ENEM, com `total` questões numeradas. */
function provaEmTexto(total) {
  const partes = [];
  for (let i = 1; i <= total; i += 1) {
    partes.push(`QUESTÃO ${i}`);
    partes.push(
      `Um comerciante aplicou um desconto sucessivo sobre o preço de um produto e precisa ` +
        `saber o valor final cobrado do consumidor. Enunciado da questão ${i}, com contexto ` +
        `suficiente para ser respondida sem consultar o restante da prova.`
    );
    for (const letra of ['A', 'B', 'C', 'D', 'E']) partes.push(`${letra}  Alternativa ${letra}.`);
    partes.push('');
  }
  return partes.join('\n');
}

/** Varre a leitura até acabar, como a tela do admin faz: dispara e acompanha. */
async function varrerAteOFim(id, { maxLotes = 40 } = {}) {
  for (let lote = 0; lote < maxLotes; lote += 1) {
    const disparo = await admin.agent.post(`/api/admin/exam-imports/${id}/sweep`, {});
    assert.ok(
      disparo.status === 200 || disparo.status === 202,
      `varredura recusada (${disparo.status}): ${JSON.stringify(disparo.body)}`
    );
    if (disparo.body.done) return;
    for (let espera = 0; espera < 200; espera += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const atual = await db.one('SELECT status FROM exam_imports WHERE id = $1', [id]);
      if (atual.status !== 'extraindo') break;
    }
  }
  throw new Error('a varredura não terminou dentro do limite de lotes');
}

before(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  admin = await ctx.loginAdmin();
  aluno = await ctx.registerStudent({ name: 'Aluno que vai aparecer no vídeo' });

  enem = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, sort_order, active)
     VALUES ('enem-video', 'Exame Nacional do Ensino Médio', 'ENEM', 'enem', 1, true) RETURNING id`
  );
  const materia = await db.one(
    `INSERT INTO subjects (slug, name, sort_order) VALUES ('matematica-video', 'Matemática', 1) RETURNING id`
  );
  await db.query('INSERT INTO exam_subjects (exam_id, subject_id) VALUES ($1, $2)', [enem.id, materia.id]);
  const assunto = await db.one(
    `INSERT INTO topics (subject_id, slug, name, sort_order) VALUES ($1, 'porcentagem', 'Porcentagem', 1) RETURNING id`,
    [materia.id]
  );
  await db.query('INSERT INTO exam_topics (exam_id, topic_id) VALUES ($1, $2)', [enem.id, assunto.id]);
});

after(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------------------
describe('Cena 1 — a prova do PPL em Provas Anteriores', () => {
  let prova;

  it('o admin cadastra a prova do PPL com o PDF', async () => {
    const res = await admin.agent.post('/api/admin/past-exams', {
      exam_id: enem.id,
      year: 2024,
      day: 1,
      title: 'ENEM PPL 2024 — 1º dia',
      board: 'INEP',
      pdf_url: 'https://download.inep.gov.br/enem/provas/2024/ppl_dia1.pdf',
      answer_key_url: 'https://download.inep.gov.br/enem/gabaritos/2024/ppl_dia1.pdf',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    prova = res.body;
  });

  it('o aluno abre Provas Anteriores e a prova está lá, com o PDF', async () => {
    const res = await aluno.agent.get('/api/past-exams');
    assert.equal(res.status, 200, `o aluno não conseguiu abrir a tela: ${JSON.stringify(res.body)}`);

    const todas = (res.body.exams || []).flatMap((g) => g.years.flatMap((a) => a.items));
    const achada = todas.find((p) => p.id === prova.id);
    assert.ok(achada, `a prova cadastrada não apareceu para o aluno. Vieram: ${JSON.stringify(todas)}`);
    assert.match(achada.title, /PPL/, 'é a prova do PPL que o cliente quer ver na tela');
    assert.ok(achada.pdf_url, 'sem o PDF não há o que abrir no vídeo');
  });

  it('prova inativa não aparece — é o que esconde uma prova recém-cadastrada', async () => {
    const off = await admin.agent.put(`/api/admin/past-exams/${prova.id}`, { active: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const res = await aluno.agent.get('/api/past-exams');
    const todas = (res.body.exams || []).flatMap((g) => g.years.flatMap((a) => a.items));
    assert.ok(!todas.some((p) => p.id === prova.id), 'prova inativa não pode vazar para o aluno');
    await admin.agent.put(`/api/admin/past-exams/${prova.id}`, { active: true });
  });
});

// ---------------------------------------------------------------------------
describe('Cena 2 — as questões da prova no banco de questões', () => {
  let leitura;

  it('o banco começa vazio, como o cliente encontrou', async () => {
    const res = await aluno.agent.get('/api/questions');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 0);
  });

  it('o admin cria a leitura e sobe o texto do PDF', async () => {
    const criada = await admin.agent.post('/api/admin/exam-imports', {
      exam_id: enem.id,
      title: 'ENEM PPL 2024 — 1º dia',
      year: 2024,
      // No navegador este texto é extraído do PDF de gabarito cadastrado na
      // Cena 1 antes de criar a leitura.
      answer_key: '1-A 2-B 3-C 4-D 5-E 6-A',
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    leitura = criada.body;

    const envio = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/text`, {
      chunk: provaEmTexto(6),
      done: true,
    });
    assert.equal(envio.status, 200, JSON.stringify(envio.body));
  });

  it('a varredura lê a prova inteira, sem perder nem repetir questão', async () => {
    await varrerAteOFim(leitura.id);

    const itens = await db.many(
      `SELECT number, status FROM exam_import_items WHERE import_id = $1 ORDER BY number`,
      [leitura.id]
    );
    assert.equal(itens.length, 6, `esperava as 6 questões da prova, vieram ${itens.length}`);
    assert.deepEqual(
      itens.map((i) => i.number),
      [1, 2, 3, 4, 5, 6],
      'nenhuma questão pode ficar para trás nem vir duas vezes'
    );
  });

  it('as confirmadas pelo gabarito já entram no banco durante a própria varredura', async () => {
    const res = await aluno.agent.get('/api/questions');
    assert.equal(res.body.total, 6, 'o aluno não pode abrir a tela e encontrar o banco vazio depois da leitura');

    const importadas = await db.one(
      `SELECT count(*)::int AS total FROM exam_import_items WHERE import_id = $1 AND status = 'importada'`,
      [leitura.id]
    );
    assert.equal(importadas.total, 6, 'o gabarito oficial dispensa marcar questão por questão');
  });

  it('repetir a importação automática não duplica as questões', async () => {
    const res = await admin.agent.post(`/api/admin/exam-imports/${leitura.id}/import`, { com_gabarito: true });
    assert.equal(res.status, 400, 'não deve sobrar questão confirmada para importar outra vez');
    const total = await db.one('SELECT count(*)::int AS total FROM questions WHERE source_exam_id = $1', [enem.id]);
    assert.equal(total.total, 6);
  });

  it('agora sim: o aluno abre Questões e elas estão lá', async () => {
    const res = await aluno.agent.get('/api/questions');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 6, 'é esta tela que o vídeo mostra');

    const primeira = res.body.items[0];
    assert.ok(primeira.statement, 'questão sem enunciado não serve para nada');
    assert.ok(primeira.options && primeira.options.length === 5, 'as cinco alternativas têm que vir');
  });

  it('e a questão vem separada por assunto e matéria, como ele pediu', async () => {
    const res = await aluno.agent.get('/api/questions');
    const semAssunto = res.body.items.filter((q) => !q.topic_name || !q.subject_name);
    assert.equal(
      semAssunto.length,
      0,
      `questão sem assunto não serve à busca por assunto: ${JSON.stringify(semAssunto.map((q) => q.id))}`
    );
    // O banco garante o assunto (questions.topic_id é NOT NULL). O risco real é o
    // outro: a questão que a IA não conseguiu encaixar na taxonomia nem chega aqui
    // — ela para em 'falhou' na conferência. Por isso a contagem abaixo.
    const importadas = await db.one(
      `SELECT count(*)::int AS total FROM exam_import_items WHERE status = 'importada'`
    );
    const perdidas = await db.one(
      `SELECT count(*)::int AS total FROM exam_import_items WHERE status = 'falhou'`
    );
    assert.equal(perdidas.total, 0, 'questão que não encaixa na taxonomia some do banco sem avisar');
    assert.equal(importadas.total, res.body.total, 'tudo que foi importado tem que estar visível');
  });

  it('o aluno filtra pelo assunto e acha — "o cara só pesquisa o assunto e já aparece"', async () => {
    const filtros = await aluno.agent.get('/api/questions/filters');
    assert.equal(filtros.status, 200, JSON.stringify(filtros.body));
    const assunto = (filtros.body.topics || []).find((t) => t.total > 0);
    assert.ok(assunto, `nenhum assunto com questão nos filtros: ${JSON.stringify(filtros.body.topics)}`);

    const res = await aluno.agent.get(`/api/questions?topic_id=${assunto.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.total > 0, 'filtrar pelo assunto tem que trazer as questões dele');
  });

  it('o aluno DIGITA o nome do assunto e acha — é a frase literal do pedido', async () => {
    // "Aí o cara só pesquisa o assunto nas questões aí já aparece pra ele."
    // O campo de busca da tela se oferece para isso, mas o índice de texto cobre
    // só o enunciado: digitar o nome do assunto devolvia zero enquanto a questão
    // estava lá, classificada nele.
    const porAssunto = await aluno.agent.get(`/api/questions?q=${encodeURIComponent('Porcentagem')}`);
    assert.equal(porAssunto.status, 200, JSON.stringify(porAssunto.body));
    assert.ok(porAssunto.body.total > 0, 'digitar o nome do assunto tem que trazer as questões dele');

    const porMateria = await aluno.agent.get(`/api/questions?q=${encodeURIComponent('Matemática')}`);
    assert.ok(porMateria.body.total > 0, 'e o nome da matéria também');

    const semAcento = await aluno.agent.get(`/api/questions?q=${encodeURIComponent('matematica')}`);
    assert.ok(semAcento.body.total > 0, 'ninguém digita acento em campo de busca');

    const inexistente = await aluno.agent.get(`/api/questions?q=${encodeURIComponent('Termodinâmica')}`);
    assert.equal(inexistente.body.total, 0, 'e a busca continua filtrando, não devolve tudo');
  });

  it('a questão importada aponta para a prova de origem', async () => {
    const q = await db.one(
      `SELECT source_exam_id FROM questions WHERE active ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(q.source_exam_id, enem.id, 'sem a origem, não dá para filtrar "questões do ENEM"');
  });
});

// ---------------------------------------------------------------------------
describe('Cena 3 — a porta da assinatura, que é onde o cliente bateu', () => {
  // A suíte inteira roda com a exigência de assinatura desligada (tests/helpers.js).
  // Produção não roda assim. O cliente entrou na conta dele, não conseguiu assinar e
  // viu telas vazias — então a pergunta que importa é o que essas duas telas
  // respondem para um aluno sem assinatura.
  before(async () => {
    await require('../server/services/settings').setSetting('require_subscription', true);
  });

  after(async () => {
    await require('../server/services/settings').setSetting('require_subscription', false);
  });

  it('sem assinatura, Provas Anteriores responde 402 — não é tela vazia, é porta fechada', async () => {
    const semPagar = await ctx.registerStudent({ name: 'Aluno sem assinatura' });
    const res = await semPagar.agent.get('/api/past-exams');
    assert.equal(res.status, 402, `esperava pagamento exigido, veio ${res.status}`);
    assert.equal(res.body.error.code, 'payment_required');
    assert.equal(res.body.error.details.reason, 'no_subscription');
  });

  it('sem assinatura, o banco de questões responde a mesma coisa', async () => {
    const semPagar = await ctx.registerStudent({ name: 'Outro aluno sem assinatura' });
    const res = await semPagar.agent.get('/api/questions');
    assert.equal(res.status, 402, `esperava pagamento exigido, veio ${res.status}`);
  });

  it('o admin consegue liberar um aluno sem ele pagar — é o caminho para gravar o vídeo', async () => {
    const convidado = await ctx.registerStudent({ name: 'Aluno liberado para o vídeo' });

    const barrado = await convidado.agent.get('/api/past-exams');
    assert.equal(barrado.status, 402, 'antes da liberação ele não passa');

    await db.query(`UPDATE users SET access_override_until = now() + interval '30 days' WHERE id = $1`, [
      convidado.user.id,
    ]);

    const liberado = await convidado.agent.get('/api/past-exams');
    assert.equal(liberado.status, 200, 'com a liberação ele tem que entrar');
    const todas = (liberado.body.exams || []).flatMap((g) => g.years.flatMap((a) => a.items));
    assert.ok(todas.length > 0, 'e tem que ver a prova cadastrada na Cena 1');

    const questoes = await convidado.agent.get('/api/questions');
    assert.equal(questoes.status, 200);
    assert.ok(questoes.body.total > 0, 'e as questões importadas na Cena 2');
  });

  it('existe uma tela no painel para dar essa liberação, sem mexer no banco à mão', async () => {
    const convidado = await ctx.registerStudent({ name: 'Aluno liberado pelo painel' });
    const res = await admin.agent.post(`/api/admin/students/${convidado.user.id}/grant-access`, {
      until: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    assert.equal(
      res.status,
      200,
      `o admin precisa conseguir liberar pelo painel; veio ${res.status}: ${JSON.stringify(res.body)}`
    );
    const entrou = await convidado.agent.get('/api/questions');
    assert.equal(entrou.status, 200, 'liberado pelo painel tem que entrar');
  });
});
