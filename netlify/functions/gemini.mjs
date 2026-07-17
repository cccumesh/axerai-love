import { GoogleGenerativeAI } from '@google/generative-ai'

const DEFAULT_MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-lite-latest']
const RETRIES_PER_MODEL = 2

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sanitizeApiKey(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, '')
}

function keyFingerprint(key) {
  if (!key) return 'missing'
  if (key.startsWith('AQ.')) return `AQ… (${key.length} chars)`
  if (key.startsWith('AIza')) return `AIza… (${key.length} chars)`
  return `other (${key.length} chars)`
}

function isInvalidApiKey(message) {
  return String(message ?? '').toLowerCase().includes('api key')
}

function isModelUnavailable(message) {
  const msg = String(message ?? '').toLowerCase()
  return msg.includes('404') || msg.includes('not found') || msg.includes('not supported')
}

function isRetryable(message) {
  const msg = String(message ?? '').toLowerCase()
  return (
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('high demand')
  )
}

function buildParts(userPrompt, imagePart) {
  const parts = []
  if (imagePart?.mimeType && imagePart?.data) {
    parts.push({ inlineData: { mimeType: imagePart.mimeType, data: imagePart.data } })
  }
  parts.push({ text: String(userPrompt ?? '') })
  return parts
}

/** Same SDK path as localhost — raw fetch + x-goog-api-key fails on some AQ keys. */
async function callGeminiOnce({ apiKey, modelName, systemInstruction, userPrompt, imagePart, generationConfig }) {
  const client = new GoogleGenerativeAI(apiKey)
  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: String(systemInstruction ?? '').trim() || undefined,
    generationConfig: generationConfig ?? { temperature: 1.15, topP: 0.95 },
  })

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: buildParts(userPrompt, imagePart) }],
  })

  const text = result.response.text()?.trim()
  if (!text) throw new Error(`Gemini ${modelName} returned empty text`)

  return {
    text,
    usage: result.response.usageMetadata ?? null,
    model: modelName,
  }
}

export default async (request) => {
  if (request.method === 'GET') {
    const apiKey = sanitizeApiKey(process.env.GEMINI_API_KEY)
    return jsonResponse({
      ok: Boolean(apiKey),
      fingerprint: keyFingerprint(apiKey),
      hint: apiKey ? undefined : 'Set GEMINI_API_KEY (Functions + Runtime scope) and redeploy.',
    })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const apiKey = sanitizeApiKey(process.env.GEMINI_API_KEY)
  if (!apiKey) {
    return jsonResponse(
      {
        error: 'GEMINI_API_KEY missing on server',
        hint: 'Netlify → GEMINI_API_KEY = same as local .env VITE_GEMINI_API_KEY. Scope: Functions + Runtime. Do NOT set VITE_GEMINI_API_KEY on Netlify.',
      },
      500,
    )
  }

  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const {
    userPrompt = '',
    systemInstruction = '',
    models = DEFAULT_MODELS,
    imagePart = null,
    generationConfig = { temperature: 1.15, topP: 0.95 },
  } = body

  if (!String(userPrompt).trim() && !imagePart) {
    return jsonResponse({ error: 'userPrompt is required' }, 400)
  }

  let lastError = null

  for (const modelName of models) {
    for (let attempt = 1; attempt <= RETRIES_PER_MODEL; attempt += 1) {
      try {
        const result = await callGeminiOnce({
          apiKey,
          modelName,
          systemInstruction,
          userPrompt,
          imagePart,
          generationConfig,
        })
        return jsonResponse({ text: result.text, model: result.model, usage: result.usage })
      } catch (error) {
        lastError = error
        const message = error?.message ?? String(error)

        if (isInvalidApiKey(message)) {
          return jsonResponse(
            {
              error: message,
              hint: `Server key ${keyFingerprint(apiKey)} rejected. Paste exact key from local .env into GEMINI_API_KEY (no VITE_ on Netlify). Redeploy.`,
            },
            400,
          )
        }

        if (isModelUnavailable(message)) break
        if (isRetryable(message) && attempt < RETRIES_PER_MODEL) continue
        break
      }
    }
  }

  return jsonResponse({ error: lastError?.message ?? 'Gemini request failed' }, 502)
}
