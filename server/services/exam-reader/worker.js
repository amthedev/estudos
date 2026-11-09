'use strict';

/**
 * Processo filho da leitura de prova.
 *
 * O pdf.js e o canvas seguram a prova inteira e as figuras renderizadas na
 * memória, e uma prova grande passava de várias centenas de MB dentro do
 * processo do site — com o limite de 1 GB da hospedagem, o site caía junto.
 * Aqui a leitura roda em processo próprio (com teto de memória dado por quem
 * abre), e toda a memória volta ao sistema quando ele termina.
 *
 * Recebe { file, options } (options.regionAlerts no lugar da função `regions`) pelo IPC, lê o PDF do arquivo temporário e devolve
 * { ok: true, result } ou { ok: false, error: { message, code } }.
 */
const fs = require('node:fs');
const { readExam } = require('./index');

process.on('message', async ({ file, options }) => {
  try {
    const buffer = await fs.promises.readFile(file);
    const { regionAlerts, ...rest } = options || {};
    // função não passa pelo IPC: chega a lista de alertas que pedem a região
    const regions = Array.isArray(regionAlerts)
      ? (q) => Boolean(q && (q.alerts || []).some((a) => regionAlerts.includes(a)))
      : null;
    const result = await readExam(buffer, { ...rest, regions });
    process.send({ ok: true, result }, () => process.exit(0));
  } catch (err) {
    process.send(
      { ok: false, error: { message: err && err.message, code: err && err.code } },
      () => process.exit(0)
    );
  }
});
