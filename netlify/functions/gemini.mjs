const DEFAULT_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite']
const RETRIES_PER_MODEL = 1

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorText(error) {
  return String(error?.message ?? error).toLowerCase()
}

function isFatal(status, detail) {
  const msg = `${status} ${detail}`.toLowerCase()
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('api key') ||
    msg.includes('account_state_invalid') ||
    msg.includes('permission denied')
  )
}

function isModelUnavailable(status, detail) {
  const msg = `${status} ${detail}`.toLowerCase()
  return msg.includes('404') || msg.includes('not found') || msg.includes('not supported')
}

function isRetryable(status, detail) {
  const msg = `${status} ${detail}`.toLowerCase()
  return (
    status >= 500 ||
    status === 429 ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('fetch failed')
  )
}

function retryDelayMs(attempt) {
  return 400 * attempt
}

function buildParts(userPrompt, imagePart) {
  const parts = []
  if (imagePart?.mimeType && imagePart?.data) {
    parts.push({
      inlineData: {
        mimeType: imagePart.mimeType,
        data: imagePart.data,
      },
    })
  }
  parts.push({ text: String(userPrompt ?? '') })
  return parts
}

async function callGeminiModel({ apiKey, modelName, systemInstruction, userPrompt, imagePart, generationConfig }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: String(systemInstruction ?? '') }],
      },
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

  let payload
  try {
    payload = JSON.parse(detail)
  } catch {
    throw new Error(`Gemini ${modelName} returned invalid JSON`)
  }

  const text = (payload.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim()

  if (!text) {
    throw new Error(`Gemini ${modelName} returned empty text`)
  }

  const usage = payload.usageMetadata ?? null

  return { text, usage, model: modelName }
}

export default async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const apiKey = String(process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY ?? '').trim()
  if (!apiKey) {
    return jsonResponse({ error: 'GEMINI_API_KEY missing on server' }, 500)
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

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const modelName = models[modelIndex]

    for (let attempt = 1; attempt <= RETRIES_PER_MODEL; attempt += 1) {
      try {
        const result = await callGeminiModel({
          apiKey,
          modelName,
          systemInstruction,
          userPrompt,
          imagePart,
          generationConfig,
        })
        return jsonResponse({
          text: result.text,
          model: result.model,
          usage: result.usage,
        })
      } catch (error) {
        lastError = error
        const status = error.status ?? 500
        const detail = error.detail ?? errorText(error)

        if (isFatal(status, detail)) {
          return jsonResponse({ error: error.message ?? 'Gemini auth failed' }, status)
        }

        if (isModelUnavailable(status, detail)) break

        const canRetry = isRetryable(status, detail) && attempt < RETRIES_PER_MODEL
        if (canRetry) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)))
          continue
        }

        break
      }
    }
  }

  return jsonResponse(
    { error: lastError?.message ?? 'Gemini request failed after retries and fallbacks' },
    502,
  )
}
