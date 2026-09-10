'use strict';

/**
 * Validação de entrada com zod.
 *
 *   router.post('/', validate({ body: z.object({ name: z.string().min(2) }) }), wrap(async (req, res) => {
 *     const { name } = req.valid.body;
 *   }));
 *
 * Em caso de falha responde 400 validation_error com details: [{ path, message }] em português.
 * Também instala um errorMap global do zod em português, valendo para todos os schemas do projeto.
 */
const { z } = require('zod');
const { AppError } = require('./errors');

const TYPE_NAMES = {
  string: 'texto',
  number: 'número',
  integer: 'número inteiro',
  boolean: 'verdadeiro ou falso',
  array: 'lista',
  object: 'objeto',
  date: 'data',
  null: 'nulo',
  undefined: 'indefinido',
  nan: 'número',
  bigint: 'número',
};

const typeName = (type) => TYPE_NAMES[type] || type;

/** Mapa de mensagens do zod em português do Brasil. */
function ptBrErrorMap(issue, ctx) {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null') return { message: 'Campo obrigatório.' };
      return { message: `Tipo inválido: esperado ${typeName(issue.expected)}, recebido ${typeName(issue.received)}.` };
    case z.ZodIssueCode.invalid_literal:
      return { message: `Valor inválido. Esperado: ${JSON.stringify(issue.expected)}.` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `Campo(s) não reconhecido(s): ${issue.keys.join(', ')}.` };
    case z.ZodIssueCode.invalid_union:
    case z.ZodIssueCode.invalid_union_discriminator:
    case z.ZodIssueCode.invalid_arguments:
    case z.ZodIssueCode.invalid_return_type:
    case z.ZodIssueCode.invalid_intersection_types:
      return { message: 'Valor inválido.' };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Valor inválido. Opções: ${issue.options.map(String).join(', ')}.` };
    case z.ZodIssueCode.invalid_date:
      return { message: 'Data inválida.' };
    case z.ZodIssueCode.invalid_string: {
      const validation = typeof issue.validation === 'string' ? issue.validation : 'formato';
      const messages = {
        email: 'E-mail inválido.',
        url: 'URL inválida.',
        uuid: 'Identificador inválido.',
        regex: 'Formato inválido.',
        datetime: 'Data e hora inválidas.',
        date: 'Data inválida (use AAAA-MM-DD).',
        time: 'Horário inválido (use HH:MM).',
        cuid: 'Identificador inválido.',
        ip: 'Endereço IP inválido.',
        emoji: 'Valor inválido.',
      };
      if (messages[validation]) return { message: messages[validation] };
      if (issue.validation && typeof issue.validation === 'object') {
        if ('startsWith' in issue.validation) return { message: `Deve começar com "${issue.validation.startsWith}".` };
        if ('endsWith' in issue.validation) return { message: `Deve terminar com "${issue.validation.endsWith}".` };
        if ('includes' in issue.validation) return { message: `Deve conter "${issue.validation.includes}".` };
      }
      return { message: 'Formato inválido.' };
    }
    case z.ZodIssueCode.too_small: {
      const min = Number(issue.minimum);
      if (issue.type === 'string') {
        if (min === 1) return { message: 'Campo obrigatório.' };
        return { message: `Deve ter pelo menos ${min} caracteres.` };
      }
      if (issue.type === 'array') return { message: `Informe pelo menos ${min} ${min === 1 ? 'item' : 'itens'}.` };
      if (issue.type === 'number' || issue.type === 'bigint') {
        return { message: issue.inclusive ? `Deve ser maior ou igual a ${min}.` : `Deve ser maior que ${min}.` };
      }
      if (issue.type === 'date') return { message: 'Data anterior ao mínimo permitido.' };
      return { message: 'Valor abaixo do mínimo permitido.' };
    }
    case z.ZodIssueCode.too_big: {
      const max = Number(issue.maximum);
      if (issue.type === 'string') return { message: `Deve ter no máximo ${max} caracteres.` };
      if (issue.type === 'array') return { message: `Informe no máximo ${max} ${max === 1 ? 'item' : 'itens'}.` };
      if (issue.type === 'number' || issue.type === 'bigint') {
        return { message: issue.inclusive ? `Deve ser menor ou igual a ${max}.` : `Deve ser menor que ${max}.` };
      }
      if (issue.type === 'date') return { message: 'Data posterior ao máximo permitido.' };
      return { message: 'Valor acima do máximo permitido.' };
    }
    case z.ZodIssueCode.not_multiple_of:
      return { message: `Deve ser múltiplo de ${issue.multipleOf}.` };
    case z.ZodIssueCode.not_finite:
      return { message: 'Deve ser um número finito.' };
    case z.ZodIssueCode.custom:
      return { message: issue.message || 'Valor inválido.' };
    default:
      return { message: ctx.defaultError === 'Invalid input' ? 'Valor inválido.' : ctx.defaultError };
  }
}

z.setErrorMap(ptBrErrorMap);

/** Detalhes no formato [{ path, message }]; path vazio (erro na raiz) vira o nome da parte (body/query/params). */
function formatIssues(issues, part) {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.') || part,
    message: issue.message,
  }));
}

/**
 * Cria o middleware de validação. Aceita schemas zod para body, query e params.
 * Os dados validados (já transformados/coagidos) ficam em req.valid.{body,query,params}.
 */
function validate(schemas = {}) {
  const parts = ['params', 'query', 'body'].filter((part) => schemas[part]);
  return (req, res, next) => {
    const valid = req.valid || {};
    const details = [];
    for (const part of parts) {
      const source = req[part] === undefined ? {} : req[part];
      const result = schemas[part].safeParse(source);
      if (result.success) {
        valid[part] = result.data;
      } else {
        details.push(...formatIssues(result.error.issues, part));
      }
    }
    if (details.length > 0) {
      return next(new AppError(400, 'validation_error', 'Verifique os campos informados.', details));
    }
    req.valid = valid;
    if (schemas.body) req.body = valid.body;
    next();
  };
}

module.exports = { validate, ptBrErrorMap, z };
