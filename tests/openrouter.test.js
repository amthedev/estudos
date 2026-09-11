'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, OpenRouterError } = require('../server/services/openrouter');

describe('cliente OpenRouter', () => {
  it('envia chat completions ao endpoint do OpenRouter com identificação da aplicação', async () => {
    let captured = null;
    const client = createClient({
      apiKey: 'sk-or-v1-teste',
      httpReferer: 'https://focoelite.com.br',
      appTitle: 'Foco de Elite',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response(
          JSON.stringify({
            id: 'gen-1',
            model: 'google/gemini-3.8-flash',
            choices: [{ message: { role: 'assistant', content: 'Resposta.' } }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const result = await client.chat.completions.create({
      model: 'google/gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Olá' }],
      max_tokens: 100,
    });

    assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.Authorization, 'Bearer sk-or-v1-teste');
    assert.equal(captured.init.headers['HTTP-Referer'], 'https://focoelite.com.br');
    assert.equal(captured.init.headers['X-OpenRouter-Title'], 'Foco de Elite');
    assert.equal(JSON.parse(captured.init.body).model, 'google/gemini-3.8-flash');
    assert.equal(result.choices[0].message.content, 'Resposta.');
  });

  it('interpreta deltas e uso no streaming SSE', async () => {
    const sse = [
      'data: {"model":"google/gemini-3.8-flash","choices":[{"delta":{"content":"Bom "}}]}',
      '',
      'data: {"model":"google/gemini-3.8-flash","choices":[{"delta":{"content":"estudo!"}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const client = createClient({
      apiKey: 'sk-or-v1-teste',
      fetchImpl: async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });

    const stream = await client.chat.completions.create({
      model: 'google/gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Oi' }],
      stream: true,
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content || '').join(''), 'Bom estudo!');
    assert.equal(chunks.at(-1).usage.total_tokens, 8);
  });

  it('transforma falhas HTTP em erro sem expor a chave', async () => {
    const client = createClient({
      apiKey: 'sk-or-v1-segredo',
      maxRetries: 0,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'Chave inválida', code: 401 } }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-123' },
        }),
    });

    await assert.rejects(
      () => client.chat.completions.create({ model: 'google/gemini-3.8-flash', messages: [{ role: 'user', content: 'Oi' }] }),
      (err) => {
        assert.ok(err instanceof OpenRouterError);
        assert.equal(err.status, 401);
        assert.equal(err.requestId, 'req-123');
        assert.equal(err.message.includes('sk-or-v1-segredo'), false);
        return true;
      }
    );
  });
});
