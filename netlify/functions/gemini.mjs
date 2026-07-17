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

function isInvalidApiKey(detail) {
  return String(detail ?? '').toLowerCase().includes('api key')
}

function isModelUnavailable(status, detail) {
  const msg = `${status} ${detail}`.toLowerCase()
  return msg.includes('404') || msg.includes('not found') || msg.includes('not supported')
}

function isRetryable(status, detail) {
  const msg = `${status} ${detail}`.toLowerCase()
  return status >= 500 || status === 429 || msg.includes('unavailable') || msg.includes('overloaded')
}

function buildParts(userPrompt, imagePart) {
  const parts = []
  if (imagePart?.mimeType && imagePart?.data) {
    parts.push({ inlineData: { mimeType: imagePart.mimeType, data: imagePart.data } })
  }
  parts.push({ text: String(userPrompt ?? '') })
  return parts
}

async function callGeminiOnce({ apiKey, modelName, systemInstruction, userPrompt, imagePart, generationConfig }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: String(systemInstruction ?? '') }] },
      contents: [{ role: 'user', parts: buildParts(userPrompt, imagePart) }],
      generationConfig: generationConfig ?? { temperature: 1.15, topP: 0.95 },
    }),
  })

  const detail = await response.text()
  if (!response.ok) {
    const error = new Error(`Gemini ${modelName} HTTP ${response.status}: ${detail.slice(0, 240)}`)
    error.status = response.status
    error.detail = detail
    throw error
  }

  const payload = JSON.parse(detail)
  const text = (payload.candidates ?? [])
    .flatMap((c) => c.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()

  if (!text) throw new Error(`Gemini ${modelName} returned empty text`)
  return { text, usage: payload.usageMetadata ?? null, model: modelName }
}

export default async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const apiKey = sanitizeApiKey(process.env.GEMINI_API_KEY)
  if (!apiKey) {
    return jsonResponse(
      {
        error: 'GEMINI_API_KEY missing on server',
        hint: 'Netlify → Environment variables → GEMINI_API_KEY (Functions scope). Remove VITE_GEMINI_API_KEY so the key stays off the public bundle. Then redeploy.',
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
        const status = error.status ?? 500
        const detail = error.detail ?? error.message ?? ''

        if (isInvalidApiKey(detail)) {
          return jsonResponse(
            {
              error: error.message,
              hint: 'Set GEMINI_API_KEY on Netlify (same key as local .env). Scope: Functions + Runtime. Redeploy after saving.',
            },
            400,
          )
        }

        if (isModelUnavailable(status, detail)) break
        if (isRetryable(status, detail) && attempt < RETRIES_PER_MODEL) continue
        break
      }
    }
  }

  return jsonResponse({ error: lastError?.message ?? 'Gemini request failed' }, 502)
}
