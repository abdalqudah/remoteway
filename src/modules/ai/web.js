// AI routes: in-page actions (JSON + an HTML fragment), Settings → AI (governance and usage)
// and the analytics assistant page (/app/insights).
const express = require('express');
const rateLimit = require('express-rate-limit');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const ai = require('./ai.service');
const features = require('./features');

// ---------- Locals: which AI areas this user can use on the current page ----------
async function locals(req, res, next) {
  try {
    const s = await ai.status(req.ctx.organizationId);
    res.locals.aiStatus = s;
    res.locals.aiOn = (area) => Boolean(s.areas[area] && s.areas[area].usable);
    next();
  } catch (e) {
    next(e);
  }
}

// ---------- In-page actions ----------
const actions = express.Router();
actions.use(rateLimit({
  windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `ai:${req.user.id}`,
  handler: (req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: req.t('errors.RATE_LIMITED') } }),
}));

/** Runs an action and answers with {html} (a rendered fragment) or {error}. */
const act = (fn, view) => async (req, res) => {
  try {
    const output = await fn(req);
    res.render(`partials/ai/${view}`, { ...res.locals, out: output, insight: null, fresh: true }, (e, html) => {
      if (e) { console.error('[ai] render', e); return res.status(500).json({ success: false, error: { message: req.t('errors.INTERNAL_ERROR') } }); }
      return res.json({ success: true, html });
    });
  } catch (e) {
    if (!(e instanceof AppError)) console.error('[ai]', e);
    const known = e instanceof AppError;
    const code = known ? e.code : 'INTERNAL_ERROR';
    const tr = req.t(`errors.${code}`);
    let message = tr !== `errors.${code}` ? tr : known ? translateMessage(req.locale, e.message) : req.t('errors.INTERNAL_ERROR');
    if (code === 'VALIDATION_FAILED' && e.details) message = Object.values(e.details).map((m) => translateMessage(req.locale, m)).join(' ');
    if (code === 'AI_PROVIDER_ERROR') message = `${message} ${e.message}`;
    res.status(known ? e.status : 500).json({ success: false, error: { code, message } });
  }
};

const need = (...perms) => (req, res, next) => (perms.some((p) => req.ctx.permissions.has(p)) ? next() : res.status(403).json({ success: false, error: { code: 'PERMISSION_DENIED', message: req.t('errors.PERMISSION_DENIED') } }));

actions.post('/recruitment/job-description', need('recruitment.manage'), act((req) => features.jobDescription(req.ctx, req.body, req.locale), 'job-description'));
actions.post('/recruitment/applications/:id/match', need('recruitment.view', 'recruitment.manage'), act((req) => features.candidateMatch(req.ctx, Number(req.params.id), req.locale), 'candidate-match'));
actions.post('/documents/:id/summary', need('documents.view', 'documents.manage'), act((req) => features.documentSummary(req.ctx, Number(req.params.id), req.locale), 'document-summary'));
actions.post('/performance/reviews/:id/draft', act((req) => features.reviewDraft(req.ctx, Number(req.params.id), req.body, req.locale), 'review-draft'));
actions.post('/learning/courses/:id/quiz', need('learning.manage'), act((req) => features.quizQuestions(req.ctx, Number(req.params.id), req.body, req.locale), 'quiz'));

// ---------- Settings → AI ----------
const settings = express.Router();
settings.use((req, res, next) => { res.locals.section = 'ai'; next(); });
settings.use(can('ai.manage'));
const renderSettings = async (req, res, extra = {}) => res.page('pages/settings/ai', {
  title: req.t('ai.title'), s: await ai.status(req.ctx.organizationId), usage: await ai.orgUsage(req.ctx.organizationId), areas: ai.AREA_KEYS, ...extra,
});
settings.get('/', wrap((req, res) => renderSettings(req, res)));
settings.post('/', form(async (req, res) => {
  const list = Array.isArray(req.body.features) ? req.body.features : req.body.features ? [req.body.features] : [];
  await ai.saveOrgSettings(req.ctx, { enabled: req.body.enabled === 'on', features: list });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/ai');
}, renderSettings));

// ---------- Analytics assistant ----------
const insights = express.Router();
insights.use(can('reports.view'));
const renderInsights = async (req, res, extra = {}) => {
  const s = await ai.status(req.ctx.organizationId);
  const m = await features.metrics.collect(req.ctx);
  res.page('pages/insights/index', {
    title: req.t('ai.insights'), s, metrics: m, history: s.areas.analytics.usable ? await features.history(req.ctx) : [], ...extra,
  });
};
insights.get('/', wrap((req, res) => renderInsights(req, res)));
insights.post('/ask', form(async (req, res) => {
  // The text box and the suggestion buttons share the name "question": use the one that has text.
  const q = [].concat(req.body.question || []).map((x) => String(x).trim()).filter(Boolean).pop();
  await features.ask(req.ctx, q, req.locale);
  res.redirect('/app/insights#answer');
}, renderInsights));

module.exports = { locals, actions, settings, insights };
