// api/ai.js — StudyDrop AI backend using Google Gemini
// Set GEMINI_API_KEY in Vercel Environment Variables (Settings → Environment Variables)

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-1.5-flash';   // fast & free-tier friendly
const MAX_TOKENS     = 1024;

// Simple in-memory rate limit (per user, resets when function cold-starts)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX       = 20;        // max 20 requests per minute per user

function checkRateLimit(userId) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimitMap.set(userId, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

export default async function handler(req, res) {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-ID');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── API key check ──
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel environment variables.' });
  }

  // ── Rate limit ──
  const userId = req.headers['x-user-id'] || req.socket?.remoteAddress || 'anon';
  if (!checkRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.', retryAfter: 60 });
  }

  try {
    const { action, message, systemInstruction, history } = req.body || {};

    if (!action) return res.status(400).json({ error: 'Missing action' });

    // ── Build Gemini request ──
    let contents = [];

    if (action === 'chat') {
      // Single turn or multi-turn chat
      if (Array.isArray(history) && history.length > 0) {
        // Multi-turn: convert history to Gemini format
        contents = history.map(h => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content || '' }]
        }));
      } else {
        // Single turn
        contents = [{ role: 'user', parts: [{ text: message || '' }] }];
      }
    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    // ── Call Gemini ──
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: systemInstruction
            ? { parts: [{ text: systemInstruction }] }
            : undefined,
          contents,
          generationConfig: {
            maxOutputTokens: MAX_TOKENS,
            temperature: 0.7,
            topP: 0.9,
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          ],
        }),
      }
    );

    if (!geminiRes.ok) {
      const errBody = await geminiRes.json().catch(() => ({}));
      console.error('Gemini API error:', geminiRes.status, errBody);

      if (geminiRes.status === 429) {
        return res.status(429).json({ error: 'Gemini rate limit hit. Try again in a moment.', retryAfter: 30 });
      }
      if (geminiRes.status === 400) {
        return res.status(400).json({ error: 'Bad request to Gemini: ' + (errBody?.error?.message || 'unknown') });
      }
      return res.status(502).json({ error: 'Gemini API unavailable. Try again.' });
    }

    const data = await geminiRes.json();

    // Extract text from response
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      // Could be blocked by safety filters
      const finishReason = data?.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY') {
        return res.status(200).json({ text: "I can't respond to that. Let's keep it study-related! 📚" });
      }
      return res.status(200).json({ text: "I didn't get a response. Please try again." });
    }

    return res.status(200).json({ text });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
      }
