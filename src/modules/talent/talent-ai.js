// AI on the talent marketplace, built on the existing AI layer:
//   companies → ai.run() with the organisation's AI governance ('recruitment' area) and plan quota;
//   individuals → ai.runPersonal() with the platform's small daily allowance.
// The rule-based matcher always picks the shortlist first, so the AI ranks and explains at most 20
// anonymised profiles (no names, contacts or photos), and results still appear when AI is off.
const { z } = require('../../core/validate');
const { E } = require('../../core/errors');
const knex = require('../../db/knex');
const ai = require('../ai/ai.service');
const matching = require('./matching.service');
const profiles = require('./profile.service');
const marketplace = require('./marketplace.service');

const text = (max) => z.string().trim().max(max);
const list = (max, len = 200) => z.array(z.string().trim().min(1).max(len)).max(max).default([]);
const rankSchema = z.object({
  results: z.array(z.object({
    ref: z.string().max(10), match: z.coerce.number().min(0).max(100), reason: text(600).default(''),
    matched_skills: list(15, 60), experience: text(300).default(''), gaps: list(8, 200),
  })).max(20).default([]),
});

function ruleResults(pool) {
  return pool.map((r) => ({ profile: r.profile, match: r.score, reason: null, reasons: r.reasons, matched_skills: r.matched_skills, missing_skills: r.missing_skills, years: r.years, gaps: r.missing_skills }));
}

/**
 * Company talent search from a natural request ("Digital marketing specialist, 3 years, SEO, Google Ads, remote")
 * or from one of the company's jobs.
 */
async function search(ctx, { query, jobId, locale = 'en', useAi = true }) {
  let criteria; let request = String(query || '').trim().slice(0, 1000);
  if (jobId) {
    const job = await knex('jobs as j').leftJoin('locations as l', 'l.id', 'j.location_id').where({ 'j.id': Number(jobId), 'j.organization_id': ctx.organizationId }).first('j.*', 'l.city as location_city');
    if (!job) throw E.notFound('Job');
    criteria = matching.criteriaFromJob(job);
    request = [`Job title: ${job.title}`, `Work mode: ${job.work_mode}`, `Employment type: ${job.employment_type}`, job.experience_years ? `Experience: ${job.experience_years}+ years` : '',
      `Skills: ${(criteria.skills || []).join(', ')}`, ai.clip(job.requirements, 1500), ai.clip(job.description, 1500)].filter(Boolean).join('\n');
  } else {
    if (request.length < 3) throw E.validation({ query: 'Describe the person you are looking for.' });
    criteria = await matching.criteriaFromText(request);
  }
  const already = jobId ? await knex('applications as a').join('candidates as c', 'c.id', 'a.candidate_id').where({ 'a.job_id': Number(jobId) }).whereNotNull('c.user_id').pluck('c.user_id') : [];
  const pool = await matching.candidatesFor(criteria, { limit: 20, exclude: already });
  const status = await ai.status(ctx.organizationId);
  const aiReady = useAi && status.areas.recruitment.usable;
  if (!pool.length || !aiReady) return { mode: 'rules', aiReason: !status.configured ? 'not_configured' : !status.areas.recruitment.inPlan ? 'not_in_plan' : !status.areas.recruitment.switchedOn ? 'switched_off' : null, criteria, results: ruleResults(pool) };

  const refs = pool.map((r, i) => [`C${i + 1}`, r]);
  const data = [`## Request\n${ai.redact(request)}`, '## Candidates', ...refs.map(([ref, r]) => matching.aiCard(r.profile, ref))].join('\n\n');
  const out = await ai.run(ctx, {
    area: 'recruitment', action: jobId ? 'talent_for_job' : 'talent_search', entityType: jobId ? 'job' : null, entityId: jobId || null, locale, schema: rankSchema, maxTokens: 2500,
    instructions: 'A company describes who it is looking for. Compare each candidate profile with the request using only job-related evidence (skills, experience, education, certifications, languages, work preferences). Return {"results": [{"ref": "C1", "match": 0-100, "reason": "one or two sentences on why they fit", "matched_skills": ["skills from the request the profile shows"], "experience": "short summary of relevant experience", "gaps": ["requirements not evident in the profile"]}]} for the best candidates only (at most 10, match of 40 or more), best first. Do not rank on age, gender, nationality, religion or any other protected characteristic, and do not guess them.',
    data,
  });
  const byRef = Object.fromEntries(refs);
  const results = out.results.filter((r) => byRef[r.ref]).map((r) => ({
    profile: byRef[r.ref].profile, match: Math.round(r.match), reason: r.reason, matched_skills: r.matched_skills.length ? r.matched_skills : byRef[r.ref].matched_skills, experience: r.experience, gaps: r.gaps, years: byRef[r.ref].years,
  })).sort((a, b) => b.match - a.match);
  return { mode: 'ai', criteria, results };
}

/** Jobs for a person: rule-based always; optionally ranked and explained by AI (personal allowance). */
const jobRankSchema = z.object({ results: z.array(z.object({ ref: z.string().max(10), match: z.coerce.number().min(0).max(100), reason: text(500).default(''), gaps: list(5, 200) })).max(12).default([]) });

async function jobsForMe(user, { useAi = false, locale = 'en' } = {}) {
  const p = await profiles.forUser(user.id);
  if (!p) return { mode: 'rules', results: [] };
  const applied = new Set(await marketplace.appliedJobIds(user.id));
  const pool = (await matching.jobsFor(p, { limit: 12 })).filter((r) => !applied.has(r.job.id));
  if (!useAi || !pool.length) return { mode: 'rules', results: pool.map((r) => ({ job: r.job, match: r.score, reasons: r.reasons, matched_skills: r.matched_skills, gaps: r.missing_skills })) };
  const refs = pool.map((r, i) => [`J${i + 1}`, r]);
  const data = [`## Candidate profile\n${matching.aiCard(p, 'ME')}`, '## Jobs',
    ...refs.map(([ref, r]) => `### ${ref}\n${r.job.title} (${r.job.work_mode}, ${r.job.employment_type})${r.job.experience_years ? `, ${r.job.experience_years}+ years` : ''}\nSkills: ${(r.job.skills || []).join(', ')}\n${ai.clip(r.job.requirements, 600)}`)].join('\n\n');
  const out = await ai.runPersonal(user.id, {
    action: 'jobs_for_me', locale, schema: jobRankSchema, maxTokens: 1500,
    instructions: 'A job seeker wants to know which of these jobs fit their profile. Return {"results": [{"ref": "J1", "match": 0-100, "reason": "why it fits, addressed to the person", "gaps": ["what they would need to strengthen"]}]} best first, only jobs with match 40 or more.',
    data,
  });
  const byRef = Object.fromEntries(refs);
  return { mode: 'ai', results: out.results.filter((r) => byRef[r.ref]).map((r) => ({ job: byRef[r.ref].job, match: Math.round(r.match), reason: r.reason, gaps: r.gaps, matched_skills: byRef[r.ref].matched_skills })) };
}

const analysisSchema = z.object({
  summary: text(800).min(1), strengths: list(6), gaps: list(6), suggestions: list(8, 300), suggested_roles: list(6, 100),
  missing_skills: list(10, 60), headline_suggestion: text(150).default(''),
});

async function analyzeProfile(user, locale = 'en') {
  const p = await profiles.forUser(user.id);
  if (!p) throw E.conflict('PROFILE_REQUIRED', 'Create your profile first.');
  if (p.completion < 20) throw E.conflict('PROFILE_INCOMPLETE', 'Add your headline, skills and experience first.');
  const demand = await knex('jobs').where({ marketplace: true, status: 'open' }).orderBy('marketplace_at', 'desc').limit(60).pluck('skills');
  const counts = {};
  for (const s of demand.flatMap((v) => (typeof v === 'string' ? JSON.parse(v || '[]') : v || []))) counts[profiles.normSkill(s)] = (counts[profiles.normSkill(s)] || 0) + 1;
  const topDemand = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([s]) => s);
  const data = [matching.aiCard(p, 'PROFILE'), p.bio ? `Bio: ${ai.redact(ai.clip(p.bio, 1500))}` : '', `Target roles: ${(p.preferences?.titles || []).join(', ') || '-'}`,
    `Skills most requested in open jobs on the platform: ${topDemand.join(', ') || '-'}`, `Profile completion: ${p.completion}% (missing: ${profiles.completion(p).missing.join(', ') || 'nothing'})`].filter(Boolean).join('\n');
  const out = await ai.runPersonal(user.id, {
    action: 'profile_analysis', locale, schema: analysisSchema, maxTokens: 1500,
    instructions: 'Review this professional profile for the person who owns it. Return {"summary": "2-3 sentences on how the profile reads to employers", "strengths": ["..."], "gaps": ["what is missing or weak"], "suggestions": ["concrete edits to improve the profile"], "suggested_roles": ["job titles that fit"], "missing_skills": ["in-demand skills close to their field that they do not list"], "headline_suggestion": "a better one-line headline"}. Be specific and encouraging; never invent experience.',
    data,
  });
  await profiles.saveAnalysis(p.id, out);
  return out;
}

module.exports = { search, jobsForMe, analyzeProfile };
