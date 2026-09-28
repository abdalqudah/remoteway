const express = require('express');
const { wrap } = require('../../routes/helpers');
const notifications = require('./notification.service');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  res.page('pages/notifications/index', { title: req.t('notifications.title'), items: await notifications.list(req.ctx, { limit: 100 }) });
}));

// Opening a notification marks it read, then follows its link (only internal paths).
router.get('/:id/open', wrap(async (req, res) => {
  const [item] = (await notifications.list(req.ctx, { limit: 200 })).filter((n) => String(n.id) === req.params.id);
  await notifications.markRead(req.ctx, Number(req.params.id));
  const link = item?.link && item.link.startsWith('/') && !item.link.startsWith('//') ? item.link : '/app/notifications';
  res.redirect(link);
}));

router.post('/read', wrap(async (req, res) => {
  await notifications.markRead(req.ctx, null);
  res.redirect('/app/notifications');
}));

module.exports = router;
