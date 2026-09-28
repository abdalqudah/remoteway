// Matching between people and jobs. A transparent rule-based score always runs (it also picks the
// shortlist the AI sees, so the AI never reads the whole talent pool); the existing AI layer then ranks
// that shortlist and explains each match. Protected characteristics are never inputs.
const knex = require('../../db/knex');
const profiles = require('./profile.service');

const STOP = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'with', 'in', 'to', 'senior', 'junior', 'mid', 'lead', 'specialist', 'و', 'في', 'من', 'مع', 'أو']);
const tokens = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).filter((w) => w.length > 1 && !STOP.has(w));
const norm = profiles.normSkill;
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

/** What a company is looking for, from a job or from a free-text request. */
function criteriaFromJob(job) {
  return {
    title: job.title, skills: parse(job.skills, []) || [], min_years: job.experience_years || null,
    work_mode: job.work_mode || null, employment_type: job.employment_type || null, city: job.location_city || null, text: `${job.title} ${job.requirements || ''}`,
  };
}

/** Light parsing of a natural request, only to pre-select profiles (the AI reads the full request). */
async function criteriaFromText(text) {
  const t = String(text || '').slice(0, 1000);
  const lower = t.toLowerCase();
  const known = await knex('talent_skills').distinct('skill').limit(5000).pluck('skill');
  // A Latin skill glued to an Arabic word ("وGoogle Ads" = "and Google Ads") still counts: the word
  // boundary is judged within the skill's own script.
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const edge = (ch) => (/[a-z0-9]/.test(ch) ? '[^a-z0-9]' : '[^\\p{L}\\p{N}]');
  const skills = known.filter((s) => s.length > 1 && new RegExp(`(^|${edge(s[0])})${esc(s)}(${edge(s[s.length - 1])}|$)`, 'u').test(lower)).slice(0, 15);
  const years = lower.match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?|سنوات|سنة|سنين|عام|أعوام)/u) || lower.match(/(?:خبرة|experience)\s*(\d{1,2})/u);
  const remote = /\bremote\b|عن ?بعد|ريموت/u.test(lower);
  const hybrid = /\bhybrid\b|هجين/u.test(lower);
  return { title: t, skills, min_years: years ? Number(years[1]) : null, work_mode: remote ? 'remote' : hybrid ? 'hybrid' : null, employment_type: null, city: null, text: t };
}

/**
 * Rule-based score (0–100) with the reasons behind it.
 * Skills 50 · role/title fit 20 · experience 15 · work preferences 10 · location 5.
 */
function score(p, c) {
  const pSkills = new Set((p.skills || []).map(norm));
  const want = [...new Set((c.skills || []).map(norm))];
  const matched = want.filter((s) => pSkills.has(s));
  const missing = want.filter((s) => !pSkills.has(s));
  let skillPts = want.length ? (matched.length / want.length) * 50 : 0;
  // Skills mentioned in free text also count when no explicit list was given
  if (!want.length && c.text) {
    const words = new Set(tokens(c.text));
    const hits = [...pSkills].filter((s) => words.has(s) || tokens(s).every((w) => words.has(w)));
    skillPts = Math.min(50, hits.length * 12);
    matched.push(...hits.slice(0, 8));
  }
  const titleWords = new Set(tokens(c.title));
  const profWords = tokens(`${p.headline || ''} ${p.specialization || ''} ${(p.experience || []).map((e) => e.title).join(' ')}`);
  const overlap = titleWords.size ? profWords.filter((w) => titleWords.has(w)).length : 0;
  const titlePts = titleWords.size ? Math.min(20, (new Set(profWords.filter((w) => titleWords.has(w))).size / Math.min(titleWords.size, 3)) * 20) : 10;
  const years = p.years != null ? p.years : (p.years_experience ?? p.computed_years ?? null);
  let yearPts = 10;
  if (c.min_years) yearPts = years == null ? 4 : years >= c.min_years ? 15 : Math.max(0, 15 - (c.min_years - years) * 5);
  const prefs = p.preferences || {};
  let prefPts = 10;
  if (c.work_mode && (prefs.work_modes || []).length) prefPts -= (prefs.work_modes.includes(c.work_mode) ? 0 : 6);
  if (c.employment_type && (prefs.job_types || []).length) prefPts -= (prefs.job_types.includes(c.employment_type) ? 0 : 4);
  let locPts = 3;
  if (c.work_mode === 'remote') locPts = 5;
  else if (c.city && p.city) locPts = String(p.city).toLowerCase() === String(c.city).toLowerCase() ? 5 : 1;
  const total = Math.round(Math.max(0, Math.min(100, skillPts + titlePts + yearPts + prefPts + locPts)));
  const reasons = [];
  if (matched.length) reasons.push({ key: 'skills', n: matched.length, of: want.length || matched.length });
  if (overlap) reasons.push({ key: 'role' });
  if (c.min_years && years != null) reasons.push({ key: years >= c.min_years ? 'years_ok' : 'years_short', years, need: c.min_years });
  if (c.work_mode && (prefs.work_modes || []).includes(c.work_mode)) reasons.push({ key: 'mode', mode: c.work_mode });
  return { score: total, matched_skills: [...new Set(matched)], missing_skills: missing, years, reasons };
}

/** Profiles a company can consider for the criteria, best first (rule-based). */
async function candidatesFor(c, { limit = 20, exclude = [] } = {}) {
  const q = profiles.searchQuery({}, { companyAccess: true }).where('p.open_to_work', true).where('p.completion', '>=', 30);
  const skills = (c.skills || []).map(norm).slice(0, 15);
  const words = tokens(c.title).slice(0, 6);
  if (skills.length || words.length) {
    q.where((w) => {
      if (skills.length) w.orWhereExists(function sk() { this.select('*').from('talent_skills as s').whereRaw('s.profile_id = p.id').whereIn('s.skill', skills); });
      for (const word of words) w.orWhere('p.headline', 'like', `%${word}%`).orWhere('p.specialization', 'like', `%${word}%`);
    });
  }
  if (exclude.length) q.whereNotIn('p.user_id', exclude);
  const pool = (await q.select('p.*', 'u.name').orderBy('p.updated_at', 'desc').limit(300)).map(profiles.hydrate);
  return pool.map((p) => ({ profile: p, ...score(p, c) })).filter((r) => r.score >= 25).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Open marketplace jobs that fit a person (rule-based), best first. */
async function jobsFor(p, { limit = 12 } = {}) {
  const jobs = await require('./marketplace.service').openJobsPool(400); // eslint-disable-line global-require
  const prefs = p.preferences || {};
  return jobs.map((job) => {
    const c = criteriaFromJob(job);
    const s = score(p, c);
    // A job title the person listed as a target counts like a strong role fit
    const wanted = (prefs.titles || []).some((tt) => tokens(tt).some((w) => tokens(job.title).includes(w)));
    return { job, ...s, score: Math.min(100, s.score + (wanted ? 10 : 0)) };
  }).filter((r) => r.score >= 30).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Compact, anonymised text of a profile for the AI (no name, email, phone or photo). */
function aiCard(p, ref) {
  const exp = (p.experience || []).slice(0, 4).map((e) => `${e.title || ''} at ${e.company || ''} (${e.start || '?'} – ${e.current ? 'now' : e.end || '?'})${e.description ? `: ${String(e.description).slice(0, 200)}` : ''}`);
  const edu = (p.education || []).slice(0, 2).map((e) => [e.degree, e.field, e.school].filter(Boolean).join(', '));
  return [
    `### ${ref}`,
    `Headline: ${p.headline || '-'} | Specialization: ${p.specialization || '-'} | Years of experience: ${p.years ?? 'unknown'}`,
    `Skills: ${(p.skills || []).join(', ') || '-'}`,
    exp.length ? `Experience: ${exp.join(' | ')}` : '',
    edu.length ? `Education: ${edu.join(' | ')}` : '',
    (p.certifications || []).length ? `Certifications: ${p.certifications.slice(0, 5).map((x) => x.name).join(', ')}` : '',
    (p.languages || []).length ? `Languages: ${p.languages.map((l) => `${l.name} (${l.level})`).join(', ')}` : '',
    `Prefers: ${[...(p.preferences?.work_modes || []), ...(p.preferences?.job_types || [])].join(', ') || '-'} | Location: ${[p.city, p.country_code].filter(Boolean).join(', ') || '-'}`,
  ].filter(Boolean).join('\n');
}

module.exports = { criteriaFromJob, criteriaFromText, score, candidatesFor, jobsFor, aiCard, tokens };
