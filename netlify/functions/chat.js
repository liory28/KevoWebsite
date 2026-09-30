// Netlify Function — holds the Anthropic API key server-side so it is never exposed
// to the browser. The client (index.html) POSTs { turns, images, json } to /api/chat
// (redirected to this function by netlify.toml) and expects back
// { text, truncated } on success, or a JSON error body with a `code` field on failure.
//
// Env vars (set in Netlify: Site configuration -> Environment variables):
//   ANTHROPIC_API_KEY  (required)
//   ANTHROPIC_MODEL    (optional — defaults to a current Claude Sonnet model)

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 700;

// Very light per-IP rate limit — a deterrent only, not production-grade abuse protection.
// Resets whenever the function's container recycles; fine for a broker-network demo, worth
// hardening (Netlify's own rate limiting, or a Redis-backed one via Upstash) before wider release.
const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + WINDOW_MS; }
  rec.count += 1;
  hits.set(ip, rec);
  return rec.count > MAX_PER_WINDOW;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event, context) => {
  if (event.httpMethod === 'GET') {
    // Used by the client purely to detect that this backend exists (see initAI() in index.html).
    return json(405, { code: 'method_not_allowed' });
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { code: 'method_not_allowed' });
  }

  const ip = (
    (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'unknown'
  ).split(',')[0].trim();
  if (rateLimited(ip)) {
    return json(429, { code: 'rate_limited' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { code: 'server_misconfigured', message: 'ANTHROPIC_API_KEY is not set on this deployment.' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const turns = Array.isArray(body.turns) ? body.turns : [];
  const images = Array.isArray(body.images) ? body.images : [];
  const wantJson = !!body.json;

  if (!turns.length) {
    return json(400, { code: 'bad_request', message: 'No turns provided.' });
  }

  // Build Anthropic Messages API turns. The first user turn carries any uploaded images
  // (document reads) as image content blocks alongside its text.
  const messages = turns.map((t, i) => {
    const role = t.role === 'assistant' ? 'assistant' : 'user';
    const content = [{ type: 'text', text: String(t.content || '') }];
    if (i === 0 && images.length && role === 'user') {
      images.forEach((img) => {
        content.unshift({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data },
        });
      });
    }
    return { role, content };
  });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages,
        ...(wantJson ? { system: 'Respond with ONLY valid JSON. No prose, no markdown code fences.' } : {}),
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const code = resp.status === 429 ? 'rate_limited' : 'backend_error';
      const statusCode = resp.status >= 400 && resp.status < 500 ? resp.status : 502;
      return json(statusCode, {
        code,
        message: (errBody && errBody.error && errBody.error.message) || 'Anthropic API error.',
      });
    }

    const data = await resp.json();
    const text = (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    const truncated = data.stop_reason === 'max_tokens';
    return json(200, { text, truncated });
  } catch (e) {
    return json(502, { code: 'backend_error', message: String((e && e.message) || e) });
  }
};
