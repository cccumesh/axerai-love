import { normalizeGeminiUsage } from './geminiUsage.js'

const GEMINI_PROXY_PATH = '/.netlify/functions/gemini'
const ELEVENLABS_PROXY_PATH = '/.netlify/functions/elevenlabs-tts'

export const USE_API_PROXY = import.meta.env.PROD

export async function askGeminiViaProxy({
  userPrompt,
  systemInstruction,
  models,
  imagePart = null,
  generationConfig = { temperature: 0.9, topP: 0.92 },
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
    const message = payload.error ?? `Gemini proxy HTTP ${response.status}`
    const hint = payload.hint ? `\n${payload.hint}` : ''
    const err = new Error(`${message}${hint}`)
    err.hint = payload.hint ?? null
    throw err
  }

  if (!payload.text) {
    throw new Error('Gemini proxy returned empty text')
  }

  return {
    text: payload.text,
    model: payload.model ?? models?.[0] ?? 'unknown',
    usage: normalizeGeminiUsage(payload.usage ?? {}),
  }
}

export async function requestElevenLabsViaProxy(text, signal) {
  return fetch(ELEVENLABS_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(text).trim() }),
    signal,
  })
}
