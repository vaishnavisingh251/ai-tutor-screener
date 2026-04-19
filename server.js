require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
const GEMINI_MODEL = process.env.GEMINI_MODEL || '';

const DEFAULT_GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash'
];

function isGeminiQuotaError(err) {
  if (!err) return false;
  return err.code === 'RESOURCE_EXHAUSTED' || /quota|resource_exhausted/i.test(String(err.message || ''));
}

function extractFirstJsonObject(text) {
  if (!text) return null;

  // Strip common code-fence wrappers if the model ever includes them.
  const cleaned = String(text)
    .replace(/```json/gi, '```')
    .replace(/```/g, '')
    .trim();

  // Find the first JSON object by locating outer braces.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = cleaned.slice(start, end + 1);
  return candidate;
}

async function callGemini({ systemPrompt, userPrompt }) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'placeholder') {
    throw new Error(
      'GEMINI_API_KEY is missing. Add it to your .env file and restart the server.'
    );
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: systemPrompt + '\n\n' + userPrompt }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9
    }
  };

  const modelsToTry = GEMINI_MODEL
    ? [GEMINI_MODEL]
    : DEFAULT_GEMINI_MODELS;

  let lastError = null;

  for (const modelName of modelsToTry) {
    const url =
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${encodeURIComponent(modelName)}:generateContent?key=` +
      encodeURIComponent(GEMINI_API_KEY);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(() => null);
    if (resp.ok) {
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
      lastError = new Error(`Gemini response was empty for model "${modelName}".`);
      continue;
    }

    const statusCode = data?.error?.code || resp.status;
    const statusText = data?.error?.status || '';
    const errorMessage = data?.error?.message || `HTTP ${resp.status}`;
    const geminiError = new Error(`Gemini request failed for "${modelName}": ${errorMessage}`);
    geminiError.code = statusText || String(statusCode);
    geminiError.status = statusCode;

    if (statusCode === 429 || statusText === 'RESOURCE_EXHAUSTED') {
      console.warn(`Gemini quota/rate limit for model "${modelName}".`);
      throw geminiError;
    }

    console.error(`Gemini error response for model "${modelName}":`, data);
    const isModelNotFound = statusCode === 404;
    if (isModelNotFound) {
      lastError = new Error(`Model "${modelName}" was not found.`);
      continue;
    }

    throw geminiError;
  }

  throw lastError || new Error('Gemini API request failed for all configured models.');
}

function wordCount(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function buildKeywordSet(question) {
  const STOP = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'for', 'of', 'in',
    'on', 'at', 'by', 'with', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'it',
    'as', 'from', 'into', 'about', 'you', 'your', 'i', 'me', 'my', 'we', 'our', 'they', 'their',
    'what', 'how', 'when', 'where', 'why', 'who', 'would', 'could', 'should', 'can', 'will',
    'do', 'does', 'did', 'have', 'has', 'had', 'just', 'tell', 'start', 'little'
  ]);
  return new Set(tokenize(question).filter((w) => w.length > 2 && !STOP.has(w)));
}

function overlapRatio(question, answer) {
  const qKeywords = buildKeywordSet(question);
  if (!qKeywords.size) return 1;
  const answerWords = new Set(tokenize(answer));
  let hits = 0;
  for (const w of qKeywords) {
    if (answerWords.has(w)) hits += 1;
  }
  return hits / qKeywords.size;
}

function looksLikeLongTangent(question, answer) {
  const wc = wordCount(answer);
  if (wc < 120) return false;
  return overlapRatio(question, answer) < 0.16;
}

function normalizeQuestionDedupe(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAskedFollowUpQuestions(body) {
  const raw = body?.askedFollowUpQuestions;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x || '').trim()).filter(Boolean);
}

function askedQuestionSet(askedList) {
  const set = new Set();
  for (const s of askedList || []) {
    const n = normalizeQuestionDedupe(s);
    if (n) set.add(n);
  }
  return set;
}

/** Pick first candidate whose normalized form is not already asked; otherwise last resort + suffix. */
function pickUnusedFollowUp(candidates, askedSet, rotateOffset = 0) {
  const list = Array.isArray(candidates) ? candidates.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (list.length === 0) return '';
  const asked = askedSet instanceof Set ? askedSet : askedQuestionSet(askedSet);
  const start = Math.max(0, Number(rotateOffset) || 0);
  for (let i = 0; i < list.length; i++) {
    const c = list[(start + i) % list.length];
    if (!asked.has(normalizeQuestionDedupe(c))) return c;
  }
  const last = list[start % list.length];
  return `${last} Please phrase it differently from your earlier replies.`;
}

const REFUSAL_FOLLOWUP_VARIANTS = [
  'Share a concrete teaching moment: what would you say to the child in two short sentences?',
  'Walk me through what you would actually do in a class — first step, then what comes next?',
  'Give one real example of how you would help here, including the exact words you would use.',
  'In plain terms, what is the next action you would take with the student?',
  'What is one specific thing you would do or say if you were tutoring them today?',
  'Describe a real situation and what you would do first, without skipping steps.'
];

const TANGENT_FOLLOWUP_VARIANTS = [
  'Stay on this exact situation only: what are your first two steps?',
  'Answer more directly in two or three clear steps for this case.',
  'Focus only on this question — what would you do first, and then what?',
  'Bring it back to this scenario: what do you say and do in order?'
];

const GENERIC_TEACHING_FOLLOWUPS = [
  'If a parent watched your class for one minute, what would they see you do for this learner?',
  'What object, sketch, or everyday prop could you use to make this idea click for a child?',
  'How would you tell in under half a minute whether your explanation is actually working?',
  'What is a common trap tutors fall into on this kind of question, and how do you sidestep it?',
  'Describe the tone you aim for when someone is stuck — and how you keep them willing to try again.',
  'How do you split this into the smallest step they can succeed on before you add more?',
  'What signal tells you to slow down and repeat versus move to a new example?',
  'Give one fresh angle on your answer — not the same phrasing as before.'
];

function buildContextFollowUpPool(coreQuestion, lastAnswer, depth) {
  const d = Math.max(1, Number(depth) || 1);
  const pool = [];
  for (let delta = 0; delta < 4; delta++) {
    pool.push(followUpFromContext(coreQuestion, lastAnswer, Math.min(3, d + delta)));
  }
  pool.push(followUpFromQuestion(coreQuestion));
  pool.push(...GENERIC_TEACHING_FOLLOWUPS);
  const seen = new Set();
  const out = [];
  for (const s of pool) {
    const t = String(s || '').trim();
    if (!t) continue;
    const n = normalizeQuestionDedupe(t);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(t);
  }
  return out;
}

function pickDistinctContextFollowUp(coreQuestion, lastAnswer, followUpCount, askedSet) {
  const nextDepth = Math.max(1, Number(followUpCount || 0) + 1);
  const pool = buildContextFollowUpPool(coreQuestion, lastAnswer, nextDepth);
  return pickUnusedFollowUp(pool, askedSet, followUpCount);
}

function followUpFromQuestion(question) {
  const q = String(question || '').toLowerCase();

  if (q.includes('fraction')) {
    return 'Explain fractions with one simple example and clear steps.';
  }

  if (q.includes('staring at the same problem') || q.includes('walk me through') || q.includes('exactly what you would do')) {
    return 'Give one real moment and what you would say first, then next.';
  }

  if (q.includes('keep a child engaged') || q.includes('losing interest') || q.includes('distracted')) {
    return 'Share one case where a child lost focus and the exact steps you used.';
  }

  if (q.includes('time you explained') || q.includes('simple way')) {
    return 'Give one real example: what was hard and what exact words you used.';
  }

  if (q.includes('tell me a little about yourself')) {
    return 'Share one experience that clearly shows why you enjoy teaching.';
  }

  return 'Could you make this more concrete with one real example and clear steps?';
}

function followUpFromContext(coreQuestion, lastAnswer, depth = 1) {
  const q = String(coreQuestion || '').toLowerCase();
  const a = String(lastAnswer || '').toLowerCase();
  const d = Math.max(1, Number(depth || 1));

  if (q.includes('fraction')) {
    if (d === 1) return 'In one line, how would you explain fractions to a 9-year-old?';
    if (d === 2) return 'Now give one real example and the words you would use.';
    return 'If the child is still confused, what would you say next?';
  }

  if (q.includes('staring at the same problem') || q.includes('walk me through') || q.includes('exactly what you would do')) {
    if (d === 1) return 'How would you open so the student feels safe to try again before you reteach?';
    if (d === 2) return 'After that, what are your next two steps?';
    return 'How would you check real understanding, not just a yes?';
  }

  if (q.includes('keep a child engaged') || q.includes('losing interest') || q.includes('distracted')) {
    if (d === 1) return 'What do you do in the first 30 seconds to regain attention?';
    if (d === 2) return 'Give one activity or tactic you would use right away.';
    return 'If that fails, what is your backup plan?';
  }

  if (q.includes('time you explained') || q.includes('simple way')) {
    if (d === 1) return 'What exact words did you use?';
    if (d === 2) return 'How did you confirm they truly understood?';
    return 'What would you do even better next time?';
  }

  if (q.includes('tell me a little about yourself')) {
    if (d === 1) return 'What one experience shaped your motivation to teach?';
    if (d === 2) return 'What did that teach you about how children learn?';
    return 'How does that shape your teaching today?';
  }

  if (/example|real|specific|step|student|child/.test(a)) {
    if (d === 1) return 'How would you make that even simpler for a child?';
    return 'Add one short real-life example to support that.';
  }

  if (d === 1) return 'Can you explain that with one real teaching example?';
  if (d === 2) return 'How would you rephrase your explanation if they still looked lost?';
  return 'How would you adapt if the student still struggled?';
}

function stripToText(v) {
  return String(v || '').trim();
}

function collectAllAnswerText(responses) {
  if (!Array.isArray(responses)) return '';
  return responses
    .map((r) => {
      const followupArrayText = Array.isArray(r?.followups)
        ? r.followups.map((f) => stripToText(f?.answer)).filter(Boolean).join(' ')
        : '';
      return [stripToText(r?.answer), followupArrayText, stripToText(r?.followup_answer)]
        .filter(Boolean)
        .join(' ');
    })
    .join(' ')
    .trim();
}

function sentenceCount(text) {
  const matches = String(text || '').match(/[.!?]+/g);
  return matches ? matches.length : 0;
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function pickEvidenceQuote(responses) {
  if (!Array.isArray(responses)) return '';
  for (const r of responses) {
    const answers = [];
    if (Array.isArray(r?.followups)) {
      for (const f of r.followups) answers.push(stripToText(f?.answer));
    }
    answers.push(stripToText(r?.followup_answer));
    answers.push(stripToText(r?.answer));
    for (const answer of answers) {
      if (!answer) continue;
      const quote = answer.split(/\s+/).slice(0, 12).join(' ').trim();
      if (quote) return quote;
    }
  }
  return '';
}

function buildDimension(score, label, quote) {
  const safeQuote = quote || 'No strong quote captured from response.';
  return {
    score,
    comment: `${label} appears around ${score}/10 from the provided responses.\nThis estimate is based on the observed interview evidence.`,
    quote: safeQuote
  };
}

function sanitizeFeedbackLine(text) {
  return String(text || '')
    .replace(/re-?evaluate with active gemini quota for a more reliable final decision\.?/gi, '')
    .replace(/ai evaluation was temporarily unavailable\.?/gi, '')
    .replace(/fallback score is estimated because[^.]*\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeEvaluationPayload(payload) {
  const out = payload && typeof payload === 'object' ? { ...payload } : {};
  const dimensionKeys = [
    'communication_clarity',
    'warmth_empathy',
    'patience',
    'ability_to_simplify',
    'english_fluency'
  ];

  for (const key of dimensionKeys) {
    const dim = out[key];
    if (!dim || typeof dim !== 'object') continue;
    out[key] = {
      ...dim,
      comment: sanitizeFeedbackLine(dim.comment)
    };
  }

  out.key_strengths = Array.isArray(out.key_strengths)
    ? out.key_strengths.map(sanitizeFeedbackLine).filter(Boolean)
    : [];
  out.areas_for_improvement = Array.isArray(out.areas_for_improvement)
    ? out.areas_for_improvement.map(sanitizeFeedbackLine).filter(Boolean)
    : [];
  if (typeof out.overall_summary === 'string') {
    out.overall_summary = sanitizeFeedbackLine(out.overall_summary);
  }

  return out;
}

const DIMENSION_KEYS = [
  'communication_clarity',
  'warmth_empathy',
  'patience',
  'ability_to_simplify',
  'english_fluency'
];

function textsForRecord(r) {
  const out = [];
  if (!r || typeof r !== 'object') return out;
  if (stripToText(r.answer)) out.push(stripToText(r.answer));
  if (Array.isArray(r.followups)) {
    for (const f of r.followups) {
      if (stripToText(f?.answer)) out.push(stripToText(f.answer));
    }
  }
  if (stripToText(r.followup_answer)) out.push(stripToText(r.followup_answer));
  return out;
}

function hasRefusalLanguage(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  const patterns = [
    /\b(?:i\s*)?(?:don'?t|do\s*not)\s+know\b/,
    /\bwon'?t\s+answer\b/,
    /\banswer\s*(?:it\s*)?(?:later|tomorrow)\b/,
    /\b(?:maybe|perhaps)\s+later\b/,
    /\bskip\b/,
    /\bpass(?:\s+this)?\b/,
    /\bno\s+idea\b/,
    /\bnot\s+sure\b/,
    /\bnext\s+question\b/
  ];
  return patterns.some((re) => re.test(lower));
}

function responsesHaveRefusalLanguage(responses) {
  if (!Array.isArray(responses)) return false;
  for (const r of responses) {
    for (const t of textsForRecord(r)) {
      if (hasRefusalLanguage(t)) return true;
    }
  }
  return false;
}

function responsesHaveUltraShortSegment(responses) {
  if (!Array.isArray(responses)) return true;
  for (const r of responses) {
    for (const t of textsForRecord(r)) {
      const s = String(t || '').trim();
      if (!s) continue;
      const wc = wordCount(s);
      if (wc > 0 && wc < 8) return true;
    }
  }
  return false;
}

function questionWasSkippedOrAvoided(r) {
  const texts = textsForRecord(r);
  if (texts.length === 0) return true;
  return texts.every((t) => {
    const s = String(t || '').trim();
    if (!s) return true;
    if (hasRefusalLanguage(s)) return true;
    if (wordCount(s) < 8) return true;
    return false;
  });
}

function countSkippedQuestions(responses) {
  if (!Array.isArray(responses)) return 5;
  return responses.filter(questionWasSkippedOrAvoided).length;
}

function responsesLookVagueNoConcreteExamples(responses) {
  if (!Array.isArray(responses)) return true;
  return responses.some((r) => {
    const combined = textsForRecord(r).join(' ').trim();
    const wc = wordCount(combined);
    if (wc < 8) return false;
    const hasConcrete = /\b(example|because|first|then|step|student|child|teach|fraction|calm|listen|minute)\b/i.test(
      combined
    );
    return wc < 40 && !hasConcrete;
  });
}

function normalizeDimensionEntry(dim) {
  if (!dim || typeof dim !== 'object') {
    return { score: 1, comment: '', quote: '' };
  }
  return {
    score: clampScore(dim.score),
    comment: String(dim.comment || ''),
    quote: String(dim.quote || '')
  };
}

/**
 * Reconciles model output with transcript rules so weak or evasive answers
 * cannot receive inflated scores or a positive decision.
 */
function enforceEvaluationConsistency(parsed, responses) {
  const out = { ...parsed };
  for (const k of DIMENSION_KEYS) {
    out[k] = normalizeDimensionEntry(parsed?.[k]);
  }

  const refusalAny = responsesHaveRefusalLanguage(responses);
  const ultraShortAny = responsesHaveUltraShortSegment(responses);
  const vagueAny = responsesLookVagueNoConcreteExamples(responses);
  const skippedCount = countSkippedQuestions(responses);

  for (const k of DIMENSION_KEYS) {
    let s = out[k].score;
    if (refusalAny || ultraShortAny) {
      s = Math.min(s, 1);
    } else if (vagueAny) {
      s = Math.min(s, 4);
    }
    out[k] = { ...out[k], score: clampScore(s) };
  }

  const scores = DIMENSION_KEYS.map((k) => out[k].score);
  const overallRaw = scores.reduce((a, b) => a + b, 0) / 5;
  const overall = Math.round(overallRaw * 10) / 10;
  out.overall_score = overall;

  const minDim = Math.min(...scores);
  const answeredAllCore = Array.isArray(responses) && responses.length >= 5;

  let decision = 'Not Recommended';
  if (skippedCount >= 2) {
    decision = 'Not Recommended';
  } else if (overall >= 7 && minDim >= 5 && answeredAllCore && skippedCount === 0) {
    decision = 'Move to Next Round';
  } else {
    decision = 'Not Recommended';
  }
  out.overall_decision = decision;

  const extra =
    refusalAny || ultraShortAny
      ? ' Several replies were too short, evasive, or non-substantive; scores are capped accordingly.'
      : vagueAny
        ? ' Several answers lacked concrete teaching examples; scores reflect limited evidence.'
        : '';
  if (extra && typeof out.overall_summary === 'string' && !out.overall_summary.includes('capped')) {
    out.overall_summary = (out.overall_summary + extra).trim();
  }

  return out;
}

function buildFallbackEvaluation(responses) {
  const allText = collectAllAnswerText(responses);
  const wc = wordCount(allText);
  const sentences = sentenceCount(allText);
  const evidenceQuote = pickEvidenceQuote(responses);

  const refusalAny = responsesHaveRefusalLanguage(responses);
  const ultraShortAny = responsesHaveUltraShortSegment(responses);
  const vagueAny = responsesLookVagueNoConcreteExamples(responses);
  const skippedCount = countSkippedQuestions(responses);

  let base = clampScore(3 + Math.floor(wc / 55));
  if (refusalAny || ultraShortAny) {
    base = 1;
  } else if (vagueAny || skippedCount > 0) {
    base = Math.min(base, 3);
  }

  const clarity = clampScore(base + (sentences >= 8 && !ultraShortAny ? 1 : 0));
  const warmth = clampScore(
    base + (/student|child|help|encourage|support|patient/i.test(allText) && !refusalAny ? 1 : 0)
  );
  const patience = clampScore(base + (/calm|step|slow|again|listen|patience/i.test(allText) ? 1 : 0));
  const simplify = clampScore(base + (/example|simple|story|real|pizza|slice/i.test(allText) ? 1 : 0));
  const fluency = clampScore(base + (wc >= 120 && !ultraShortAny ? 1 : 0));

  const overall = clampScore((clarity + warmth + patience + simplify + fluency) / 5);
  const strengths = [];
  const improvements = [];

  if (refusalAny || ultraShortAny) {
    improvements.push('Avoid "I don\'t know", skipping, or one-line replies; each answer needs clear teaching content.');
  }
  if (skippedCount >= 2) {
    improvements.push('Multiple questions were not answered with usable detail; practice full answers before screening.');
  }
  if (clarity >= 7 && !refusalAny && !ultraShortAny) {
    strengths.push('Explains ideas with reasonable structure and understandable flow.');
  }
  if (warmth >= 7 && !refusalAny) {
    strengths.push('Shows learner-focused language and supportive tone in responses.');
  }
  if (simplify >= 7) {
    strengths.push('Uses concrete examples to simplify abstract ideas for children.');
  }
  if (fluency >= 7 && !ultraShortAny) {
    strengths.push('Speaks with enough detail and continuity to communicate confidently.');
  }
  if (strengths.length === 0) {
    strengths.push('Completed the interview; evidence is limited for stronger strengths.');
  }

  if (clarity < 6) {
    improvements.push('Give tighter, step-by-step answers instead of broad statements.');
  }
  if (simplify < 6) {
    improvements.push('Add child-friendly real-life examples (pizza, sharing, objects) while explaining concepts.');
  }
  if (patience < 6) {
    improvements.push('Describe exactly how you would support a confused student before reteaching.');
  }
  if (fluency < 6) {
    improvements.push('Use fuller sentences with enough detail to show teaching judgment.');
  }
  if (improvements.length === 0) {
    improvements.push('Add slightly more specific classroom examples to strengthen evidence.');
  }

  const raw = {
    communication_clarity: buildDimension(clarity, 'Communication clarity', evidenceQuote),
    warmth_empathy: buildDimension(warmth, 'Warmth and empathy', evidenceQuote),
    patience: buildDimension(patience, 'Patience', evidenceQuote),
    ability_to_simplify: buildDimension(simplify, 'Ability to simplify', evidenceQuote),
    english_fluency: buildDimension(fluency, 'English fluency', evidenceQuote),
    overall_score: overall,
    overall_decision: overall >= 7 ? 'Move to Next Round' : 'Not Recommended',
    overall_summary: '',
    key_strengths: strengths.slice(0, 3),
    areas_for_improvement: improvements.slice(0, 3)
  };

  return enforceEvaluationConsistency(raw, responses);
}

app.post('/check-answer', async (req, res) => {
  try {
    const {
      question,
      answer,
      coreQuestion,
      followUpCount = 0,
      minFollowUps = 0,
      maxFollowUps = 3
    } = req.body || {};
    const answerText = String(answer || '').trim();
    const questionText = String(question || '').trim();
    const coreQuestionText = String(coreQuestion || question || '').trim();
    const depth = Math.max(0, Number(followUpCount || 0));
    const minDepth = Math.max(0, Number(minFollowUps || 0));
    const maxDepth = Math.max(minDepth, Number(maxFollowUps || 3));
    const askedFollowUpQuestions = parseAskedFollowUpQuestions(req.body);
    const askedSet = askedQuestionSet(askedFollowUpQuestions);

    const wc = wordCount(answerText);
    const isTangent = looksLikeLongTangent(questionText, answerText);

    if (depth >= maxDepth) {
      return res.json({
        isVague: false,
        shouldAskFollowUp: false,
        reason: 'max_followups_reached',
        followUpQuestion: ''
      });
    }

    // Refusal / evasion — rotate prompts; never repeat an already-asked follow-up line.
    if (hasRefusalLanguage(answerText) && depth < maxDepth) {
      const follow = pickUnusedFollowUp(REFUSAL_FOLLOWUP_VARIANTS, askedSet, depth);
      return res.json({
        isVague: true,
        shouldAskFollowUp: true,
        reason: 'refusal_or_evasive',
        followUpQuestion: follow
      });
    }

    // Hard rule: short answers should trigger follow-up (aligns with evaluation Rule 1).
    if (wc < 15) {
      return res.json({
        isVague: true,
        shouldAskFollowUp: true,
        reason: 'too_short',
        followUpQuestion: pickDistinctContextFollowUp(coreQuestionText, answerText, depth, askedSet)
      });
    }

    // Long but off-track response should be redirected.
    if (isTangent) {
      return res.json({
        isVague: true,
        shouldAskFollowUp: true,
        reason: 'off_topic_tangent',
        followUpQuestion: pickUnusedFollowUp(TANGENT_FOLLOWUP_VARIANTS, askedSet, depth)
      });
    }

    const systemPrompt =
      'You are a Cuemath tutor screener. Decide if another follow-up is needed. ' +
      'Be strict: generic praise, "I will answer later", "I don\'t know", skipping, or thin answers are NOT acceptable — ask again. ' +
      'Sound like a calm human interviewer, not a cheerleader. Never label a weak answer as excellent. ' +
      'Return ONLY JSON: isVague (boolean), shouldAskFollowUp (boolean), followUpQuestion (string). ' +
      'If shouldAskFollowUp is false, followUpQuestion must be empty.';

    const askedBlock =
      askedFollowUpQuestions.length > 0
        ? `Follow-ups already used in this interview — do NOT repeat or lightly rephrase any of these:\n${askedFollowUpQuestions
            .map((q, i) => `${i + 1}. ${q}`)
            .join('\n')}\n\n`
        : '';

    const userPrompt =
      `Core question:\n${coreQuestionText}\n\n` +
      `Current asked question:\n${questionText}\n\n` +
      `Candidate answer:\n${answerText}\n\n` +
      askedBlock +
      `Current follow-up depth: ${depth}\n` +
      `Minimum follow-ups desired: ${minDepth}\n` +
      `Maximum follow-ups allowed: ${maxDepth}\n\n` +
      'Rules:\n' +
      '- Prefer another follow-up if the answer lacks concrete teaching behavior, examples, or clear steps.\n' +
      '- If depth is below minimum, ask another follow-up unless the answer is clearly strong and specific.\n' +
      '- Never exceed maximum follow-ups.\n' +
      '- Follow-up: short, plain English, conversational, under 18 words.\n' +
      '- Ask for one real example, a concrete teaching move, or how they would adapt their explanation.\n' +
      '- Your new followUpQuestion must be genuinely new — not the same as any line listed above.\n\n' +
      'Return JSON only.';

    try {
      const geminiText = await callGemini({ systemPrompt, userPrompt });
      const jsonCandidate = extractFirstJsonObject(geminiText);
      if (!jsonCandidate) {
        return res.json({
          isVague: true,
          shouldAskFollowUp: true,
          reason: 'fallback_followup',
          followUpQuestion: pickDistinctContextFollowUp(coreQuestionText, answerText, depth, askedSet)
        });
      }

      const parsed = JSON.parse(jsonCandidate);
      const isVague = Boolean(parsed?.isVague);
      let shouldAskFollowUp = Boolean(parsed?.shouldAskFollowUp);
      let followUpQuestion = String(parsed?.followUpQuestion || '').trim();

      if (depth < minDepth) shouldAskFollowUp = true;
      if (depth >= maxDepth) shouldAskFollowUp = false;

      if (shouldAskFollowUp && followUpQuestion && askedSet.has(normalizeQuestionDedupe(followUpQuestion))) {
        followUpQuestion = pickDistinctContextFollowUp(coreQuestionText, answerText, depth, askedSet);
      }

      if (shouldAskFollowUp && !followUpQuestion) {
        return res.json({
          isVague: true,
          shouldAskFollowUp: true,
          reason: 'fallback_followup',
          followUpQuestion: pickDistinctContextFollowUp(coreQuestionText, answerText, depth, askedSet)
        });
      }

      return res.json({
        isVague,
        shouldAskFollowUp,
        reason: isVague ? 'model_flagged_vague' : 'clear',
        followUpQuestion: shouldAskFollowUp ? followUpQuestion : ''
      });
    } catch (geminiErr) {
      if (isGeminiQuotaError(geminiErr)) {
        console.warn('Gemini check-answer fallback: quota exhausted, using local follow-up.');
      } else {
        console.error('Gemini check-answer fallback triggered:', geminiErr);
      }
      return res.json({
        isVague: true,
        shouldAskFollowUp: depth < maxDepth,
        reason: 'fallback_followup',
        followUpQuestion:
          depth < maxDepth
            ? pickDistinctContextFollowUp(coreQuestionText, answerText, depth, askedSet)
            : ''
      });
    }
  } catch (err) {
    console.error('POST /check-answer failed:', err);
    return res.status(500).json({
      error: 'Unable to analyze the answer. Please try again.'
    });
  }
});

app.post('/evaluate', async (req, res) => {
  try {
    const { name, email, responses, timestamp } = req.body || {};
    const candidateName = String(name || '').trim();
    const candidateEmail = String(email || '').trim();
    const candidateResponses = Array.isArray(responses) ? responses : [];
    const ts = timestamp ? String(timestamp) : new Date().toISOString();

    if (!candidateName || !candidateEmail) {
      return res.status(400).json({ error: 'Missing candidate name or email.' });
    }

    const systemPrompt = `You are a strict but fair hiring evaluator for Cuemath,
an edtech company that teaches math to children.

Evaluate the tutor candidate STRICTLY based on their
actual interview answers.

STRICT RULES - YOU MUST FOLLOW THESE:

Rule 1: If any answer contains phrases like:
"I will answer it later", "I don't know", "skip",
"pass", or is less than 8 words long, or is blank
→ Give that dimension a score of 1/10 maximum
→ Quote their exact words as evidence

Rule 2: If answers are vague, generic, or have
no specific examples → maximum score is 4/10

Rule 3: If candidate skips or avoids 2 or more
questions → overall_decision MUST be "Not Recommended"
regardless of other scores

Rule 4: overall_decision logic:
→ "Move to Next Round" ONLY IF:
   - overall_score is 7.0 or above
   - AND no single dimension score is below 5
   - AND candidate actually answered all questions
→ "Not Recommended" in ALL other cases

Rule 5: Never give 10/10 unless the answer is
truly outstanding with specific examples and
exceptional teaching ability shown

Rule 6: Be honest - do not try to be kind or
generous with scores. Cuemath needs quality tutors.

Rule 7: Always quote the candidate's EXACT words
as evidence for each dimension score

Evaluate these 5 dimensions:
1. communication_clarity - Are they clear and structured?
2. warmth_empathy - Do they genuinely care about children?
3. patience - Do they show patience with struggling students?
4. ability_to_simplify - Can they explain things simply?
5. english_fluency - Grammar, vocabulary, confidence

Return ONLY this exact JSON structure, nothing else,
no markdown, no backticks, no explanation:

{
  "communication_clarity": {
    "score": 0,
    "comment": "2 honest lines about this dimension",
    "quote": "exact words candidate said"
  },
  "warmth_empathy": {
    "score": 0,
    "comment": "2 honest lines about this dimension",
    "quote": "exact words candidate said"
  },
  "patience": {
    "score": 0,
    "comment": "2 honest lines about this dimension",
    "quote": "exact words candidate said"
  },
  "ability_to_simplify": {
    "score": 0,
    "comment": "2 honest lines about this dimension",
    "quote": "exact words candidate said"
  },
  "english_fluency": {
    "score": 0,
    "comment": "2 honest lines about this dimension",
    "quote": "exact words candidate said"
  },
  "overall_score": 0,
  "overall_decision": "Not Recommended or Move to Next Round",
  "overall_summary": "3-4 honest sentences about candidate",
  "key_strengths": ["strength 1", "strength 2"],
  "areas_for_improvement": ["improvement 1", "improvement 2"]
}`;

    const userPrompt =
      `Candidate:\nName: ${candidateName}\nEmail: ${candidateEmail}\nTimestamp: ${ts}\n\n` +
      'Conversation answers (questions with answers and optional follow-ups):\n' +
      JSON.stringify(candidateResponses, null, 2);

    try {
      const geminiText = await callGemini({ systemPrompt, userPrompt });
      const jsonCandidate = extractFirstJsonObject(geminiText);
      if (!jsonCandidate) {
        console.error('Could not extract JSON from Gemini response:', geminiText);
        return res.status(502).json({ error: 'Evaluation failed. Please try again.' });
      }

      const parsed = JSON.parse(jsonCandidate);
      const enforced = enforceEvaluationConsistency(parsed, candidateResponses);
      return res.json(sanitizeEvaluationPayload(enforced));
    } catch (geminiErr) {
      if (isGeminiQuotaError(geminiErr)) {
        console.warn('Gemini evaluate fallback: quota exhausted, using local scoring.');
        return res.json(sanitizeEvaluationPayload(buildFallbackEvaluation(candidateResponses)));
      }
      throw geminiErr;
    }
  } catch (err) {
    console.error('POST /evaluate failed:', err);
    return res.status(500).json({
      error: 'Unable to evaluate at the moment. Please try again.'
    });
  }
});

// Serve frontend assets without exposing .env.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});
app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.js'));
});

app.use((req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

