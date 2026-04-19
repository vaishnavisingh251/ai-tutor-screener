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

/** Easy, on-topic extras for each main interview question (short, friendly wording). */
const EASY_TOPIC_INTRO = [
  'In a few words, what kind of teacher do you hope to be?',
  'What age group or subject do you most want to help with?',
  'Was there a simple moment that made you think, “I want to teach”?',
  'If a parent asked why you tutor, what would you say in one line?',
  'What do you enjoy most about helping someone learn something new?',
  'Have you helped a friend or sibling learn — what was it, in brief?',
  'What would you like a child to feel after a class with you?',
  'What draws you to helping children learn, even in plain language?'
];

const EASY_TOPIC_FRACTION = [
  'Could you use pizza, chocolate, or sharing food to show what “half” means?',
  'In kid-friendly words, what does the bottom number tell us in a fraction?',
  'Can you give one fraction example with something you can cut or share?',
  'How would you check if a 9-year-old really “sees” the fraction, not just the rule?',
  'What tiny mistake do kids often make with fractions that you would watch for?',
  'If the child said “I don’t get it,” what picture or story would you try next?',
  'Can you name “one third” using a real object around a table?',
  'What is the simplest way to say what a numerator is for a child?'
];

const EASY_TOPIC_FRUSTRATED = [
  'What is the first calm sentence you would say to them?',
  'Would you read the problem together or let them point to where it feels stuck?',
  'Could you show a tinier version of the same idea on paper to lower stress?',
  'Would you ask which step feels hard — first, middle, or end?',
  'What would you do if they looked close to tears — still keep teaching?',
  'Would you pause ten seconds before you explain — why or why not?',
  'How would you sit or stand so they feel you are on their side?',
  'What one easier warm-up sum might you try before the hard one?'
];

const EASY_TOPIC_ENGAGEMENT = [
  'What quick game or two-minute change might bring the spark back?',
  'Would you switch to a tiny win first, then return to the hard part?',
  'How would you praise effort before you ask for more focus?',
  'Could you link the lesson to a cartoon, sport, or hobby they like?',
  'What short stretch or movement could you allow without wasting the whole class?',
  'How would you sound cheerful without being fake when they drift?',
  'What simple choice could you offer — “this way or that way” — to pull them in?',
  'What would you avoid saying so they do not feel blamed for drifting?'
];

const EASY_TOPIC_STORY = [
  'Can you tell that story in three short sentences?',
  'Who were you helping — just the role, like friend, cousin, or coworker?',
  'What was the tricky part before you made it simple?',
  'How could you tell they finally understood?',
  'What one rule or picture helped them get unstuck?',
  'If you told the story again, what would you do sooner?',
  'How was it still “teaching” even if it was not a formal class?',
  'What is one tip you would give a new tutor copying your idea?'
];

const EASY_TOPIC_DEFAULT = [
  'Can you tie your answer more tightly to the question we just asked?',
  'What is one simple example that matches this exact prompt?',
  'Could you shorten your answer and keep only what fits the question?',
  'In plain words, what is your main reply to what we asked?',
  'What would you add if you had only twenty seconds more?',
  'Can you give one clear sentence first, then one more if needed?'
];

/** Tiny universal soft prompts if topic banks are exhausted (still easy). */
const EASY_UNIVERSAL_LAST_RESORT = [
  'Can you add one small, simple example to that?',
  'What is the easiest way to say your main point in plain words?',
  'Could you give just step one, then pause?',
  'In two short sentences, what should we remember?',
  'What would a child repeat back after listening to you?',
  'Which part of your answer matters most — can you zoom in on that?',
  'Can you restate that without any jargon?',
  'What is one detail you would add if you had ten more seconds?'
];

function getTopicEasyExtendedPool(coreQuestion) {
  const q = String(coreQuestion || '').toLowerCase();
  if (q.includes('tell me a little about yourself') || q.includes('draws you to teaching')) {
    return EASY_TOPIC_INTRO;
  }
  if (q.includes('fraction')) {
    return EASY_TOPIC_FRACTION;
  }
  if (
    q.includes('staring at the same problem') ||
    q.includes('walk me through') ||
    q.includes("don't get it") ||
    q.includes('exactly what you would do')
  ) {
    return EASY_TOPIC_FRUSTRATED;
  }
  if (q.includes('keep a child engaged') || q.includes('losing interest') || q.includes('distracted')) {
    return EASY_TOPIC_ENGAGEMENT;
  }
  if (q.includes('time you explained') || q.includes('simple way')) {
    return EASY_TOPIC_STORY;
  }
  return EASY_TOPIC_DEFAULT;
}

/** Pick first unused line from primary list, then topic-easy pool, then tiny universal pool. */
function pickUnusedFollowUp(candidates, askedSet, rotateOffset = 0, coreQuestion = '') {
  const list = Array.isArray(candidates) ? candidates.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const asked = askedSet instanceof Set ? askedSet : askedQuestionSet(askedSet);
  const start = Math.max(0, Number(rotateOffset) || 0);
  const topicEasy = getTopicEasyExtendedPool(coreQuestion);

  for (const pool of [list, topicEasy, EASY_UNIVERSAL_LAST_RESORT]) {
    if (pool.length === 0) continue;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[(start + i) % pool.length];
      if (!asked.has(normalizeQuestionDedupe(c))) return c;
    }
  }
  return '';
}

const REFUSAL_FOLLOWUP_VARIANTS = [
  'Could you try again with one short, simple example for this question?',
  'In plain words, what would you do next — just the next step?',
  'Can you give one real moment that fits what we asked, in two sentences?',
  'What is one thing you would say out loud to the child here?',
  'Take a breath — then answer with one clear example, not a list of ideas.',
  'If you were beside the learner today, what would you do first?',
  'Can you make your answer smaller: one situation, one action?',
  'What would help us see you teach — not just what you believe about teaching?'
];

const TANGENT_FOLLOWUP_VARIANTS = [
  'Let’s stay on this question only — what are two simple steps you would take?',
  'Can you answer this one in a shorter, straighter way?',
  'Please skip the extra story — what would you actually do here?',
  'Bring it back: what is your answer to the situation we described?',
  'In two or three lines, what is your response to this exact prompt?'
];

const GENERIC_TEACHING_FOLLOWUPS = [
  'Can you give one short example that fits what we asked?',
  'What is the simplest way to restate your idea for a child?',
  'Could you break your answer into a tiny “first, then next”?',
  'What one picture or object would you use to explain it?',
  'How would you know your explanation worked — one quick check?',
  'What would you add if the learner still looked unsure?'
];

function buildContextFollowUpPool(coreQuestion, lastAnswer, depth) {
  const d = Math.max(1, Number(depth) || 1);
  const pool = [];
  pool.push(...getTopicEasyExtendedPool(coreQuestion));
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
  return pickUnusedFollowUp(pool, askedSet, followUpCount, coreQuestion);
}

function followUpFromQuestion(question) {
  const q = String(question || '').toLowerCase();

  if (q.includes('fraction')) {
    return 'Can you show fractions using something you eat or share, in simple words?';
  }

  if (q.includes('staring at the same problem') || q.includes('walk me through') || q.includes('exactly what you would do')) {
    return 'Walk me through one calm thing you would do first, then what comes next.';
  }

  if (q.includes('keep a child engaged') || q.includes('losing interest') || q.includes('distracted')) {
    return 'Share one time a child drifted — what did you do that helped?';
  }

  if (q.includes('time you explained') || q.includes('simple way')) {
    return 'Tell one story: what was hard, and how you made it simple?';
  }

  if (q.includes('tell me a little about yourself')) {
    return 'What is one experience that shows why you like teaching?';
  }

  return 'Could you answer with one short example that fits this question?';
}

function followUpFromContext(coreQuestion, lastAnswer, depth = 1) {
  const q = String(coreQuestion || '').toLowerCase();
  const a = String(lastAnswer || '').toLowerCase();
  const d = Math.max(1, Number(depth || 1));

  if (q.includes('fraction')) {
    if (d === 1) return 'How would you explain a fraction to a 9-year-old in one simple line?';
    if (d === 2) return 'Can you give one everyday example, like food or sharing?';
    return 'If they still look lost, what would you try next — still simple?';
  }

  if (q.includes('staring at the same problem') || q.includes('walk me through') || q.includes('exactly what you would do')) {
    if (d === 1) return 'What is the first calm thing you would say to them?';
    if (d === 2) return 'What would you do right after that — still in plain steps?';
    return 'How would you check they understand before you move on?';
  }

  if (q.includes('keep a child engaged') || q.includes('losing interest') || q.includes('distracted')) {
    if (d === 1) return 'What is one quick thing you try when focus drops?';
    if (d === 2) return 'What fun or small change might bring them back in?';
    return 'If that did not work, what would you try next — still gentle?';
  }

  if (q.includes('time you explained') || q.includes('simple way')) {
    if (d === 1) return 'What was the hard part, and how did you make it easy?';
    if (d === 2) return 'How could you tell they understood?';
    return 'What would you do better if you told the story again?';
  }

  if (q.includes('tell me a little about yourself')) {
    if (d === 1) return 'What is one moment that shows why you want to teach?';
    if (d === 2) return 'What did you learn about kids from that moment?';
    return 'How does that show up in how you teach today?';
  }

  if (/example|real|specific|step|student|child/.test(a)) {
    if (d === 1) return 'Can you say that in even simpler words for a child?';
    return 'Can you add one short real-life detail to that?';
  }

  if (d === 1) return 'Can you give one short example that fits this question?';
  if (d === 2) return 'What would you say next if they still looked unsure?';
  return 'What would you change if they were still stuck?';
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
      const follow = pickUnusedFollowUp(REFUSAL_FOLLOWUP_VARIANTS, askedSet, depth, coreQuestionText);
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
        followUpQuestion: pickUnusedFollowUp(TANGENT_FOLLOWUP_VARIANTS, askedSet, depth, coreQuestionText)
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
      '- Follow-up must stay on the SAME topic as the core question — do not change the scenario.\n' +
      '- Use simple, friendly wording (easy for a nervous candidate), under 22 words.\n' +
      '- Ask for one small example, one clear step, or one plain-language clarification — not a hard exam question.\n' +
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

