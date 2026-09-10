'use strict';

/**
 * Validadores compartilhados de endereço de arquivo.
 *
 * Desde que o painel passou a enviar os próprios arquivos, um campo de imagem,
 * PDF ou vídeo pode conter tanto um endereço externo (https://…) quanto um
 * caminho servido pela plataforma (/uploads/…, /assets/…). Exigir URL absoluta
 * recusaria justamente o que foi enviado pelo painel.
 */
const { z } = require('zod');

const ABSOLUTE = /^https?:\/\/\S+$/i;
const INTERNAL = /^\/[A-Za-z0-9._~\-/%]+$/;

/** Aceita URL absoluta ou caminho interno começando com "/". */
function fileRef(max = 2000, message = 'Informe um endereço válido ou envie o arquivo.') {
  return z
    .string()
    .trim()
    .max(max)
    .refine((value) => ABSOLUTE.test(value) || INTERNAL.test(value), message);
}

/** Versão opcional que trata string vazia como ausência de valor. */
function nullableFileRef(max = 2000, message) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    fileRef(max, message).nullable().optional()
  );
}

/** Verdadeiro para um arquivo servido pela própria plataforma. */
function isInternalFile(value) {
  return INTERNAL.test(String(value || '').trim());
}

module.exports = { fileRef, nullableFileRef, isInternalFile };
