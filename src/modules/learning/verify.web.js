// Public certificate verification: /verify/<code>
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { wrap } = require('../../routes/helpers');
const { E } = require('../../core/errors');
const enroll = require('./enrollments.service');

const router = express.Router();
router.use(rateLimit({ windowMs: 60_000, limit: config.isTest ? 1000 : 30, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) }));
router.get('/', (req, res) => res.page('pages/learning/verify', { layout: 'public', title: req.t('learning.verify_title'), cert: null, code: '' }));
router.get('/:code', wrap(async (req, res) => {
  const cert = await enroll.verify(req.params.code);
  res.status(cert ? 200 : 404).page('pages/learning/verify', { layout: 'public', title: req.t('learning.verify_title'), cert, code: req.params.code });
}));

module.exports = router;
