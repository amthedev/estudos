'use strict';

// Teste de fumaça estático: páginas e arquivos críticos respondem, todos os ES modules do
// frontend têm sintaxe válida e todo import relativo resolve para um arquivo existente que
// exporta os nomes importados. Protege os módulos contra quebras de integração no front.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTestContext } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const JS_ROOT = path.join(PUBLIC, 'js');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function exportedNames(source) {
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(source))) names.add(m[1]);
  const braces = /export\s*\{([^}]*)\}/g;
  while ((m = braces.exec(source))) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/);
      const name = (alias[1] || alias[0]).trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

function importsOf(source) {
  const out = [];
  const re = /import\s+(?:([^'";]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) {
    const spec = m[2];
    const clause = (m[1] || '').trim();
    const names = [];
    if (clause) {
      const braces = clause.match(/\{([^}]*)\}/);
      if (braces) {
        for (const part of braces[1].split(',')) {
          const alias = part.trim().split(/\s+as\s+/)[0].trim();
          if (alias) names.push(alias);
        }
      }
      const defaultPart = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
      if (defaultPart && !defaultPart.startsWith('*')) names.push('default');
    }
    out.push({ spec, names });
  }
  return out;
}

describe('Front estático: páginas, sintaxe dos módulos e imports', () => {
  let ctx;

  before(async () => {
    ctx = await createTestContext({ reset: false });
  });

  after(async () => {
    await ctx.close();
  });

  it('páginas HTML e arquivos críticos respondem 200', async () => {
    const paths = [
      '/', '/login', '/cadastro', '/recuperar-senha', '/redefinir-senha',
      '/app', '/app/cronograma', '/admin', '/admin/login',
      '/css/app.css', '/css/admin.css', '/js/app/shell.js', '/js/admin/shell.js',
      '/js/core/router.js', '/js/core/api.js', '/assets/icons.svg', '/assets/logo.svg',
      '/vendor/chart.umd.js', '/vendor/marked.min.js', '/vendor/purify.min.js',
    ];
    for (const p of paths) {
      const res = await ctx.request('GET', p);
      assert.equal(res.status, 200, `${p} deveria responder 200`);
    }
  });

  it('todos os @import de app.css e admin.css apontam para arquivos existentes', () => {
    for (const entry of ['app.css', 'admin.css']) {
      const css = fs.readFileSync(path.join(PUBLIC, 'css', entry), 'utf8');
      const re = /@import\s+(?:url\()?['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(css))) {
        if (/^https?:/.test(m[1])) continue;
        const target = path.join(PUBLIC, 'css', m[1]);
        assert.ok(fs.existsSync(target), `${entry} importa ${m[1]}, que não existe`);
      }
    }
  });

  it('todos os ES modules do front têm sintaxe válida', () => {
    const files = walk(JS_ROOT);
    assert.ok(files.length > 10, 'esperava encontrar módulos em public/js');
    const failures = [];
    for (const file of files) {
      try {
        execFileSync(process.execPath, ['--input-type=module', '--check'], {
          input: fs.readFileSync(file),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        failures.push(`${path.relative(PUBLIC, file)}: ${String(err.stderr || err.message).split('\n').slice(0, 3).join(' | ')}`);
      }
    }
    assert.deepEqual(failures, [], `módulos com erro de sintaxe:\n${failures.join('\n')}`);
  });

  it('todo import relativo resolve e os nomes importados são exportados', () => {
    const files = walk(JS_ROOT);
    const exportsCache = new Map();
    const problems = [];
    const getExports = (file) => {
      if (!exportsCache.has(file)) exportsCache.set(file, exportedNames(fs.readFileSync(file, 'utf8')));
      return exportsCache.get(file);
    };
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const imp of importsOf(source)) {
        if (!imp.spec.startsWith('.') && !imp.spec.startsWith('/')) continue;
        const target = imp.spec.startsWith('/')
          ? path.join(PUBLIC, imp.spec)
          : path.resolve(path.dirname(file), imp.spec);
        if (!fs.existsSync(target)) {
          problems.push(`${path.relative(PUBLIC, file)} importa ${imp.spec} (arquivo inexistente)`);
          continue;
        }
        const names = getExports(target);
        for (const name of imp.names) {
          if (!names.has(name)) problems.push(`${path.relative(PUBLIC, file)} importa "${name}" de ${imp.spec}, que não o exporta`);
        }
      }
    }
    assert.deepEqual(problems, [], `imports quebrados:\n${problems.join('\n')}`);
  });

  it('as páginas listadas nos manifestos de rotas existem', () => {
    const missing = [];
    for (const [manifest, base] of [['app', 'app/pages'], ['admin', 'admin/pages']]) {
      const src = fs.readFileSync(path.join(JS_ROOT, manifest, 'routes.js'), 'utf8');
      const re = /import\(['"]\.\/pages\/([^'"]+)['"]\)/g;
      let m;
      const seen = new Set();
      while ((m = re.exec(src))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        if (!fs.existsSync(path.join(JS_ROOT, base, m[1]))) missing.push(`${base}/${m[1]}`);
      }
    }
    assert.deepEqual(missing, [], `páginas ausentes:\n${missing.join('\n')}`);
  });
});
