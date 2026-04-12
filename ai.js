/**
 * api/ai.js  —  Vercel Serverless Function
 *
 * Deploy path on Vercel: /api/ai
 * This single file handles all AI endpoints via the `action` body field.
 *
 * Actions:
 *   chat               → general study assistant message
 *   quiz/generate      → structured quiz questions
 *   flashcards/generate→ flashcard deck
 *
 * Vercel auto-detects files inside /api/ and exposes them as serverless routes.
 * No Express, no server.js needed — just export a default async function.
 */

// ── In-memory stores (per warm instance — good enough for Vercel's single-region warm containers)
// For true multi-instance rate limiting, swap to Vercel KV (upstash redis) — see comment at bottom
const rateLimitStore = new Map();
const cacheStore     = new Map();

const WINDOW_MS    = 60_000;
const WINDOW_MAX   = 20;
const HEAVY_MAX    = 5;
const CACHE_TTL_MS = 10 * 60_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getUserId(req) {
  const uid = req.headers['x-user-id'];
  if (uid && /^[\w\-]{4,128}$/.test(uid)) return uid;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return `ip:${ip}`;
}

function checkRateLimit(userId, isHeavy) {
  const limit = isHeavy ? HEAVY_MAX : WINDOW_MAX;
  const now   = Date.now();
  let entry   = rateLimitStore.get(userId);
  if (!entry || now - entry.windowStart > WINDOW_MS) entry = { count: 0, windowStart: now };
  entry.count++;
  rateLimitStore.set(userId, entry);
  const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
  return { allowed: entry.count <= limit, retryAfter, remaining: Math.max(0, limit - entry.count) };
}

function getCached(key) {
  const e = cacheStore.get(key);
  if (!e || Date.now() > e.expiresAt) { cacheStore.delete(key); return null; }
  return e.data;
}

function setCached(key, data, ttl = CACHE_TTL_MS) {
  if (cacheStore.size > 300) {
    // Evict oldest entry
    cacheStore.delete(cacheStore.keys().next().value);
  }
  cacheStore.set(key, { data, expiresAt: Date.now() + ttl });
}

function sanitize(text) {
  if (typeof text !== 'string') throw { status: 400, message: 'Input must be a string' };
  const clean = text.slice(0, 2000).replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (clean.length < 2) throw { status: 400, message: 'Input is too short' };
  return clean;
}

function parseAiJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch {
    // Try to find the JSON array/object inside the text
    const start = Math.min(
      cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('['),
      cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{')
    );
    if (start !== Infinity) {
      const isArr = cleaned[start] === '[';
      const open = isArr ? '[' : '{'; const close = isArr ? ']' : '}';
      let depth = 0, end = -1;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === open) depth++;
        else if (cleaned[i] === close && --depth === 0) { end = i; break; }
      }
      if (end !== -1) try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
    throw { status: 502, message: 'AI returned invalid JSON' };
  }
}

// ── Gemini API call with retry ────────────────────────────────────────────────

async function callGemini(payload, attempt = 1) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw { status: 500, message: 'GEMINI_API_KEY not configured on server' };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(28_000), // Vercel hobby has 30s max — leave 2s buffer
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const isRetryable = res.status === 429 || res.status >= 500;
    if (isRetryable && attempt < 3) {
      const delay = Math.min(800 * Math.pow(2, attempt - 1) + Math.random() * 200, 6000);
      await sleep(delay);
      return callGemini(payload, attempt + 1);
    }
    throw { status: 502, message: data?.error?.message || `Gemini API error ${res.status}` };
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw { status: 502, message: 'AI returned an empty response' };
  return text.trim();
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleChat(body) {
  const message = sanitize(body.message || '');
  const system  = typeof body.systemInstruction === 'string'
    ? body.systemInstruction.slice(0, 500)
    : 'You are a helpful, concise study assistant.';

  const cacheKey = `chat:${message}`;
  const cached   = getCached(cacheKey);
  if (cached) return { text: cached, cached: true };

  const text = await callGemini({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: message }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  });

  setCached(cacheKey, text, 2 * 60_000); // Chat cached 2 min
  return { text, cached: false };
}

async function handleQuiz(body) {
  const topic      = sanitize(body.topic || '');
  const difficulty = ['easy','medium','hard'].includes(body.difficulty) ? body.difficulty : 'medium';
  const count      = Math.min(Math.max(parseInt(body.count) || 8, 3), 15);

  const cacheKey = `quiz:${topic.toLowerCase()}:${difficulty}:${count}`;
  const cached   = getCached(cacheKey);
  if (cached) return { questions: cached, cached: true };

  const prompt = `Generate exactly ${count} multiple-choice quiz questions about "${topic}" at ${difficulty} difficulty.
Return ONLY a JSON array, no markdown, no explanation:
[{"question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A) ...","explanation":"..."}]`;

  const raw  = await callGemini({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.5, maxOutputTokens: 2048 },
  });

  let questions = parseAiJson(raw);
  if (!Array.isArray(questions)) throw { status: 502, message: 'AI quiz response was not an array' };
  questions = questions.slice(0, count).map((q, i) => {
    if (!q.question || !Array.isArray(q.options) || !q.answer)
      throw { status: 502, message: `Question ${i} has invalid structure` };
    return {
      question:    String(q.question).slice(0, 400),
      options:     q.options.slice(0, 4).map(o => String(o).slice(0, 200)),
      answer:      String(q.answer).slice(0, 200),
      explanation: String(q.explanation || '').slice(0, 400),
      // Also support 0-based correct index for the existing frontend quiz renderer
      correct:     q.correct !== undefined ? Number(q.correct) : 0,
    };
  });

  setCached(cacheKey, questions);
  return { questions, cached: false };
}

async function handleFlashcards(body) {
  const topic = sanitize(body.topic || '');
  const count = Math.min(Math.max(parseInt(body.count) || 10, 3), 20);

  const cacheKey = `fc:${topic.toLowerCase()}:${count}`;
  const cached   = getCached(cacheKey);
  if (cached) return { cards: cached, cached: true };

  const prompt = `Create ${count} flashcards for studying "${topic}".
Return ONLY a JSON array:
[{"front":"question or term","back":"answer or definition"}]`;

  const raw   = await callGemini({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 2048 },
  });

  let cards = parseAiJson(raw);
  if (!Array.isArray(cards)) throw { status: 502, message: 'AI flashcard response was not an array' };
  cards = cards
    .map(c => ({ front: String(c.front || '').slice(0, 300), back: String(c.back || '').slice(0, 300) }))
    .filter(c => c.front && c.back);

  setCached(cacheKey, cards);
  return { cards, cached: false };
}

// ── Main Vercel handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  // ── CORS headers — set your actual domain in production ──
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin',  allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-ID');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'method_not_allowed' });

  const userId  = getUserId(req);
  const body    = req.body || {};
  const action  = String(body.action || '').trim();
  const isHeavy = action === 'quiz/generate' || action === 'flashcards/generate';

  // ── Rate limit ──
  const rl = checkRateLimit(userId, isHeavy);
  res.setHeader('X-RateLimit-Remaining', rl.remaining);
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({
      error: 'rate_limit_exceeded',
      message: `Too many requests. Wait ${rl.retryAfter}s.`,
      retryAfter: rl.retryAfter,
    });
  }

  // ── Dispatch to action ──
  try {
    let result;
    if      (action === 'chat')                  result = await handleChat(body);
    else if (action === 'quiz/generate')         result = await handleQuiz(body);
    else if (action === 'flashcards/generate')   result = await handleFlashcards(body);
    else return res.status(400).json({ error: 'unknown_action', message: `Unknown action: ${action}` });

    return res.status(200).json(result);

  } catch (err) {
    // Operational (expected) errors have a `status` field we set ourselves
    if (err.status) {
      return res.status(err.status).json({ error: 'request_error', message: err.message });
    }
    // Unexpected errors — log server-side, return generic message
    console.error('[StudyDrop API Error]', err);
    return res.status(500).json({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  }
}

/*
 * ── TO SCALE TO MULTI-INSTANCE RATE LIMITING ────────────────────────────────
 * Install: npm install @vercel/kv
 * Replace checkRateLimit() with:
 *
 *   import { kv } from '@vercel/kv';
 *   async function checkRateLimit(userId, isHeavy) {
 *     const key = `rl:${userId}`;
 *     const count = await kv.incr(key);
 *     if (count === 1) await kv.expire(key, 60);
 *     const limit = isHeavy ? HEAVY_MAX : WINDOW_MAX;
 *     return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfter: 60 };
 *   }
 *
 * Set GEMINI_API_KEY and KV_URL in Vercel project settings → Environment Variables.
 */
