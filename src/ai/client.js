'use strict';

const config = require('./../config');
const logger = require('./../logger');

/**
 * Minimal provider-agnostic AI client. No SDK: both providers are a single
 * HTTP POST, and avoiding the dependency keeps the install small and the
 * failure modes visible.
 */

const TIMEOUT_MS = 45000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rough token->cost. Gemini free tier is $0, so this only matters on OpenAI. */
const PRICING_PER_1K = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4o': { in: 0.0025, out: 0.01 },
};

function estimateCost(model, inTokens, outTokens) {
  const price = PRICING_PER_1K[model];
  if (!price) return 0;
  return (inTokens / 1000) * price.in + (outTokens / 1000) * price.out;
}

async function callGemini(model, prompt, { maxTokens, schema }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': config.ai.geminiApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const message = json?.error?.message || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    // 429 (rate limit) and 503 (overloaded) are worth retrying; 400/404 are not.
    error.retryable = response.status === 429 || response.status === 503;
    throw error;
  }

  const candidate = json?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((part) => part.text).join('');

  // A truncated response yields unparseable JSON downstream; name the real cause.
  if (candidate?.finishReason === 'MAX_TOKENS' && !text.trim()) {
    throw new Error('response hit the token limit before producing output');
  }

  return {
    text,
    inputTokens: json?.usageMetadata?.promptTokenCount || 0,
    outputTokens: json?.usageMetadata?.candidatesTokenCount || 0,
    costUsd: 0,
  };
}

async function callOpenAI(model, prompt, { maxTokens }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.ai.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(json?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }

  const inputTokens = json?.usage?.prompt_tokens || 0;
  const outputTokens = json?.usage?.completion_tokens || 0;

  return {
    text: json?.choices?.[0]?.message?.content || '',
    inputTokens,
    outputTokens,
    costUsd: estimateCost(model, inputTokens, outputTokens),
  };
}

/**
 * Calls the configured provider with retries on transient failures.
 * Throws on permanent errors so the caller can skip the job rather than
 * silently proceeding without a result.
 */
async function complete(prompt, options = {}) {
  const {
    model = config.ai.cheapModel,
    maxTokens = 900,
    schema = null,
    maxAttempts = 3,
  } = options;

  if (!config.ai.apiKey) {
    throw new Error('No AI API key configured — set GEMINI_API_KEY or OPENAI_API_KEY.');
  }

  const provider = config.ai.provider === 'openai' ? callOpenAI : callGemini;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await provider(model, prompt, { maxTokens, schema });
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === maxAttempts) break;

      // Longer backoff than usual: a 429 here means a free-tier quota window,
      // which needs seconds rather than milliseconds to clear.
      const backoffMs = 5000 * attempt;
      logger.warn(`AI call failed (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs}ms`, {
        error: err.message,
      });
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

/**
 * Parses a JSON object out of a model response, tolerating markdown fences
 * and leading prose. Returns null rather than throwing — a malformed response
 * means skip this job, never crash the run.
 */
function parseJson(text) {
  if (!text) return null;

  const cleaned = String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

module.exports = { complete, parseJson, sleep };
