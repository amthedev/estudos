'use strict';

/**
 * Painel administrativo — envio de arquivos.
 *
 *   POST   /api/admin/uploads?folder=logos&filename=logo.png   corpo bruto do arquivo
 *   GET    /api/admin/uploads?folder=&limit=                   lista o que já foi enviado
 *   DELETE /api/admin/uploads                                  { url }
 *
 * O corpo vem cru (sem multipart) para o painel poder mandar o próprio objeto
 * File do navegador direto no fetch, sem depender de biblioteca. O arquivo é
 * gravado em fluxo, então videoaula grande não passa pela memória:
 *
 *   fetch('/api/admin/uploads?folder=logos&filename=' + encodeURIComponent(file.name), {
 *     method: 'POST',
 *     headers: { 'Content-Type': file.type, 'X-Requested-With': 'FocoElite' },
 *     body: file,
 *   })
 *
 * A resposta traz a URL pronta para colar em qualquer campo de imagem ou PDF
 * (logo do vestibular, print de depoimento, edital, prova, capa de aula).
 */
const router = require('express').Router();
const { validate, z } = require('../../middleware/validate');
const { AppError, wrap } = require('../../middleware/errors');
const { audit } = require('../../middleware/audit');
const uploads = require('../../services/uploads');

const folderEnum = z.enum(uploads.FOLDERS);

const uploadQuery = z.object({
  folder: z.preprocess((v) => (v === '' ? undefined : v), folderEnum.optional()),
  filename: z.string().trim().max(200).optional(),
});

const listQuery = z.object({
  folder: z.preprocess((v) => (v === '' ? undefined : v), folderEnum.optional()),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

/** Erros do serviço viram resposta de API em português. */
const STATUS_BY_CODE = {
  empty_file: [400, 'validation_error'],
  unsupported_type: [415, 'unsupported_type'],
  too_large: [413, 'too_large'],
  invalid_path: [400, 'validation_error'],
  storage_not_configured: [503, 'storage_unavailable'],
  storage_timeout: [504, 'storage_unavailable'],
  storage_error: [502, 'storage_unavailable'],
};

function toAppError(err) {
  const mapped = STATUS_BY_CODE[err.code];
  if (!mapped) return err;
  return new AppError(mapped[0], mapped[1], err.message);
}

router.post(
  '/',
  validate({ query: uploadQuery }),
  wrap(async (req, res) => {
    // o corpo não é lido por nenhum middleware: a requisição é gravada em
    // fluxo direto no disco, para aguentar videoaula de centenas de megabytes
    try {
      const saved = await uploads.saveStream(req, {
        contentType: req.get('content-type'),
        filename: req.valid.query.filename,
        folder: req.valid.query.folder,
      });
      await audit(req, 'upload.create', 'upload', null, {
        url: saved.url,
        bytes: saved.bytes,
        content_type: saved.content_type,
        reused: saved.reused,
      });
      res.status(201).json(saved);
    } catch (err) {
      throw toAppError(err);
    }
  })
);

router.get(
  '/',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const [items, storage] = await Promise.all([uploads.list(req.valid.query), uploads.status()]);
    res.json({ items, total: items.length, folders: uploads.FOLDERS, storage });
  })
);

router.delete(
  '/',
  validate({ body: z.object({ url: z.string().trim().min(1, 'Informe o arquivo.').max(500) }) }),
  wrap(async (req, res) => {
    const { url } = req.valid.body;
    try {
      await uploads.remove(url);
    } catch (err) {
      throw toAppError(err);
    }
    await audit(req, 'upload.delete', 'upload', null, { url });
    res.json({ ok: true });
  })
);

module.exports = { basePath: '/api/admin/uploads', router };
