// =====================================================================
// Foco Elite — páginas de autenticação
// Um único módulo para login, cadastro, recuperação e redefinição de senha
// e login do painel. A página é identificada por <body data-page="...">:
//   login | register | forgot | reset | admin-login
// =====================================================================
import { api } from './core/api.js';
import { html, render, qs, qsa, setLoading, fieldError, clearFieldErrors, applyApiErrors } from './core/ui.js';
import { icon } from './core/icons.js';

const REMEMBER_KEY = 'fe.login.email';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const page = document.body.dataset.page || '';
const form = qs('#auth-form');
const alertBox = qs('#form-alert');

// ---------------------------------------------------------------------
// Utilidades comuns
// ---------------------------------------------------------------------
function showAlert(type, message, { title = '' } = {}) {
  if (!alertBox) return;
  const icons = { info: 'info', success: 'circle-check', warning: 'triangle-alert', danger: 'circle-alert' };
  render(
    alertBox,
    html`
      <div class="alert alert-${type}">
        ${icon(icons[type] || 'info')}
        <div class="alert-body">
          ${title ? html`<div class="alert-title">${title}</div>` : ''}
          <div class="alert-text">${message}</div>
        </div>
      </div>`
  );
  alertBox.hidden = false;
}

function hideAlert() {
  if (!alertBox) return;
  alertBox.hidden = true;
  alertBox.innerHTML = '';
}

/** Só aceita caminhos internos ("/app/...") como destino pós-login. */
function safeNext(value, fallback = '/app') {
  if (!value || typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\r\n]/.test(value)) return fallback;
  return value;
}

function queryParam(name) {
  return new URLSearchParams(location.search).get(name);
}

function initYear() {
  qsa('[data-year]').forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });
}

/** Botões "mostrar/ocultar senha" ([data-toggle-password] dentro de .password-field). */
function initPasswordToggles() {
  qsa('[data-toggle-password]').forEach((btn) => {
    const wrap = btn.closest('.password-field');
    const input = wrap ? wrap.querySelector('input') : null;
    if (!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
      btn.innerHTML = String(icon(show ? 'eye-off' : 'eye'));
      input.focus({ preventScroll: true });
    });
  });
}

/** Pontuação de 0 a 4 para o indicador de força. */
function passwordScore(value) {
  const v = String(value || '');
  if (!v) return 0;
  if (v.length < 8) return 1;
  let variety = 0;
  if (/[a-z]/.test(v)) variety += 1;
  if (/[A-Z]/.test(v)) variety += 1;
  if (/\d/.test(v)) variety += 1;
  if (/[^A-Za-z0-9]/.test(v)) variety += 1;
  let score = 1;
  if (variety >= 2) score = 2;
  if (variety >= 3 && v.length >= 10) score = 3;
  if ((variety >= 3 && v.length >= 12) || (variety === 4 && v.length >= 10)) score = 4;
  if (v.length >= 16 && variety >= 2) score = Math.max(score, 3);
  return score;
}

const STRENGTH_LABELS = {
  0: 'Use pelo menos 8 caracteres',
  1: 'Fraca — use mais caracteres',
  2: 'Razoável — combine letras, números e símbolos',
  3: 'Boa',
  4: 'Forte',
};

function updateStrength(meter, value) {
  if (!meter) return;
  const level = value ? passwordScore(value) : 0;
  meter.dataset.level = String(level);
  const label = qs('.strength-label', meter);
  if (label) label.textContent = STRENGTH_LABELS[level];
}

/** Liga a validação em tempo real: valida no blur e revalida a cada digitação após o primeiro erro. */
function liveValidate(input, validate) {
  if (!input) return;
  let touched = false;
  const run = () => {
    const message = validate(input.value);
    fieldError(form, input.name, message || '');
    return !message;
  };
  input.addEventListener('blur', () => {
    touched = true;
    run();
  });
  input.addEventListener('input', () => {
    if (touched || input.classList.contains('is-invalid')) run();
  });
  return run;
}

/**
 * Envia o formulário com estado de carregamento e tratamento padrão de erros.
 * `validate()` devolve true quando os campos estão válidos; `submit()` faz a chamada.
 */
function bindSubmit({ validate, submit }) {
  if (!form) return;
  const button = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    clearFieldErrors(form);
    if (typeof validate === 'function' && !validate()) {
      const firstInvalid = form.querySelector('.is-invalid');
      if (firstInvalid) firstInvalid.focus();
      return;
    }
    setLoading(button, true);
    try {
      await submit();
    } catch (err) {
      handleError(err);
      setLoading(button, false);
      return;
    }
    // sucesso: a página redireciona; mantém o botão em carregamento
  });
}

function handleError(err) {
  if (!err) return;
  const applied = err.details ? applyApiErrors(form, err) : false;
  if (applied) {
    const firstInvalid = form.querySelector('.is-invalid');
    if (firstInvalid) firstInvalid.focus();
    if (err.status !== 400) showAlert('danger', err.message || 'Revise os campos destacados.');
    return;
  }
  if (err.status === 429) {
    showAlert('warning', err.message || 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.');
    return;
  }
  if (err.status === 0) {
    showAlert('danger', 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.');
    return;
  }
  showAlert('danger', err.message || 'Não foi possível concluir. Tente novamente.');
}

const validators = {
  email(value) {
    const v = String(value || '').trim();
    if (!v) return 'Informe seu e-mail.';
    if (!EMAIL_RE.test(v)) return 'Informe um e-mail válido.';
    return '';
  },
  password(value, { min = 8 } = {}) {
    const v = String(value || '');
    if (!v) return 'Informe a senha.';
    if (v.length < min) return `A senha deve ter pelo menos ${min} caracteres.`;
    if (v.length > 128) return 'A senha deve ter no máximo 128 caracteres.';
    return '';
  },
  name(value) {
    const v = String(value || '').trim();
    if (!v) return 'Informe seu nome completo.';
    if (v.length < 2) return 'Informe seu nome completo.';
    if (v.length > 120) return 'O nome deve ter no máximo 120 caracteres.';
    return '';
  },
  confirm(value, original) {
    if (!value) return 'Confirme a senha.';
    if (value !== original) return 'As senhas não coincidem.';
    return '';
  },
};

// ---------------------------------------------------------------------
// Login do aluno
// ---------------------------------------------------------------------
function initLogin() {
  const email = qs('[name="email"]', form);
  const password = qs('[name="password"]', form);
  const remember = qs('[name="remember"]', form);
  const next = safeNext(queryParam('next'), '/app');

  try {
    const saved = localStorage.getItem(REMEMBER_KEY);
    if (saved && email && !email.value) {
      email.value = saved;
      if (remember) remember.checked = true;
      if (password) password.focus();
    }
  } catch {
    /* armazenamento indisponível */
  }

  if (queryParam('reset') === '1') showAlert('success', 'Senha redefinida. Entre com a nova senha.');
  else if (queryParam('registered') === '1') showAlert('success', 'Conta criada. Entre para começar.');
  else if (queryParam('next')) showAlert('info', 'Entre para continuar de onde parou.');

  const checkEmail = liveValidate(email, validators.email);
  const checkPassword = liveValidate(password, (v) => (v ? '' : 'Informe a senha.'));

  bindSubmit({
    validate: () => [checkEmail(), checkPassword()].every(Boolean),
    submit: async () => {
      await api.post('/api/auth/login', { email: email.value.trim(), password: password.value }, { noRedirect: true });
      try {
        if (remember && remember.checked) localStorage.setItem(REMEMBER_KEY, email.value.trim());
        else localStorage.removeItem(REMEMBER_KEY);
      } catch {
        /* armazenamento indisponível */
      }
      location.assign(next);
    },
  });
}

// ---------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------
function initRegister() {
  const name = qs('[name="name"]', form);
  const email = qs('[name="email"]', form);
  const password = qs('[name="password"]', form);
  const confirm = qs('[name="password_confirm"]', form);
  const meter = qs('[data-strength]', form);

  const checkName = liveValidate(name, validators.name);
  const checkEmail = liveValidate(email, validators.email);
  const checkPassword = liveValidate(password, (v) => validators.password(v));
  const checkConfirm = liveValidate(confirm, (v) => validators.confirm(v, password.value));

  password.addEventListener('input', () => {
    updateStrength(meter, password.value);
    if (confirm.value) checkConfirm();
  });
  updateStrength(meter, '');

  bindSubmit({
    validate: () => [checkName(), checkEmail(), checkPassword(), checkConfirm()].every(Boolean),
    submit: async () => {
      await api.post(
        '/api/auth/register',
        { name: name.value.trim(), email: email.value.trim(), password: password.value },
        { noRedirect: true }
      );
      location.assign('/app/onboarding');
    },
  });
}

// ---------------------------------------------------------------------
// Recuperar senha
// ---------------------------------------------------------------------
function initForgot() {
  const email = qs('[name="email"]', form);
  const checkEmail = liveValidate(email, validators.email);
  const card = form.closest('.auth-card');

  bindSubmit({
    validate: () => checkEmail(),
    submit: async () => {
      await api.post('/api/auth/forgot-password', { email: email.value.trim() }, { noRedirect: true });
      render(
        card,
        html`
          <div class="auth-success">
            <div class="auth-success-icon">${icon('mail')}</div>
            <h2>Verifique seu e-mail</h2>
            <p>Se o e-mail existir, enviamos as instruções para <strong>${email.value.trim()}</strong>. O link vale por 60 minutos. Confira também a caixa de spam.</p>
            <a class="btn btn-secondary" href="/login">${icon('arrow-left')}<span>Voltar ao login</span></a>
          </div>`
      );
    },
  });
}

// ---------------------------------------------------------------------
// Redefinir senha
// ---------------------------------------------------------------------
function initReset() {
  const token = (queryParam('token') || '').trim();
  const password = qs('[name="password"]', form);
  const confirm = qs('[name="password_confirm"]', form);
  const meter = qs('[data-strength]', form);
  const button = form.querySelector('button[type="submit"]');

  if (!token || token.length < 20) {
    showAlert('danger', 'Este link é inválido ou está incompleto. Solicite uma nova recuperação de senha.', { title: 'Link inválido' });
    qsa('input, button', form).forEach((el) => {
      el.disabled = true;
    });
    return;
  }

  const checkPassword = liveValidate(password, (v) => validators.password(v));
  const checkConfirm = liveValidate(confirm, (v) => validators.confirm(v, password.value));
  password.addEventListener('input', () => {
    updateStrength(meter, password.value);
    if (confirm.value) checkConfirm();
  });
  updateStrength(meter, '');

  bindSubmit({
    validate: () => [checkPassword(), checkConfirm()].every(Boolean),
    submit: async () => {
      try {
        await api.post('/api/auth/reset-password', { token, password: password.value }, { noRedirect: true });
      } catch (err) {
        // token expirado/inválido chega como validation_error sem campo: mostra como alerta com ação
        if (err && err.status === 400 && !err.details) {
          showAlert('danger', err.message, { title: 'Não foi possível redefinir' });
          setLoading(button, false);
          return;
        }
        throw err;
      }
      location.assign('/login?reset=1');
    },
  });
}

// ---------------------------------------------------------------------
// Login do painel administrativo
// ---------------------------------------------------------------------
/**
 * Login do painel — e, quando ainda não existe nenhum administrador, a
 * própria tela de configuração inicial no lugar do login. `bindSubmit` só
 * pode ser chamada uma vez aqui: ela pendura um listener no formulário, e
 * chamar de novo empilharia um segundo em cima, disparando login e criação
 * juntos no mesmo clique. Por isso o modo é decidido ANTES de vincular
 * qualquer coisa, nunca depois.
 */
async function initAdminLogin() {
  const name = qs('[name="name"]', form);
  const email = qs('[name="email"]', form);
  const password = qs('[name="password"]', form);
  const confirm = qs('[name="password_confirm"]', form);
  const meter = qs('[data-strength]', form);
  const card = form.closest('.auth-card') || form;

  let setupNeeded = false;
  try {
    const status = await api.get('/api/admin/auth/setup-status', { noRedirect: true });
    setupNeeded = Boolean(status && status.needed);
  } catch {
    setupNeeded = false; // falhou a checagem: fica no login normal, que é o seguro por padrão
  }

  if (!setupNeeded) {
    const checkEmail = liveValidate(email, validators.email);
    const checkPassword = liveValidate(password, (v) => (v ? '' : 'Informe a senha.'));
    bindSubmit({
      validate: () => [checkEmail(), checkPassword()].every(Boolean),
      submit: async () => {
        await api.post('/api/admin/auth/login', { email: email.value.trim(), password: password.value }, { noRedirect: true });
        location.assign('/admin');
      },
    });
    return;
  }

  // Ninguém configurou o administrador ainda: troca a tela para o modo de
  // primeira configuração, com os campos extras de nome e confirmação.
  qsa('[data-mode-badge="login"], [data-mode-title="login"], [data-mode-subtitle="login"]', card).forEach((el) => { el.hidden = true; });
  qsa('[data-mode-badge="setup"], [data-mode-title="setup"], [data-mode-subtitle="setup"]', card).forEach((el) => { el.hidden = false; });
  qsa('[data-setup-only]', form).forEach((el) => { el.hidden = false; });
  qs('[data-mode-submit="login"]', form).hidden = true;
  qs('[data-mode-submit="setup"]', form).hidden = false;
  name.required = true;
  confirm.required = true;
  password.setAttribute('autocomplete', 'new-password');
  password.setAttribute('minlength', '8');

  const checkName = liveValidate(name, validators.name);
  const checkEmail = liveValidate(email, validators.email);
  const checkPassword = liveValidate(password, (v) => validators.password(v));
  const checkConfirm = liveValidate(confirm, (v) => validators.confirm(v, password.value));

  password.addEventListener('input', () => {
    updateStrength(meter, password.value);
    if (confirm.value) checkConfirm();
  });
  updateStrength(meter, '');

  bindSubmit({
    validate: () => [checkName(), checkEmail(), checkPassword(), checkConfirm()].every(Boolean),
    submit: async () => {
      await api.post(
        '/api/admin/auth/setup',
        { name: name.value.trim(), email: email.value.trim(), password: password.value },
        { noRedirect: true }
      );
      location.assign('/admin');
    },
  });
}

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------
initYear();
initPasswordToggles();

const handlers = {
  login: initLogin,
  register: initRegister,
  forgot: initForgot,
  reset: initReset,
  'admin-login': initAdminLogin,
};

if (form && handlers[page]) {
  handlers[page]();
  const first = form.querySelector('input:not([type="hidden"]):not([disabled])');
  if (first && !first.value && !document.activeElement?.matches?.('input')) first.focus({ preventScroll: true });
}
