// A local stand-in for AI provider APIs (Anthropic, OpenAI, Azure OpenAI, Gemini) used by the tests.
// It records every request and answers in each provider's response format with a canned JSON reply
// chosen from the task instructions in the prompt.
const http = require('http');

function promptText(path, body) {
  try {
    const j = JSON.parse(body);
    if (path.includes(':generateContent')) return j.contents[0].parts.map((p) => p.text || '').join('\n');
    const msg = j.messages[j.messages.length - 1];
    return (Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]).map((c) => c.text || '').join('\n');
  } catch {
    return '';
  }
}

function defaultReply(prompt) {
  if (prompt.includes('inclusive job posting')) return { description: 'You will build and run our payroll operations.\n- Own the monthly payroll', requirements: '- 3+ years in payroll\n- Saudi GOSI knowledge', skills: ['Payroll', 'GOSI', 'Excel'] };
  if (prompt.includes("Compare the candidate's evidence")) {
    return {
      summary: 'The candidate shows payroll experience that matches most requirements.',
      requirements: [{ requirement: '3+ years in payroll', status: 'met', evidence: 'Five years as payroll specialist' }, { requirement: 'GOSI', status: 'not_evident', evidence: 'Not mentioned' }],
      strengths: ['Payroll processing'], gaps: ['GOSI registration'], questions: ['How have you handled GOSI contributions?'],
    };
  }
  if (prompt.includes('Summarise this HR document')) return { summary: 'An employment contract for one year.', document_type: 'Employment contract', parties: ['Employer', 'Employee'], key_dates: [{ label: 'Start', date: '2026-01-01' }, { label: 'End', date: '2026-12-31' }], issue_date: '2026-01-01', expiry_date: '2026-12-31', notes: ['60 days notice'] };
  if (prompt.includes('Draft the written summary')) return { summary: 'You delivered your goals this period.', strengths: '- Reliable delivery', improvements: '- Share progress earlier' };
  if (prompt.includes('multiple-choice questions')) return { questions: [{ question: 'What is the pass mark?', options: ['50%', '70%', '90%', '100%'], correct_index: 1 }, { question: 'Who approves leave?', options: ['HR', 'Manager', 'Finance', 'IT'], correct_index: 1 }] };
  if (prompt.includes('company metrics')) return { answer: 'Headcount is stable.', highlights: ['Headcount comes from the metrics'], caveats: [] };
  return { ok: true };
}

function wrap(path, text) {
  if (path.startsWith('/v1/messages')) return { content: [{ type: 'text', text }], usage: { input_tokens: 120, output_tokens: 80 } };
  if (path.includes(':generateContent')) return { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80 } };
  return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 120, completion_tokens: 80 } };
}

function start(port = 0) {
  const s = { requests: [], status: 200, reply: null, raw: null };
  s.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const prompt = promptText(req.url, body);
      s.requests.push({ method: req.method, url: req.url, headers: req.headers, body, prompt, json: (() => { try { return JSON.parse(body); } catch { return null; } })() });
      res.writeHead(s.status, { 'content-type': 'application/json' });
      if (s.status !== 200) return res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      const text = s.raw != null ? s.raw : JSON.stringify((s.reply || defaultReply)(prompt));
      return res.end(JSON.stringify(wrap(req.url, text)));
    });
  });
  return new Promise((resolve) => s.server.listen(port, '127.0.0.1', () => { s.url = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

module.exports = { start, defaultReply };

if (require.main === module) start(Number(process.argv[2]) || 4010).then((s) => console.log(`AI stub on ${s.url}`));
