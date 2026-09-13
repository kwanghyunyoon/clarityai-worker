const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// --- Tunables ---------------------------------------------------------------
// Free-tier daily message allowance, keyed by device token.
const FREE_DAILY_LIMIT = 25;
// Assumed account-wide Workers AI daily allocation this Worker has to spend
// across every device. UNMEASURED ESTIMATE, biased low deliberately: the
// Workers FREE plan's daily allocation for this specific 30B model is not
// yet known, and overshooting here means free users burn past the real
// Cloudflare ceiling (a hard stop even paying users can't be spared from,
// since there's no way to buy more on the Free plan) — undershooting only
// means the soft gate below trips early, which is safe and just needs
// raising once real neuron usage from the tester period is in.
const DAILY_AI_BUDGET = 300;
// Once cumulative spend today reaches this fraction of DAILY_AI_BUDGET, free
// (non-credit-spending) requests get the "at capacity" response instead of a
// model call, so free traffic can't starve paying devices near the ceiling.
const CAPACITY_RESERVE_THRESHOLD = 0.7;
// Registration abuse guard: device tokens minted per IP per UTC day.
const MAX_REGISTRATIONS_PER_IP_PER_DAY = 5;
const TOKEN_BYTES = 32;

// Canonical wire vocabulary for `{ reason }` error bodies. This is the
// single source of truth on the Worker side — every jsonResponse({ reason })
// call below must use one of these, never a raw string literal, so a typo
// or a forgotten case is a ReferenceError here instead of a silent mismatch
// with the app's ChatWorkerReason union (clarityai/src/lib/chat-worker.ts,
// which mirrors this exact list — no cross-repo import is possible since
// these are two separately deployed projects, so keep the two in sync by
// hand and cross-reference this comment when either changes).
const REASON = {
  INVALID_TOKEN: 'invalid_token',
  DAILY_LIMIT: 'daily_limit',
  NO_CREDITS: 'no_credits',
  CAPACITY: 'capacity',
  MAINTENANCE: 'maintenance',
  RATE_LIMITED: 'rate_limited',
  INVALID_BODY: 'invalid_body',
  UPSTREAM: 'upstream',
};

const BASE_PERSONA = `You are ClarityAI, a warm, grounded assistant. You help the user think
things through, answer general questions, and — when connected data is available — reflect on
patterns in their mood and sleep. You are not a therapist and don't diagnose; you're a thoughtful
companion. Keep replies concise and conversational.`;

const LANGUAGE_NAMES = {
  en: 'English',
  ko: 'Korean',
  es: 'Spanish',
  hi: 'Hindi',
};

// Cost/prompt-size guard, not a security boundary — silently truncated rather
// than rejected, since this is a low-stakes settings field, not user input
// that needs strict validation.
const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 500;

const RESPONSE_LENGTH_INSTRUCTIONS = {
  concise: 'Keep this reply especially short — 1 to 2 sentences, no elaboration unless the user asks for more.',
  detailed:
    "The user has asked for more detailed responses. Feel free to elaborate, add relevant context, and use multiple paragraphs when helpful — don't artificially shorten your reply.",
};

function buildSystemPrompt(connectedContext, lang, customInstructions, responseLength) {
  let prompt = BASE_PERSONA;

  if (customInstructions) {
    const trimmed = customInstructions.slice(0, CUSTOM_INSTRUCTIONS_MAX_LENGTH);
    prompt += `\n\nThe user has also asked you to keep this in mind: ${trimmed}`;
  }

  const languageName = LANGUAGE_NAMES[lang];
  if (languageName) {
    prompt += `\n\nAlways reply in ${languageName}, written in its native script — never in English ` +
      `and never romanized/transliterated, regardless of what language the conversation history is in.`;
  }

  const mood = connectedContext?.mood;
  if (mood) {
    prompt += `\n\nThe user has connected their mood journal (clarity-in-calm). Recent summary: ` +
      `average mood ${mood.avgMood}/5, current streak ${mood.streak} day(s), trend ${mood.trend}, ` +
      `${mood.totalEntries} total entries logged. Reference this naturally when relevant, but don't ` +
      `force it into every reply.`;
  }

  const sleep = connectedContext?.sleep;
  if (sleep) {
    prompt += `\n\nThe user has connected their sleep tracker (dreami). Recent summary: ` +
      `average ${sleep.avgHours} hour(s) of sleep, current streak ${sleep.streak} day(s), trend ` +
      `${sleep.trend}, goal of ${sleep.goalHours} hour(s). Reference this naturally when relevant, ` +
      `but don't force it into every reply.`;
  }

  if (!mood && !sleep) {
    prompt += `\n\nThe user has not connected any mood or sleep data. Chat normally; if it seems ` +
      `useful, you can mention that connecting clarity-in-calm or dreami data would let you give ` +
      `more personalized reflections.`;
  }

  // Last, deliberately: a per-reply formatting constraint benefits from being
  // the most recently stated instruction in a long system prompt.
  const lengthInstruction = RESPONSE_LENGTH_INSTRUCTIONS[responseLength];
  if (lengthInstruction) {
    prompt += `\n\n${lengthInstruction}`;
  }

  return prompt;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilNextUTCMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}

function mintToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadTokenRecord(env, token) {
  const raw = await env.QUOTA_KV.get(`token:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveTokenRecord(env, token, record) {
  return env.QUOTA_KV.put(`token:${token}`, JSON.stringify(record));
}

// Shared by /chat and /usage so the "new UTC day" reset never drifts between
// the two call sites — mutates record in place and returns it.
function resetIfNewDay(record, date) {
  if (record.freeDate !== date) {
    record.freeDate = date;
    record.freeCount = 0;
  }
  return record;
}

function usageFields(record) {
  return { freeCount: record.freeCount, freeLimit: FREE_DAILY_LIMIT, credits: record.credits };
}

// Mints a fresh device token, rate-limited by IP so one IP can't mint
// unbounded tokens to sidestep per-device quotas. Not auth-gated itself —
// this is the thing that hands out auth.
async function handleRegister(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const date = todayUTC();
  const mintKey = `mint:${ip}:${date}`;

  const currentRaw = await env.QUOTA_KV.get(mintKey);
  const current = currentRaw ? parseInt(currentRaw, 10) : 0;

  if (current >= MAX_REGISTRATIONS_PER_IP_PER_DAY) {
    console.log(`MINT_RATE ip=${ip} date=${date} count=${current} result=rejected`);
    return jsonResponse({ reason: REASON.RATE_LIMITED }, 429);
  }

  const token = mintToken();
  const record = {
    createdAt: new Date().toISOString(),
    freeDate: date,
    freeCount: 0,
    credits: 0,
    revoked: false,
  };

  await Promise.all([
    saveTokenRecord(env, token, record),
    env.QUOTA_KV.put(mintKey, String(current + 1), { expirationTtl: secondsUntilNextUTCMidnight() + 60 }),
  ]);

  console.log(`MINT_RATE ip=${ip} date=${date} count=${current + 1} result=minted`);
  // Include the fresh allowance so a brand-new install can show "25/25"
  // immediately, without a second round-trip to /usage.
  return jsonResponse({ token, ...usageFields(record) }, 200);
}

// Read-only — no writes, no debit. Lets the client show a live free-message
// counter without needing to send (and pay for) a chat message first. The
// client polls this on screen focus/app-foreground rather than after every
// send, and decrements its own copy optimistically per successful send
// instead — halves the KV reads this endpoint would otherwise cost per
// message, which matters given the account-wide budget concerns above
// (DAILY_AI_BUDGET). A per-message /chat response header would avoid that
// resync round-trip but can't show anything before the user's first send of
// a session, which defeats the point of a counter that's supposed to be
// visible up front.
async function handleUsage(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  if (!token) {
    return jsonResponse({ reason: REASON.INVALID_TOKEN }, 401);
  }

  const record = await loadTokenRecord(env, token);
  if (!record || record.revoked) {
    return jsonResponse({ reason: REASON.INVALID_TOKEN }, 401);
  }

  resetIfNewDay(record, todayUTC());
  return jsonResponse(usageFields(record), 200);
}

async function handleChat(request, env) {
  const killSwitch = await env.QUOTA_KV.get('killswitch');
  if (killSwitch) {
    return jsonResponse({ reason: REASON.MAINTENANCE }, 503);
  }

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  if (!token) {
    return jsonResponse({ reason: REASON.INVALID_TOKEN }, 401);
  }

  const record = await loadTokenRecord(env, token);
  if (!record || record.revoked) {
    return jsonResponse({ reason: REASON.INVALID_TOKEN }, 401);
  }

  const date = todayUTC();
  resetIfNewDay(record, date);

  const hasCredits = record.credits > 0;
  const hasFreeLeft = record.freeCount < FREE_DAILY_LIMIT;

  if (!hasCredits && !hasFreeLeft) {
    return jsonResponse({ reason: REASON.DAILY_LIMIT }, 429);
  }

  const spendKey = `spend:${date}`;
  const spendRaw = await env.QUOTA_KV.get(spendKey);
  const spend = spendRaw ? parseInt(spendRaw, 10) : 0;

  // Paying (credit-spending) requests are exempt from the capacity gate —
  // free traffic must never be able to starve a device that bought credits.
  if (!hasCredits && spend >= DAILY_AI_BUDGET * CAPACITY_RESERVE_THRESHOLD) {
    return jsonResponse({ reason: REASON.CAPACITY }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ reason: REASON.INVALID_BODY }, 400);
  }

  const { messages, connectedContext, lang, customInstructions, responseLength } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ reason: REASON.INVALID_BODY }, 400);
  }

  const chatMessages = [
    { role: 'system', content: buildSystemPrompt(connectedContext, lang, customInstructions, responseLength) },
    ...messages,
  ];

  let stream;
  try {
    stream = await env.AI.run(env.AI_MODEL, { messages: chatMessages, stream: true });
  } catch (err) {
    console.error('Workers AI error:', err.message);
    return jsonResponse({ reason: REASON.UPSTREAM }, 502);
  }

  // Debit only on a successful call — a failed upstream call shouldn't cost
  // the device its free message or a credit.
  if (hasCredits) {
    record.credits -= 1;
  } else {
    record.freeCount += 1;
  }

  await Promise.all([
    saveTokenRecord(env, token, record),
    env.QUOTA_KV.put(spendKey, String(spend + 1), { expirationTtl: secondsUntilNextUTCMidnight() + 3600 }),
  ]);

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/register' && request.method === 'POST') {
      return handleRegister(request, env);
    }

    if (url.pathname === '/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    if (url.pathname === '/usage' && request.method === 'GET') {
      return handleUsage(request, env);
    }

    return new Response('Not Found', { status: 404, headers: CORS });
  },
};
