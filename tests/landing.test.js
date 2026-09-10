'use strict';

/**
 * Página inicial — API pública (/api/landing) e administração do conteúdo (/api/admin/landing).
 *
 *   NODE_ENV=test node --test tests/landing.test.js
 *
 * Cobre o que não pode quebrar: a página inicial carrega sem autenticação e traz blocos, planos,
 * perguntas frequentes, depoimentos e provas em destaque vindos do banco; o marcador {{planos}} é
 * trocado pelos preços cadastrados (sem sobrar marcador); nenhum identificador do provedor de
 * pagamento vaza na resposta pública; um depoimento sem texto e sem imagem é recusado; nenhuma
 * rota administrativa responde a um aluno logado; e o que o painel salva aparece na hora.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('./helpers');

/** Provas, planos, blocos, perguntas e depoimentos usados pelos testes. */
async function seedLanding(db) {
  const enem = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, sort_order, featured, logo_url,
                        landing_headline, landing_text, landing_cta)
     VALUES ('enem-landing', 'ENEM', 'ENEM', 'enem', 'INEP', 1, true, '/assets/logo.svg',
             'ENEM', 'Preparação completa para o ENEM.', 'Quero estudar para o ENEM')
     RETURNING id`
  );
  const barroBranco = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, board, sort_order, featured)
     VALUES ('barro-branco-landing', 'Academia do Barro Branco', 'Barro Branco', 'barro_branco', 'VUNESP', 2, false)
     RETURNING id`
  );
  const inativa = await db.one(
    `INSERT INTO exams (slug, name, short_name, track, sort_order, featured, active)
     VALUES ('fuvest-landing', 'FUVEST', 'FUVEST', 'vestibular', 3, true, false)
     RETURNING id`
  );

  // Mensal com identificadores do Stripe: eles NÃO podem aparecer na resposta pública.
  await db.query(
    `INSERT INTO plans (slug, name, description, price_cents, interval, interval_count, duration_months,
                        bonus_months, compare_price_cents, badge, features, highlight, sort_order,
                        stripe_product_id, stripe_price_id, provider_plan_id)
     VALUES ('mensal-landing', 'Mensal', 'Cobrança mensal.', 4490, 'month', 1, 1, 0, NULL, NULL,
             '["Acesso completo"]'::jsonb, false, 1, 'prod_TESTE123', 'price_TESTE123', 'asaas_TESTE123')`
  );
  await db.query(
    `INSERT INTO plans (slug, name, description, price_cents, interval, interval_count, duration_months,
                        bonus_months, compare_price_cents, badge, features, highlight, sort_order)
     VALUES ('quinze-meses-landing', '15 meses', 'Pague 12, receba 15.', 35990, 'month', 15, 12, 3, 67350,
             'MELHOR OFERTA', '["3 meses de bônus"]'::jsonb, true, 2)`
  );
  // plano inativo: não pode entrar na lista nem no texto de preços
  await db.query(
    `INSERT INTO plans (slug, name, price_cents, interval, duration_months, active, sort_order)
     VALUES ('descontinuado-landing', 'Descontinuado', 9990, 'month', 3, false, 9)`
  );

  await db.query(
    `INSERT INTO landing_blocks (key, eyebrow, title, subtitle, items, cta_label, cta_href, sort_order, active)
     VALUES ('hero', 'Foco de Elite', 'Pare de estudar sem direção.', 'Preparação organizada até a prova.',
             '[{"icon":"square-play","title":"Videoaulas"}]'::jsonb, 'Começar agora', '/cadastro', 1, true)`
  );
  await db.query(
    `INSERT INTO landing_blocks (key, title, sort_order, active)
     VALUES ('planos', 'Escolha seu plano', 5, true), ('oculto', 'Bloco desativado', 20, false)`
  );

  await db.query(
    `INSERT INTO faqs (question, answer, sort_order, active) VALUES
       ('Quanto custa a Foco de Elite?', 'Você pode escolher entre os planos disponíveis:

{{planos}}', 1, true),
       ('Posso estudar pelo celular?', 'Sim. A plataforma funciona no celular, no tablet e no computador.', 2, true),
       ('Pergunta desativada', 'Não deve aparecer na página inicial.', 3, false)`
  );

  await db.query(
    `INSERT INTO testimonials (name, role, content, rating, exam_id, sort_order, active)
     VALUES ('Marina Alves', 'Aprovada em Medicina', 'O cronograma me tirou da estaca zero.', 5, $1, 1, true)`,
    [enem.id]
  );
  await db.query(
    `INSERT INTO testimonials (name, content, sort_order, active)
     VALUES ('Depoimento desativado', 'Não deve aparecer.', 2, false)`
  );

  return { enem: enem.id, barroBranco: barroBranco.id, inativa: inativa.id };
}

describe('Página inicial', () => {
  let ctx;
  let db;
  let ids;
  let admin;
  let student;

  before(async () => {
    ctx = await createTestContext();
    db = ctx.db;
    ids = await seedLanding(db);
    admin = await ctx.loginAdmin();
    student = await ctx.registerStudent({ name: 'Aluna Landing' });
  });

  after(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------
  it('responde sem autenticação com blocos, planos, perguntas e provas em destaque', async () => {
    const res = await ctx.request('GET', '/api/landing');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const { blocks, exams, plans, faqs, testimonials, brand } = res.body;

    assert.equal(blocks.hero.title, 'Pare de estudar sem direção.');
    assert.equal(blocks.hero.eyebrow, 'Foco de Elite');
    assert.equal(blocks.hero.cta_href, '/cadastro');
    assert.deepEqual(blocks.hero.items, [{ icon: 'square-play', title: 'Videoaulas' }]);
    assert.ok(blocks.planos, 'o bloco de planos deveria estar na resposta');
    assert.equal(blocks.oculto, undefined, 'bloco desativado não pode aparecer');

    // só provas em destaque e ativas
    assert.deepEqual(exams.map((exam) => exam.slug), ['enem-landing']);
    assert.equal(exams[0].landing_cta, 'Quero estudar para o ENEM');

    // só planos ativos, na ordem cadastrada
    assert.deepEqual(plans.map((plan) => plan.slug), ['mensal-landing', 'quinze-meses-landing']);

    // só perguntas e depoimentos ativos
    assert.equal(faqs.length, 2);
    assert.equal(testimonials.length, 1);
    assert.equal(testimonials[0].name, 'Marina Alves');
    assert.equal(testimonials[0].exam_short_name, 'ENEM');

    assert.ok(brand.name, 'a marca deveria vir das configurações');
    assert.ok(brand.support_email.includes('@'));
  });

  it('calcula o equivalente mensal e a economia a partir do banco', async () => {
    const res = await ctx.request('GET', '/api/landing');
    const anual = res.body.plans.find((plan) => plan.slug === 'quinze-meses-landing');

    assert.equal(anual.duration_months, 12);
    assert.equal(anual.bonus_months, 3);
    // 35990 centavos divididos por 15 meses de acesso
    assert.equal(anual.monthly_equivalent_cents, Math.round(35990 / 15));
    assert.equal(anual.savings_cents, 67350 - 35990);
    assert.equal(anual.badge, 'MELHOR OFERTA');

    const mensal = res.body.plans.find((plan) => plan.slug === 'mensal-landing');
    assert.equal(mensal.monthly_equivalent_cents, 4490);
    // sem preço de comparação não se inventa economia
    assert.equal(mensal.savings_cents, null);
    assert.equal(mensal.compare_price_cents, null);
  });

  it('troca {{planos}} pelos preços do banco, sem sobrar marcador', async () => {
    const res = await ctx.request('GET', '/api/landing');
    const faq = res.body.faqs.find((item) => item.question.startsWith('Quanto custa'));

    assert.ok(faq, 'a pergunta sobre preço deveria estar na resposta');
    assert.ok(!faq.answer.includes('{{planos}}'), 'o marcador não pode sobrar na resposta');
    assert.ok(faq.answer.includes('Mensal'), faq.answer);
    assert.ok(faq.answer.includes('44,90'), faq.answer);
    assert.ok(faq.answer.includes('15 meses'), faq.answer);
    assert.ok(faq.answer.includes('359,90'), faq.answer);
    // plano inativo não entra na lista de preços
    assert.ok(!faq.answer.includes('Descontinuado'), faq.answer);

    const inteiro = JSON.stringify(res.body);
    assert.ok(!inteiro.includes('{{planos}}'), 'nenhum campo pode devolver o marcador cru');
  });

  it('não expõe identificadores do provedor de pagamento', async () => {
    const res = await ctx.request('GET', '/api/landing');
    const payload = JSON.stringify(res.body);

    for (const leak of ['stripe_product_id', 'stripe_price_id', 'provider_plan_id', 'prod_TESTE123', 'price_TESTE123', 'asaas_TESTE123']) {
      assert.ok(!payload.includes(leak), `a resposta pública vazou "${leak}"`);
    }
  });

  // -------------------------------------------------------------------------
  // Segurança do painel
  // -------------------------------------------------------------------------
  it('aluno logado não acessa as rotas administrativas da página inicial', async () => {
    const paths = [
      '/api/admin/landing/blocks',
      '/api/admin/landing/faqs',
      '/api/admin/landing/testimonials',
      '/api/admin/landing/exams',
    ];
    for (const path of paths) {
      const withStudent = await student.agent.get(path);
      assert.ok([401, 403].includes(withStudent.status), `${path} respondeu ${withStudent.status} a um aluno`);
      const anonymous = await ctx.request('GET', path);
      assert.ok([401, 403].includes(anonymous.status), `${path} respondeu ${anonymous.status} sem sessão`);
    }

    const write = await student.agent.put('/api/admin/landing/blocks/hero', { title: 'Invasão' });
    assert.ok([401, 403].includes(write.status), `escrita respondeu ${write.status} a um aluno`);

    const faqWrite = await student.agent.post('/api/admin/landing/faqs', { question: 'Invasão?', answer: 'Não.' });
    assert.ok([401, 403].includes(faqWrite.status));
  });

  // -------------------------------------------------------------------------
  // Blocos de texto
  // -------------------------------------------------------------------------
  it('salvar um bloco reflete na resposta pública', async () => {
    const before = await ctx.request('GET', '/api/landing');
    assert.equal(before.body.blocks.hero.title, 'Pare de estudar sem direção.');

    const saved = await admin.agent.put('/api/admin/landing/blocks/hero', {
      title: 'Sua aprovação começa com direção.',
      items: [
        { icon: 'square-play', title: 'Videoaulas' },
        { icon: 'target', title: 'Simulados', text: 'Teste seus conhecimentos antes da prova.' },
      ],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.title, 'Sua aprovação começa com direção.');
    // envio parcial não apaga o que não foi enviado
    assert.equal(saved.body.eyebrow, 'Foco de Elite');
    assert.equal(saved.body.cta_href, '/cadastro');

    const after = await ctx.request('GET', '/api/landing');
    assert.equal(after.body.blocks.hero.title, 'Sua aprovação começa com direção.');
    assert.equal(after.body.blocks.hero.items.length, 2);
    assert.equal(after.body.blocks.hero.items[1].text, 'Teste seus conhecimentos antes da prova.');

    const list = await admin.agent.get('/api/admin/landing/blocks');
    assert.equal(list.status, 200);
    // o painel enxerga inclusive os blocos desativados
    assert.ok(list.body.some((block) => block.key === 'oculto'));

    const registro = await db.one(`SELECT action FROM audit_logs WHERE action = 'landing.block.update' LIMIT 1`);
    assert.ok(registro, 'a alteração do bloco deveria estar na auditoria');
  });

  it('recusa item de bloco com ícone inválido', async () => {
    const res = await admin.agent.put('/api/admin/landing/blocks/hero', {
      items: [{ icon: 'Ícone Inválido!', title: 'Videoaulas' }],
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'validation_error');
  });

  // -------------------------------------------------------------------------
  // Depoimentos
  // -------------------------------------------------------------------------
  it('recusa depoimento sem texto e sem imagem', async () => {
    const res = await admin.agent.post('/api/admin/landing/testimonials', {
      name: 'Aluno sem conteúdo',
      role: 'Aprovado',
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'validation_error');

    const total = await db.one('SELECT count(*)::int AS total FROM testimonials WHERE name = $1', ['Aluno sem conteúdo']);
    assert.equal(total.total, 0, 'o depoimento inválido não pode ter sido gravado');
  });

  it('aceita depoimento por print da conversa e mantém a validação ao editar', async () => {
    const created = await admin.agent.post('/api/admin/landing/testimonials', {
      name: 'Rafael Souza',
      role: 'Cadete PM-SP',
      image_url: 'https://cdn.focoelite.com.br/depoimentos/rafael.png',
      rating: 5,
      exam_id: ids.enem,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.content, null);
    assert.equal(created.body.exam_short_name, 'ENEM');

    // tirar a imagem sem colocar texto deixaria o depoimento vazio
    const invalid = await admin.agent.put(`/api/admin/landing/testimonials/${created.body.id}`, { image_url: '' });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));

    const updated = await admin.agent.put(`/api/admin/landing/testimonials/${created.body.id}`, {
      content: 'Estudei 6 meses com a plataforma e passei.',
      image_url: '',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.image_url, null);

    const publicList = await ctx.request('GET', '/api/landing');
    assert.ok(publicList.body.testimonials.some((item) => item.name === 'Rafael Souza'));

    const removed = await admin.agent.del(`/api/admin/landing/testimonials/${created.body.id}`);
    assert.equal(removed.status, 200);

    const after = await ctx.request('GET', '/api/landing');
    assert.ok(!after.body.testimonials.some((item) => item.name === 'Rafael Souza'));
  });

  // -------------------------------------------------------------------------
  // Perguntas frequentes
  // -------------------------------------------------------------------------
  it('cria, reordena e exclui perguntas frequentes', async () => {
    const created = await admin.agent.post('/api/admin/landing/faqs', {
      question: 'Posso cancelar quando quiser?',
      answer: 'Sim. O plano mensal pode ser cancelado a qualquer momento.',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const list = await admin.agent.get('/api/admin/landing/faqs');
    assert.equal(list.status, 200);
    const ativos = list.body.filter((faq) => faq.active).map((faq) => faq.id);
    const invertido = [...ativos].reverse();

    const reorder = await admin.agent.patch('/api/admin/landing/faqs/reorder', { ids: invertido });
    assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
    assert.equal(reorder.body.updated, invertido.length);

    const publicList = await ctx.request('GET', '/api/landing');
    assert.deepEqual(publicList.body.faqs.map((faq) => faq.id), invertido);

    const removed = await admin.agent.del(`/api/admin/landing/faqs/${created.body.id}`);
    assert.equal(removed.status, 200);
    const missing = await admin.agent.del(`/api/admin/landing/faqs/${created.body.id}`);
    assert.equal(missing.status, 404);
  });

  // -------------------------------------------------------------------------
  // Provas em destaque
  // -------------------------------------------------------------------------
  it('marca uma prova como destaque e ela entra na página inicial', async () => {
    const res = await admin.agent.put(`/api/admin/landing/exams/${ids.barroBranco}`, {
      featured: true,
      logo_url: '/assets/logo-mark.svg',
      landing_headline: 'Barro Branco',
      landing_text: 'Conteúdo direcionado para o concurso de Cadete PM-SP.',
      landing_cta: 'Quero estudar para o Barro Branco',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.featured, true);

    const publicRes = await ctx.request('GET', '/api/landing');
    const slugs = publicRes.body.exams.map((exam) => exam.slug);
    assert.deepEqual(slugs, ['enem-landing', 'barro-branco-landing']);
    // a prova inativa continua fora, mesmo marcada como destaque
    assert.ok(!slugs.includes('fuvest-landing'));

    const list = await admin.agent.get('/api/admin/landing/exams');
    assert.equal(list.status, 200);
    assert.ok(list.body.every((exam) => !('essay_max_score' in exam)));

    const notFound = await admin.agent.put('/api/admin/landing/exams/00000000-0000-4000-8000-000000000000', { featured: true });
    assert.equal(notFound.status, 404);
  });
});
