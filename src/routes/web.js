const express = require('express');
const { requireAuth, requireSuperAdmin, resolveTenant } = require('../middleware/context');
const { MODULES } = require('./modules');

const router = express.Router();

router.use((req, res, next) => {
  res.locals.MODULES = MODULES;
  next();
});
router.use('/', require('../modules/site/web'));
router.use('/', require('../modules/auth/web'));
router.use('/sso', require('../modules/sso/web').router);
router.use('/', require('../modules/talent/public.web').router); // jobs board, discover talent, profiles, individual sign-up
router.use('/me', requireAuth, require('../modules/talent/me.web')); // individual dashboard
router.use('/careers', require('../modules/recruitment/careers.web'));
router.use('/verify', require('../modules/learning/verify.web'));
router.use('/calendar', require('../modules/integrations/web').feedRouter);
router.use('/payments', require('../modules/payments/web'));
router.use('/admin', requireAuth, requireSuperAdmin, require('../modules/admin/web'));
router.use('/app', requireAuth, resolveTenant, require('./app'));

module.exports = router;
