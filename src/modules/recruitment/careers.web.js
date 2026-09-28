// Public careers page: /careers/:company and /careers/:company/jobs/:job (enabled per company in Recruitment).
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { wrap, form } = require('../../routes/helpers');
const { singleFile } = require('../../middleware/upload');
const { E } = require('../../core/errors');
const rec = require('./recruitment.service');

const router = express.Router();

const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: config.isTest ? 1000 : 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res, next) => next(E.rateLimited()),
});

async function load(req) {
  const org = await rec.publicOrg(req.params.org);
  if (!org) throw E.notFound('Page');
  return org;
}

router.get('/:org', wrap(async (req, res) => {
  const org = await load(req);
  res.page('pages/careers/index', { layout: 'careers', title: `${req.t('careers.title')} · ${org.name}`, org, jobs: await rec.publicJobs(org.id) });
}));

const renderJob = async (req, res, extra = {}) => {
  const org = await load(req);
  const job = await rec.publicJob(org.id, req.params.job);
  if (!job) throw E.notFound('Job');
  res.page('pages/careers/job', { layout: 'careers', title: `${job.title} · ${org.name}`, org, job, ...extra });
};

router.get('/:org/jobs/:job', wrap((req, res) => renderJob(req, res)));

router.post('/:org/jobs/:job/apply', applyLimiter, ...singleFile('file'), form(async (req, res) => {
  const org = await load(req);
  const job = await rec.publicJob(org.id, req.params.job);
  if (!job) throw E.notFound('Job');
  // Honeypot: real people never fill the hidden "website" field.
  if (!req.body.website) await rec.publicApply(org, job, req.body, req.file);
  res.page('pages/careers/job', { layout: 'careers', title: `${job.title} · ${org.name}`, org, job, applied: true });
}, renderJob));

module.exports = router;
