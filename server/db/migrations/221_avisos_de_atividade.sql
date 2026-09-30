-- =====================================================================
-- Avisos de atividade real na página inicial.
--
-- A landing mostra, num balão discreto, quem acabou de assinar ou de subir
-- de nível ("Ana, que estuda para o ENEM, assinou o Pro · há 2 horas"). Só
-- entra compra paga de verdade e upgrade aplicado; o texto leva apenas o
-- primeiro nome, a prova e o nível (ver server/services/activity.js).
--
-- O aluno pode sair dos avisos pelo perfil. O padrão é aparecer: a
-- informação exposta é mínima e o interruptor fica ao alcance dele.
-- =====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_in_activity boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN users.show_in_activity IS
  'O aluno aceita aparecer nos avisos de novas assinaturas da página inicial (só o primeiro nome e a prova).';

-- A consulta dos avisos olha só os últimos dias. Sem estes índices ela
-- percorreria as tabelas inteiras a cada minuto (o cache da landing é de 60s).
--
-- Compra: a data é a do nascimento da assinatura (created_at), que a
-- renovação não mexe; só interessa a que já teve pagamento.
CREATE INDEX IF NOT EXISTS subscriptions_compra_paga_idx
  ON subscriptions (created_at DESC)
  WHERE last_payment_at IS NOT NULL;

-- Upgrade: só o pago que de fato trocou o plano.
CREATE INDEX IF NOT EXISTS plan_changes_aplicado_idx
  ON plan_changes (applied_at DESC)
  WHERE status = 'paid' AND applied_at IS NOT NULL;

-- O plano da compra é o de ANTES do primeiro upgrade aplicado: a assinatura
-- guarda só o plano atual. Esta busca parte da assinatura.
CREATE INDEX IF NOT EXISTS plan_changes_assinatura_aplicado_idx
  ON plan_changes (subscription_id, applied_at)
  WHERE applied_at IS NOT NULL;
