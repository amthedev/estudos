'use strict';

/**
 * Moedas do aluno.
 *
 *   GET /api/coins → { unlimited, tier, tier_label, reason, daily, spent, granted, balance, day, resets_at, costs }
 *
 * O front relê esta carteira depois de toda ação que cobra (deu certo ou não),
 * para o chip do topo nunca mostrar um saldo que já mudou. Quem não gasta moeda
 * (plano antigo, cortesia, acesso aberto) recebe unlimited: true e balance nulo.
 */
const router = require('express').Router();
const { wrap } = require('../middleware/errors');
const { requireStudent } = require('../middleware/auth');
const { requireAccess } = require('../middleware/access');
const coins = require('../services/coins');

router.use(requireStudent, requireAccess);

router.get(
  '/',
  wrap(async (req, res) => {
    res.json(await coins.getWallet({ user: req.user, access: req.access }));
  })
);

module.exports = { basePath: '/api/coins', router };
