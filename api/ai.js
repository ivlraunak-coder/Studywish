// api/ai.js — StudyDrop AI backend using Google Gemini

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-1.5-flash';
const MAX_TOKENS     = 1024;

// ── Rate Limit ──
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;

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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── API Key Check ──
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'Missing GEMINI_API_KEY in Vercel environment variables'
    });
  }

  // ── Rate Limit ──
  const userId =
    req.headers['x-user-id'] ||
    req.socket?.remoteAddress ||
    'anon';

  if (!checkRateLimit(userId)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait.',
      retryAfter: 60
    });
  }

  try {
    const { action, message, history, systemInstruction } = req.body || {};

    if (!action) {
      return res.status(400).json({ error: 'Missing action' });
    }

    let contents = [];

    // ── Chat Handling ──
    if (action === 'chat') {
      if (Array.isArray(history) && history.length > 0) {
        contents = history.map(h => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content || '' }]
        }));
      } else {
        contents = [
          {
            role: 'user',
            parts: [{ text: message || '' }]
          }
        ];
      }
    } else {
      return res.status(400).json({
        error: 'Unknown action: ' + action
      });
    }

    // ── Gemini API Call ──
    const response = await fetch(
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
            topP: 0.9
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Gemini Error:', response.status, err);

      if (response.status === 429) {
        return res.status(429).json({
          error: 'Gemini rate limit hit. Try again later.'
        });
      }

      return res.status(500).json({
        error: 'Gemini API failed'
      });
    }

    const data = await response.json();

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      return res.status(200).json({
        text: "No response. Try again."
      });
    }

    return res.status(200).json({ text });

  } catch (error) {
    console.error('Server Error:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
}
