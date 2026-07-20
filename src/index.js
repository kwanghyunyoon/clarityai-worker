const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-ClarityAI-Key',
};

const BASE_PERSONA = `You are ClarityAI, a warm, grounded assistant. You help the user think
things through, answer general questions, and — when connected data is available — reflect on
patterns in their mood and sleep. You are not a therapist and don't diagnose; you're a thoughtful
companion. Keep replies concise and conversational.`;

function buildSystemPrompt(connectedContext) {
  let prompt = BASE_PERSONA;

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

  return prompt;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/chat' || request.method !== 'POST') {
      return new Response('Not Found', { status: 404, headers: CORS });
    }

    // Low-effort deterrent against casual/automated scraping of this public
    // endpoint's Workers AI usage — not a strong security boundary, since
    // EXPO_PUBLIC_* values ship in the client bundle and can be extracted.
    if (env.CLARITYAI_SHARED_SECRET && request.headers.get('X-ClarityAI-Key') !== env.CLARITYAI_SHARED_SECRET) {
      return new Response('Unauthorized', { status: 401, headers: CORS });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers: CORS });
    }

    const { messages, connectedContext } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response('Missing messages', { status: 400, headers: CORS });
    }

    const chatMessages = [
      { role: 'system', content: buildSystemPrompt(connectedContext) },
      ...messages,
    ];

    let stream;
    try {
      stream = await env.AI.run(env.AI_MODEL, { messages: chatMessages, stream: true });
    } catch (err) {
      console.error('Workers AI error:', err.message);
      return new Response('Upstream error', { status: 502, headers: CORS });
    }

    return new Response(stream, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  },
};
