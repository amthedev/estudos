'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pastExams } = require('../server/db/seed/data/curated_assets');

describe('Acervo de provas combinado com o cliente', () => {
  it('publica três anos de ENEM PPL, com os dois dias e seus gabaritos', () => {
    const ppl = pastExams.filter((prova) => /PPL/.test(prova.title));

    assert.equal(ppl.length, 6, 'três aplicações completas têm dois dias cada');
    assert.deepEqual([...new Set(ppl.map((prova) => prova.year))].sort(), [2022, 2023, 2024]);
    for (const prova of ppl) {
      assert.match(prova.pdf_url, /^https:\/\/public-blob\.squarecloud\.dev\//);
      assert.match(prova.answer_key_url, /^https:\/\/public-blob\.squarecloud\.dev\//);
      assert.equal(prova.exam, 'enem');
      assert.equal(prova.board, 'INEP');
    }
  });
});
