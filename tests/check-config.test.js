'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findPendingMigrations, toBool } = require('../scripts/check-config');

describe('Conferência de configuração', () => {
  it('encontra as migrations que existem no projeto, mas ainda não foram aplicadas', () => {
    const files = ['001_init.sql', '100_landing.sql', '210_exam_imports.sql'];
    const applied = ['001_init.sql', '100_landing.sql', 'migration_antiga.sql'];

    assert.deepEqual(findPendingMigrations(files, applied), ['210_exam_imports.sql']);
  });

  it('não confunde um registro antigo sem arquivo com migration pendente', () => {
    assert.deepEqual(findPendingMigrations(['001_init.sql'], ['001_init.sql', 'migration_antiga.sql']), []);
  });

  it('entende o valor booleano salvo no JSONB de settings', () => {
    assert.equal(toBool(true), true);
    assert.equal(toBool(false), false);
    assert.equal(toBool('sim'), true);
    assert.equal(toBool('false'), false);
  });
});
