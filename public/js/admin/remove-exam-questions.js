// =====================================================================
// Foco Elite — Admin › Remover as questões de uma prova
//
// Usado em Provas anteriores e em Ler prova em PDF. Quando uma prova entra
// errada no banco, o caminho é apagar as questões dela e ler de novo. Isso
// não tem volta e leva junto o histórico dos alunos, então a janela mostra o
// impacto em linguagem simples ANTES, e só apaga depois de alguém digitar o
// ano da prova (ou APAGAR).
//
// Leituras feitas sem escolher a prova anterior (o 2º dia do ENEM lido pelo
// arquivo, por exemplo) têm a mesma marca de vestibular e ano. Elas aparecem
// uma por uma, com o título, e só entram as que forem marcadas; a cada caixa
// a janela pede a conta de novo ao servidor, para os alunos não contarem duas
// vezes.
//
// API: GET    /api/admin/exam-imports/provas/:id/questoes/impacto?include_orphans&import_ids
//      DELETE /api/admin/exam-imports/provas/:id/questoes  { confirm: true, include_orphans?, import_ids? }
// =====================================================================
import { api } from '../core/api.js';
import { html, raw, render, modal, toast, qs, qsa, alertBox } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { fmtDate, fmtNumber, pluralize } from '../core/format.js';

const PALAVRA = 'APAGAR';

/** O texto principal: quantas questões e quem perde o quê. */
function resumo(conta) {
  if (!conta.questions) {
    return html`<p class="xrm-lead">Nenhuma questão ligada a esta prova está no banco.</p>`;
  }
  const uma = conta.questions === 1;
  const alunos = conta.students
    ? html`<p class="xrm-lead">
        <strong>${conta.students === 1 ? '1 aluno já respondeu' : `${fmtNumber(conta.students)} alunos já responderam`}
        ${uma ? 'essa questão' : 'algumas delas'}</strong>: as respostas e o caderno de erros
        ${uma ? 'dela' : 'dessas questões'} também somem.
      </p>`
    : html`<p class="xrm-lead">Nenhum aluno respondeu ${uma ? 'essa questão' : 'essas questões'} ainda.</p>`;
  return html`
    <p class="xrm-lead xrm-lead-main">Isso apaga <strong>${pluralize(conta.questions, 'questão', 'questões')}</strong>.</p>
    ${alunos}`;
}

/**
 * Os detalhes que só aparecem quando existem.
 * @param {{ imports: number, escolhidas: number }} leituras  quantas leituras saem, e quantas delas são soltas
 */
function detalhes(conta, leituras) {
  const linhas = [];
  if (conta.attempts) linhas.push(`${pluralize(conta.attempts, 'resposta registrada', 'respostas registradas')} saem do desempenho dos alunos.`);
  if (conta.error_notebook) {
    linhas.push(
      `${pluralize(conta.error_notebook, 'entrada', 'entradas')} do caderno de erros dos alunos ${conta.error_notebook === 1 ? 'some' : 'somem'}.`
    );
  }
  if (conta.in_progress_simulados) {
    linhas.push(
      `${pluralize(conta.in_progress_simulados, 'simulado em andamento perde', 'simulados em andamento perdem')} essas questões` +
        (conta.in_progress_simulados_emptied
          ? ` (${pluralize(conta.in_progress_simulados_emptied, 'fica', 'ficam')} sem nenhuma e ${conta.in_progress_simulados_emptied === 1 ? 'é encerrado' : 'são encerrados'}, com a moeda devolvida).`
          : '. Os já finalizados mantêm a nota.')
    );
  }
  if (conta.simulado_models) {
    linhas.push(
      `${pluralize(conta.simulado_models, 'modelo de simulado perde', 'modelos de simulado perdem')} essas questões` +
        (conta.simulado_models_emptied
          ? ` (${pluralize(conta.simulado_models_emptied, 'fica vazio e sai', 'ficam vazios e saem')} do ar).`
          : '.')
    );
  }
  if (conta.reports) linhas.push(`${pluralize(conta.reports, 'aviso de erro enviado', 'avisos de erro enviados')} por alunos também ${conta.reports === 1 ? 'some' : 'somem'}.`);
  if (conta.favorites) linhas.push(`${pluralize(conta.favorites, 'favorito', 'favoritos')} de alunos ${conta.favorites === 1 ? 'sai' : 'saem'} da lista.`);
  const daProva = leituras.imports - leituras.escolhidas;
  if (daProva > 0) {
    linhas.push(
      `${daProva === 1 ? 'A leitura desta prova também é apagada' : `As ${fmtNumber(daProva)} leituras desta prova também são apagadas`}: ` +
        'ela volta a aparecer como não lida e pode ser lida de novo do zero.'
    );
  }
  if (leituras.escolhidas > 0) {
    linhas.push(
      leituras.escolhidas === 1
        ? 'A leitura marcada abaixo também é apagada, junto com as questões dela.'
        : `As ${fmtNumber(leituras.escolhidas)} leituras marcadas abaixo também são apagadas, junto com as questões delas.`
    );
  }
  if (!linhas.length) return '';
  return html`<ul class="xrm-list">${linhas.map((linha) => html`<li>${linha}</li>`)}</ul>`;
}

/** "A prova X é do mesmo vestibular e ano": o aviso de que as questões podem ser da outra. */
function avisoIrmas(irmas, sujeito) {
  if (!irmas.length) return '';
  return html`<span class="check-desc xrm-warn">
    ${icon('triangle-alert', { size: 14 })}
    ${irmas.length === 1 ? 'A prova' : 'As provas'} ${irmas.map((p) => `"${p.title}"`).join(', ')}
    ${irmas.length === 1 ? 'é' : 'são'} do mesmo vestibular e ano: ${sujeito}
    ${irmas.length === 1 ? 'dela' : 'delas'}.
  </span>`;
}

/** A caixa das questões sem vínculo: só aparece quando a heurística achou alguma. */
function caixaSemVinculo(impacto) {
  const orfas = impacto.orphans_heuristic;
  if (!orfas || !orfas.questions) return '';
  const irmas = Array.isArray(orfas.siblings) ? orfas.siblings : [];
  const uma = orfas.questions === 1;
  return html`
    <label class="check xrm-orphans">
      <input type="checkbox" data-xrm-orphans>
      <span>
        <strong>Incluir também ${pluralize(orfas.questions, 'questão sem vínculo', 'questões sem vínculo')}</strong>
        <span class="check-desc">
          ${uma ? 'Parece desta prova' : 'Parecem desta prova'}: mesmo vestibular, mesmo ano e origem
          "${orfas.source}", sem aula e sem IA. Mas nenhuma leitura aponta mais para ${uma ? 'ela' : 'elas'} — a que
          ${uma ? 'a gravou' : 'as gravou'} foi excluída —, então não há certeza. Questões cadastradas no formulário,
          ou com a prova de origem escolhida nele, ficam de fora.
        </span>
        ${avisoIrmas(irmas, uma ? 'ela pode ser' : 'algumas destas podem ser')}
      </span>
    </label>`;
}

/** As leituras sem prova anterior do mesmo vestibular e ano, para marcar uma por uma. */
function caixaLeiturasSoltas(impacto, escolhidas) {
  const soltas = Array.isArray(impacto.unlinked_imports) ? impacto.unlinked_imports : [];
  if (!soltas.length) return '';
  const irmas = Array.isArray(impacto.unlinked_siblings) ? impacto.unlinked_siblings : [];
  const uma = soltas.length === 1;
  return html`
    <fieldset class="xrm-soltas">
      <legend class="xrm-soltas-title">${uma ? 'Leitura feita sem escolher a prova' : 'Leituras feitas sem escolher a prova'}</legend>
      <p class="check-desc">
        ${uma ? 'Esta leitura é' : 'Estas leituras são'} do mesmo vestibular e ano, mas não ${uma ? 'está ligada' : 'estão ligadas'}
        a nenhuma prova anterior. As questões só saem ${uma ? 'se você marcar' : 'das que você marcar'}: marque só
        ${uma ? 'se ela for' : 'as que forem'} desta prova.
      </p>
      ${avisoIrmas(irmas, uma ? 'a leitura pode ser' : 'alguma destas pode ser')}
      ${soltas.map((leitura) => html`
        <label class="check xrm-solta">
          <input type="checkbox" data-xrm-import="${leitura.id}"
                 ${escolhidas.has(leitura.id) ? raw('checked') : ''} ${leitura.reading_now ? raw('disabled') : ''}>
          <span>
            <strong>${leitura.title}</strong>
            <span class="check-desc">
              ${pluralize(leitura.questions, 'questão', 'questões')} no banco${leitura.students
                ? ` · ${leitura.students === 1 ? '1 aluno respondeu' : `${fmtNumber(leitura.students)} alunos responderam`}`
                : ''} · lida em ${fmtDate(leitura.created_at)}${leitura.reading_now ? ' · varrendo agora, espere terminar' : ''}
            </span>
          </span>
        </label>`)}
    </fieldset>`;
}

function rotuloDoBotao(conta, leituras) {
  if (conta.questions) return `Apagar ${pluralize(conta.questions, 'questão', 'questões')}`;
  if (leituras.imports) return leituras.imports === 1 ? 'Apagar a leitura' : 'Apagar as leituras';
  return 'Apagar';
}

/**
 * Abre a janela de remoção.
 * @param {{ id: string, title?: string }} prova
 * @returns {Promise<object|null>} o resultado da remoção, ou null se ninguém apagou nada
 */
export function openRemoveExamQuestions(prova) {
  return new Promise((resolve) => {
    let resolvido = false;
    const terminar = (valor) => {
      if (resolvido) return;
      resolvido = true;
      resolve(valor);
    };

    const botaoId = `xrm-apagar-${Math.random().toString(36).slice(2, 8)}`;
    const corpo = document.createElement('div');
    corpo.className = 'xrm';
    render(corpo, html`<p class="xrm-loading"><span class="spinner"></span><span>Calculando o que sai junto…</span></p>`);

    let impacto = null;
    let comOrfas = false;
    let confirmou = false;
    // Leituras soltas marcadas e a conta que o servidor devolveu para elas.
    const escolhidas = new Set();
    let selecao = null;
    let recalculando = false;
    let pedido = 0;

    /** Sem leitura solta marcada, a conta já veio no primeiro pedido; com, é a da última resposta. */
    const contaAtual = () => {
      if (!escolhidas.size) return comOrfas ? impacto.with_orphans : impacto;
      return selecao || impacto;
    };
    const leiturasAtuais = () =>
      escolhidas.size && selecao
        ? { imports: selecao.imports, escolhidas: selecao.import_ids.length }
        : { imports: impacto.imports, escolhidas: 0 };
    const temAlgoParaApagar = () => Boolean(impacto && (contaAtual().questions || leiturasAtuais().imports));

    const dialogo = modal({
      title: 'Remover questões desta prova',
      subtitle: prova.title || '',
      danger: true,
      body: corpo,
      onClose: () => terminar(null),
      actions: [
        { label: 'Cancelar', variant: 'ghost' },
        {
          label: 'Apagar',
          variant: 'danger',
          icon: 'trash-2',
          id: botaoId,
          disabled: true,
          onClick: async () => {
            if (!confirmou || recalculando || !temAlgoParaApagar()) return false;
            const resultado = await api.del(`/api/admin/exam-imports/provas/${encodeURIComponent(prova.id)}/questoes`, {
              confirm: true,
              include_orphans: comOrfas,
              import_ids: [...escolhidas],
            });
            const apagadas = (resultado && resultado.removed && resultado.removed.questions) || 0;
            toast(
              apagadas
                ? `${pluralize(apagadas, 'questão apagada', 'questões apagadas')}. A prova já pode ser lida de novo.`
                : 'Leituras apagadas. A prova já pode ser lida de novo.',
              { type: 'success' }
            );
            terminar(resultado);
            return resultado;
          },
        },
      ],
    });

    const botao = () => qs(`#${botaoId}`, dialogo.footer);

    /** Atualiza só o que muda com as caixas e com o que foi digitado. */
    function atualizar() {
      const conta = contaAtual();
      const leituras = leiturasAtuais();
      const alvo = qs('[data-xrm-resumo]', corpo);
      if (alvo) {
        render(
          alvo,
          recalculando
            ? html`<p class="xrm-loading"><span class="spinner"></span><span>Refazendo a conta…</span></p>`
            : html`${resumo(conta)}${detalhes(conta, leituras)}`
        );
      }
      const b = botao();
      if (b) {
        const span = b.querySelector('span');
        if (span) span.textContent = rotuloDoBotao(conta, leituras);
        b.disabled = !(confirmou && !recalculando && temAlgoParaApagar() && !impacto.reading_now);
      }
    }

    /** Pede a conta da escolha atual. Só a resposta do último pedido vale. */
    function recalcular() {
      if (!escolhidas.size) {
        selecao = null;
        recalculando = false;
        atualizar();
        return;
      }
      pedido += 1;
      const este = pedido;
      recalculando = true;
      atualizar();
      api
        .get(`/api/admin/exam-imports/provas/${encodeURIComponent(prova.id)}/questoes/impacto`, {
          query: { include_orphans: comOrfas ? 'true' : undefined, import_ids: [...escolhidas] },
        })
        .then((dados) => {
          if (resolvido || este !== pedido) return;
          selecao = dados.selected;
          recalculando = false;
          atualizar();
        })
        .catch((err) => {
          if (resolvido || este !== pedido) return;
          recalculando = false;
          toast((err && err.message) || 'Não foi possível refazer a conta. Tente marcar de novo.', { type: 'error' });
          // sem a conta certa, a marcação volta atrás
          escolhidas.clear();
          for (const caixa of qsa('[data-xrm-import]', corpo)) caixa.checked = false;
          selecao = null;
          atualizar();
        });
    }

    function pintar() {
      const ano = impacto.past_exam && impacto.past_exam.year ? String(impacto.past_exam.year) : '';
      const temSoltas = Array.isArray(impacto.unlinked_imports) && impacto.unlinked_imports.length > 0;
      if (!temAlgoParaApagar() && !(impacto.orphans_heuristic && impacto.orphans_heuristic.questions) && !temSoltas) {
        render(corpo, html`<div data-xrm-resumo></div>`);
        atualizar();
        const b = botao();
        if (b) b.hidden = true;
        return;
      }
      render(
        corpo,
        html`
          ${impacto.reading_now
            ? alertBox({
              type: 'warning',
              title: 'Uma leitura desta prova está varrendo agora',
              text: 'Espere a varredura parar para remover as questões.',
            })
            : ''}
          <div data-xrm-resumo></div>
          ${caixaLeiturasSoltas(impacto, escolhidas)}
          ${caixaSemVinculo(impacto)}
          <p class="xrm-note">Isso não tem volta. As questões não vão para uma lixeira.</p>
          <div class="field xrm-confirm">
            <label class="label" for="${botaoId}-texto">
              <span>Para confirmar, digite ${ano ? html`<strong>${ano}</strong> (o ano da prova) ou ` : ''}<strong>${PALAVRA}</strong></span>
            </label>
            <input class="input" id="${botaoId}-texto" data-xrm-texto autocomplete="off" spellcheck="false"
                   autocapitalize="characters" inputmode="text">
          </div>`
      );

      const caixa = qs('[data-xrm-orphans]', corpo);
      if (caixa) {
        caixa.addEventListener('change', () => {
          comOrfas = caixa.checked;
          // com leitura solta marcada, a conta das duas juntas vem do servidor
          if (escolhidas.size) recalcular();
          else atualizar();
        });
      }
      for (const leitura of qsa('[data-xrm-import]', corpo)) {
        leitura.addEventListener('change', () => {
          if (leitura.checked) escolhidas.add(leitura.dataset.xrmImport);
          else escolhidas.delete(leitura.dataset.xrmImport);
          recalcular();
        });
      }
      const campo = qs('[data-xrm-texto]', corpo);
      if (campo) {
        campo.addEventListener('input', () => {
          const digitado = campo.value.trim();
          confirmou = digitado.toUpperCase() === PALAVRA || (ano !== '' && digitado === ano);
          atualizar();
        });
        campo.addEventListener('keydown', (event) => {
          const b = botao();
          if (event.key === 'Enter' && b && !b.disabled) {
            event.preventDefault();
            b.click();
          }
        });
      }
      atualizar();
    }

    api
      .get(`/api/admin/exam-imports/provas/${encodeURIComponent(prova.id)}/questoes/impacto`)
      .then((dados) => {
        if (resolvido) return;
        impacto = dados;
        pintar();
      })
      .catch((err) => {
        if (resolvido) return;
        render(
          corpo,
          alertBox({
            type: 'danger',
            title: 'Não foi possível calcular o que sai junto',
            text: (err && err.message) || 'Tente de novo em instantes.',
          })
        );
      });
  });
}
