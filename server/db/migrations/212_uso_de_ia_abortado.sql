-- =====================================================================
-- Chamada de IA cancelada deixa de ser registrada como bem-sucedida.
--
-- O registro de uso só conhecia 'ok' e 'error'. Uma chamada abortada — por
-- tempo esgotado, ou porque o aluno fechou a conversa do tutor — escapava
-- do bloco de erro e era gravada como 'ok', com os tokens do prompt
-- ESTIMADOS pelo tamanho do texto e zero tokens de resposta.
--
-- O efeito não é cosmético: durante a leitura de uma prova em produção, o
-- painel mostrou "6 chamadas, 48 mil tokens, 0 erros" enquanto nenhuma das
-- seis tinha devolvido um único token. A investigação seguiu por uma hora
-- na direção errada, procurando queda de processo, porque o número dizia
-- que a IA estava respondendo.
--
-- 'aborted' fica separado de 'error' de propósito: aluno fechar o tutor no
-- meio é rotina, não falha, e não deve encher a contagem de erros do painel.
-- =====================================================================

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_status_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_status_check
  CHECK (status IN ('ok', 'error', 'aborted'));

COMMENT ON COLUMN ai_usage.status IS
  'ok = resposta recebida; error = o provedor recusou; aborted = cancelada '
  'antes de responder (tempo esgotado ou quem pediu desistiu). Os tokens de '
  'uma chamada abortada são estimativa do prompt: ele foi enviado e cobrado, '
  'mas nada voltou.';
