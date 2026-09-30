-- =====================================================================
-- Upgrade: quando a troca de plano foi de fato aplicada.
--
-- Pagar a diferença nem sempre troca o plano. Se, entre o pedido e o
-- pagamento, o plano da assinatura mudou (outro upgrade pago antes, troca
-- feita pela equipe) ou o período renovou, a cobrança é registrada como paga
-- e a troca fica para o suporte decidir — aplicar sobre um período que não é
-- o que foi cotado daria ao aluno um nível que ele não pagou.
--
-- O status sozinho não distingue os dois casos, e o estorno precisa
-- distinguir: só desfaz a troca de quem teve a troca. Sem esta coluna, o
-- estorno de uma cobrança que nunca trocou nada poderia rebaixar o aluno que
-- chegou ao nível novo por outro pagamento, legítimo.
-- =====================================================================
ALTER TABLE plan_changes ADD COLUMN IF NOT EXISTS applied_at timestamptz;

COMMENT ON COLUMN plan_changes.applied_at IS
  'Quando o plano da assinatura foi trocado por este upgrade. Pago e sem data: o suporte precisa resolver.';
