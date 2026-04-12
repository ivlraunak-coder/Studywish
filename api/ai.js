// api/ai.js — StudyDrop AI backend using OpenRouter (free)
// Set OPENROUTER_API_KEY in Vercel Environment Variables

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = 'meta-llama/llama-3.2-3b-instruct:free'; // completely free model

// Simple rate limit
const rateLimitMap = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 60000) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  rateLimitMap.set(userId, entry);
  return entry.count <= 30;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-ID');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not set in Vercel environment variables.' });
  }

  const userId = req.headers['x-user-id'] || 'anon';
  if (!checkRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.', retryAfter: 60 });
  }

  try {
    const { action, message, systemInstruction, history } = req.body || {};

    if (!action) return res.status(400).json({ error: 'Missing action' });
    if (action !== 'chat') return res.status(400).json({ error: 'Unknown action' });

    // Build messages
    const messages = [];

    messages.push({
      role: 'system',
      content: systemInstruction || 'You are a helpful AI study tutor for StudyDrop, a study tracking app. Help students with concepts, homework, study tips, motivation, and explanations. Be encouraging, clear, and concise.'
    });

    if (Array.isArray(history) && history.length > 0) {
      history.forEach(h => {
        messages.push({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          content: h.content || ''
        });
      });
    } else if (message) {
      messages.push({ role: 'user', content: message });
    }

    // Call OpenRouter
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://studywish.vercel.app',
        'X-Title': 'StudyDrop AI Tutor'
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 1024,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.error('OpenRouter error:', response.status, errBody);
      if (response.status === 429) {
        return res.status(429).json({ error: 'Rate limit hit. Wait a moment.', retryAfter: 10 });
      }
      if (response.status === 401) {
        return res.status(500).json({ error: 'Invalid OpenRouter API key.' });
      }
      return res.status(502).json({ error: 'AI service unavailable. Try again.' });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';

    if (!text) {
      return res.status(200).json({ text: "I didn't get a response. Please try again." });
    }

    return res.status(200).json({ text });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}

