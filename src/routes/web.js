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
router.use('/careers', require('../modules/recruitment/careers.web'));
router.use('/admin', requireAuth, requireSuperAdmin, require('../modules/admin/web'));
router.use('/app', requireAuth, resolveTenant, require('./app'));

module.exports = router;
