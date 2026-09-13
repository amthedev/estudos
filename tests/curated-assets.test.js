'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pastExams } = require('../server/db/seed/data/curated_assets');

describe('Acervo de provas combinado com o cliente', () => {
  it('publica nove anos de ENEM PPL, com os dois dias e seus gabaritos', () => {
    const ppl = pastExams.filter((prova) => /PPL/.test(prova.title));

    assert.equal(ppl.length, 18, 'nove aplicações completas têm dois dias cada');
    assert.deepEqual(
      [...new Set(ppl.map((prova) => prova.year))].sort(),
      [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]
    );
    // Cada ano precisa dos dois dias: faltar um dia é meia prova no acervo.
    for (const ano of new Set(ppl.map((prova) => prova.year))) {
      const dias = ppl.filter((prova) => prova.year === ano).map((prova) => prova.day).sort();
      assert.deepEqual(dias, [1, 2], `PPL ${ano} precisa dos dias 1 e 2`);
    }
    for (const prova of ppl) {
      assert.match(prova.pdf_url, /^https:\/\/public-blob\.squarecloud\.dev\//);
      assert.match(prova.answer_key_url, /^https:\/\/public-blob\.squarecloud\.dev\//);
      assert.equal(prova.exam, 'enem');
      assert.equal(prova.board, 'INEP');
    }
  });
});
