import { connectTtsAudio, disconnectTtsAudio } from './myraLipSync.js'

const ELEVENLABS_API_KEY = String(import.meta.env.VITE_ELEVENLABS_API_KEY ?? '').trim()
const ELEVENLABS_VOICE_ID = String(import.meta.env.VITE_ELEVENLABS_VOICE_ID ?? '').trim()
const ELEVENLABS_MODEL = 'eleven_multilingual_v2'

let currentAudio = null
let currentAbort = null
let cachedWorkingVoiceId = null
let cachedVoiceCandidates = null
let connectionProbeDone = false
const cachedVoiceNames = new Map()

export function isElevenLabsConfigured() {
  return Boolean(ELEVENLABS_API_KEY)
}

export function getElevenLabsConfigSummary() {
  return {
    configured: isElevenLabsConfigured(),
    voiceId: ELEVENLABS_VOICE_ID || null,
    model: ELEVENLABS_MODEL,
  }
}

let mobileAudioPrimed = false
let primedAudioEl = null

const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'

function getPrimedAudioElement() {
  if (!primedAudioEl) {
    primedAudioEl = new Audio()
    primedAudioEl.setAttribute('playsinline', '')
    primedAudioEl.playsInline = true
    primedAudioEl.preload = 'auto'
  }
  return primedAudioEl
}

/** Call on user tap so iOS allows ElevenLabs playback after async Gemini. */
export function primeMobileAudio() {
  if (mobileAudioPrimed) return
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (Ctx) {
      const ctx = new Ctx()
      ctx.resume().catch(() => {})
    }
    const audio = getPrimedAudioElement()
    audio.muted = true
    audio.src = SILENT_WAV
    const playPromise = audio.play()
    if (playPromise) {
      playPromise
        .then(() => {
          mobileAudioPrimed = true
          audio.pause()
          audio.currentTime = 0
          audio.muted = false
        })
        .catch((error) => {
          console.warn('[ElevenLabs] Mobile audio prime failed:', error?.name || error)
        })
    }
  } catch (error) {
    console.warn('[ElevenLabs] Mobile audio prime error:', error)
  }
}

export function stopElevenLabsSpeech() {
  disconnectTtsAudio()
  if (currentAbort) {
    currentAbort.abort()
    currentAbort = null
  }
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.currentTime = 0
    if (currentAudio._objectUrl) {
      URL.revokeObjectURL(currentAudio._objectUrl)
    }
    currentAudio = null
  }
}

export function isElevenLabsSpeaking() {
  return Boolean(currentAudio && !currentAudio.paused && !currentAudio.ended)
}

function isQuotaExceeded(detail) {
  return String(detail).includes('quota_exceeded')
}

function isPaidVoiceError(status, detail) {
  return (
    status === 402 ||
    detail.includes('paid_plan_required') ||
    detail.includes('library voices')
  )
}

function isAuthError(status, detail) {
  if (isQuotaExceeded(detail)) return false
  return status === 401 || status === 403
}

function parseTtsError(status, detail) {
  const text = String(detail)

  if (isQuotaExceeded(text)) {
    return {
      fatal: true,
      message:
        'ElevenLabs credits khatam (0 remaining). elevenlabs.io → Profile → Usage check karo. Abhi browser voice use hogi.',
    }
  }

  if (isPaidVoiceError(status, text)) {
    return {
      fatal: false,
      message: 'Selected voice needs paid plan — try a premade or your own cloned voice ID.',
    }
  }

  if (isAuthError(status, text)) {
    return {
      fatal: true,
      message:
        'ElevenLabs API key invalid. elevenlabs.io → Profile → API Keys se naya key banao.',
    }
  }

  return {
    fatal: true,
    message: `ElevenLabs ${status}: ${text.slice(0, 180)}`,
  }
}

async function fetchAccountCredits() {
  try {
    const [subRes, userRes] = await Promise.all([
      fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      }),
      fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      }),
    ])

    let label = 'unknown account'
    if (userRes.ok) {
      const user = await userRes.json()
      label = user.first_name || user.xi_api_key?.slice(0, 8) || label
    }

    if (!subRes.ok) {
      return { label, error: `subscription HTTP ${subRes.status}` }
    }

    const sub = await subRes.json()
    const used = sub.character_count ?? 0
    const limit = sub.character_limit ?? 0
    const remaining = Math.max(0, limit - used)

    return {
      label,
      tier: sub.tier ?? sub.status ?? 'unknown',
      used,
      limit,
      remaining,
    }
  } catch (error) {
    return { label: 'unknown', error: error instanceof Error ? error.message : String(error) }
  }
}

async function loadVoiceNames() {
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    })
    if (!response.ok) return

    const data = await response.json()
    for (const voice of data.voices ?? []) {
      if (voice.voice_id && voice.name) {
        cachedVoiceNames.set(voice.voice_id, voice.name)
      }
    }
    console.log(`[ElevenLabs] Account voices: ${data.voices?.length ?? 0}`)
  } catch (error) {
    console.warn('[ElevenLabs] Could not list voice names:', error)
  }
}

async function fetchVoiceCandidates() {
  if (cachedVoiceCandidates) return cachedVoiceCandidates

  await loadVoiceNames()

  const ids = []
  const add = (id) => {
    if (id && !ids.includes(id)) ids.push(id)
  }

  add(ELEVENLABS_VOICE_ID)
  add(cachedWorkingVoiceId)

  cachedVoiceCandidates = ids
  return cachedVoiceCandidates
}

async function playBlob(blob, { onStart, onEnd, onError }) {
  if (!blob?.size) {
    throw new Error('ElevenLabs returned empty audio')
  }

  const objectUrl = URL.createObjectURL(blob)
  const audio = getPrimedAudioElement()
  audio.muted = false
  audio.src = objectUrl
  audio._objectUrl = objectUrl
  currentAudio = audio

  const cleanup = () => {
    URL.revokeObjectURL(objectUrl)
    audio.removeAttribute('src')
    if (currentAudio === audio) currentAudio = null
    currentAbort = null
  }

  audio.onended = () => {
    disconnectTtsAudio()
    cleanup()
    onEnd?.()
  }

  audio.onerror = () => {
    disconnectTtsAudio()
    cleanup()
    onError?.(new Error('ElevenLabs audio playback failed'))
  }

  try {
    connectTtsAudio(audio)
    onStart?.()
    await audio.play()
  } catch (error) {
    cleanup()
    const name = error instanceof Error ? error.name : 'PlaybackError'
    throw new Error(
      `iPhone audio block (${name}) — Silent mode off karo, volume up, dubara scan karo`,
    )
  }
}

function buildTtsUrl(voiceId) {
  const params = new URLSearchParams({
    output_format: 'mp3_44100_128',
  })
  return `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?${params}`
}

function buildTtsBody(text) {
  return {
    text: String(text).trim(),
    model_id: ELEVENLABS_MODEL,
  }
}

async function requestTtsResponse(text, voiceId, signal) {
  return fetch(buildTtsUrl(voiceId), {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(buildTtsBody(text)),
    signal,
  })
}

async function playTtsResponse(response, callbacks, signal) {
  const blob = await response.blob()
  if (signal.aborted) return
  await playBlob(blob, callbacks)
}

export async function probeElevenLabsConnection() {
  if (!isElevenLabsConfigured()) {
    return { ok: false, error: 'ElevenLabs not configured' }
  }
  if (!ELEVENLABS_VOICE_ID) {
    return { ok: false, error: 'VITE_ELEVENLABS_VOICE_ID missing in .env' }
  }

  try {
    const controller = new AbortController()
    const response = await requestTtsResponse('Test.', ELEVENLABS_VOICE_ID, controller.signal)

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const parsed = parseTtsError(response.status, detail)
      return { ok: false, error: parsed.message }
    }

    const blob = await response.blob()
    if (!blob.size) {
      return { ok: false, error: 'API responded but audio was empty' }
    }

    return { ok: true, voiceId: ELEVENLABS_VOICE_ID, model: ELEVENLABS_MODEL }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function logElevenLabsConnectionOnce() {
  if (connectionProbeDone) return
  connectionProbeDone = true

  const config = getElevenLabsConfigSummary()
  if (!config.configured) {
    console.warn('[ElevenLabs] Not configured — using browser TTS. Add VITE_ELEVENLABS_API_KEY to .env / Netlify env.')
    return
  }

  console.log('[ElevenLabs] Config:', config)

  const account = await fetchAccountCredits()
  if (account.remaining != null) {
    console.log(
      `[ElevenLabs] API key account: "${account.label}" | ${account.remaining.toLocaleString()} credits left (${account.used?.toLocaleString()}/${account.limit?.toLocaleString()} used) | ${account.tier}`,
    )
  } else if (account.error) {
    console.warn('[ElevenLabs] Could not read account credits:', account.error)
  }

  const result = await probeElevenLabsConnection()
  if (result.ok) {
    console.log('[ElevenLabs] Connection OK — voice ready')
  } else {
    console.warn('[ElevenLabs] Connection issue:', result.error)
  }
}

export async function speakWithElevenLabs(text, { onStart, onEnd, onError } = {}) {
  if (!isElevenLabsConfigured()) {
    throw new Error('ElevenLabs is not configured')
  }

  const trimmed = String(text).trim()
  if (!trimmed) {
    onEnd?.()
    return
  }

  stopElevenLabsSpeech()

  const controller = new AbortController()
  currentAbort = controller

  const voiceIds = await fetchVoiceCandidates()
  if (!voiceIds.length) {
    throw new Error('No ElevenLabs voice available')
  }

  let lastError = 'ElevenLabs TTS failed'

  for (const voiceId of voiceIds) {
    try {
      const response = await requestTtsResponse(trimmed, voiceId, controller.signal)

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const parsed = parseTtsError(response.status, detail)
        console.warn(`[ElevenLabs] TTS failed (${voiceId}):`, parsed.message)

        if (parsed.fatal) {
          throw new Error(parsed.message)
        }

        lastError = parsed.message
        continue
      }

      cachedWorkingVoiceId = voiceId
      const voiceName = cachedVoiceNames.get(voiceId) || voiceId
      console.log(`[ElevenLabs] Playing: ${voiceName} (${voiceId})`)
      await playTtsResponse(
        response,
        { onStart, onEnd, onError },
        controller.signal,
      )
      return
    } catch (error) {
      if (controller.signal.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
      if (lastError.includes('credits khatam') || lastError.includes('API key invalid')) {
        throw error
      }
    }
  }

  throw new Error(lastError)
}
