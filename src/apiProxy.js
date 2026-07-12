const GEMINI_PROXY_PATH = '/.netlify/functions/gemini'
const ELEVENLABS_PROXY_PATH = '/.netlify/functions/elevenlabs-tts'

export const USE_API_PROXY = import.meta.env.PROD

export async function askGeminiViaProxy({
  userPrompt,
  systemInstruction,
  models,
  imagePart = null,
  generationConfig = { temperature: 1.15, topP: 0.95 },
}) {
  const response = await fetch(GEMINI_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userPrompt,
      systemInstruction,
      models,
      imagePart,
      generationConfig,
    }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error ?? `Gemini proxy HTTP ${response.status}`)
  }

  if (!payload.text) {
    throw new Error('Gemini proxy returned empty text')
  }

  return payload.text
}

export async function requestElevenLabsViaProxy(text, signal) {
  return fetch(ELEVENLABS_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(text).trim() }),
    signal,
  })
}
