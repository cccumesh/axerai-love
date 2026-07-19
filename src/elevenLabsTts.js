import { connectTtsAudio, disconnectTtsAudio, startSpeechLipSync } from './myraLipSync.js'
import { USE_API_PROXY, requestElevenLabsViaProxy } from './apiProxy.js'
import { isAppleMobileBrowser } from './mobileBrowser.js'

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
  return USE_API_PROXY || Boolean(ELEVENLABS_API_KEY)
}

export function getElevenLabsConfigSummary() {
  return {
    configured: isElevenLabsConfigured(),
    voiceId: ELEVENLABS_VOICE_ID || null,
    model: ELEVENLABS_MODEL,
  }
}

let mobileAudioPrimed = false
/** Dedicated unlock element — never used for TTS (iOS: overwriting TTS src kills sound). */
let unlockAudioEl = null
/** HTMLAudioElement path (Android / desktop). */
let ttsAudioEl = null
let sharedAudioCtx = null
let keepAliveOsc = null
let keepAliveGain = null
let unlockInFlight = null
/** Web Audio TTS source (iPhone path). */
let currentBufferSource = null
let currentObjectUrl = null

const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ])
}

function getSharedAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctx()
  }
  return sharedAudioCtx
}

function makeInlineAudio() {
  const audio = new Audio()
  audio.setAttribute('playsinline', '')
  audio.setAttribute('webkit-playsinline', '')
  audio.playsInline = true
  audio.preload = 'auto'
  return audio
}

function getUnlockAudioElement() {
  if (!unlockAudioEl) unlockAudioEl = makeInlineAudio()
  return unlockAudioEl
}

function getTtsAudioElement() {
  if (!ttsAudioEl) ttsAudioEl = makeInlineAudio()
  return ttsAudioEl
}

/** Keep Web Audio session alive on iPhone after first gesture — no extra "tap for sound". */
function startSilentKeepAlive(ctx) {
  if (!ctx || keepAliveOsc) return
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0.00001
    osc.frequency.value = 440
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(0)
    keepAliveOsc = osc
    keepAliveGain = gain
  } catch (error) {
    console.warn('[Audio] keep-alive failed:', error?.name || error)
  }
}

/**
 * Unlock iPhone audio on any existing user gesture (camera allow / first touch).
 * Uses a separate silent <audio> so TTS never gets its src wiped.
 */
export async function ensureMobileAudioUnlocked({ force = false } = {}) {
  const ctx = getSharedAudioContext()
  if (mobileAudioPrimed && !force) {
    if (ctx?.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        // ignore
      }
    }
    return mobileAudioPrimed
  }

  if (unlockInFlight) return unlockInFlight

  unlockInFlight = (async () => {
    try {
      if (ctx?.state === 'suspended') {
        await withTimeout(ctx.resume(), 800)
      }

      // Unmuted near-silent play — muted-only unlock often fails for later TTS on iOS.
      const audio = getUnlockAudioElement()
      audio.muted = false
      audio.volume = 0.01
      audio.src = SILENT_WAV
      const playResult = await withTimeout(audio.play(), 1200)
      if (playResult !== 'timeout') {
        audio.pause()
        try {
          audio.currentTime = 0
        } catch {
          // ignore
        }
      }

      if (ctx) startSilentKeepAlive(ctx)

      try {
        window.speechSynthesis?.resume?.()
      } catch {
        // ignore
      }

      mobileAudioPrimed = true
      return true
    } catch (error) {
      console.warn('[Audio] unlock failed:', error?.name || error)
      return false
    } finally {
      unlockInFlight = null
    }
  })()

  return unlockInFlight
}

/** Call on user tap so iOS allows ElevenLabs playback after async Gemini. */
export function primeMobileAudio({ force = false } = {}) {
  void ensureMobileAudioUnlocked({ force })
}

/** Refresh iOS/Safari audio + speechSynthesis unlock (no extra tap UI). */
export function unlockMobileSpeechAudio({ force = false, speechPing = false } = {}) {
  // Kick AudioContext resume synchronously inside the gesture when possible.
  const ctx = getSharedAudioContext()
  void ctx?.resume?.()

  void ensureMobileAudioUnlocked({ force }).then((ok) => {
    if (!ok || !speechPing) return
    const synth = window.speechSynthesis
    if (!synth) return
    try {
      synth.cancel()
      synth.resume?.()
      const ping = new SpeechSynthesisUtterance(' ')
      ping.volume = 0.01
      ping.rate = 1.2
      synth.speak(ping)
    } catch {
      // ignore
    }
  })
}

function stopBufferSource() {
  if (!currentBufferSource) return
  try {
    currentBufferSource.onended = null
    currentBufferSource.stop(0)
  } catch {
    // already stopped
  }
  try {
    currentBufferSource.disconnect()
  } catch {
    // ignore
  }
  currentBufferSource = null
}

export function stopElevenLabsSpeech() {
  disconnectTtsAudio()
  if (currentAbort) {
    currentAbort.abort()
    currentAbort = null
  }
  stopBufferSource()
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.currentTime = 0
    if (currentAudio._objectUrl) {
      URL.revokeObjectURL(currentAudio._objectUrl)
      currentAudio._objectUrl = null
    }
    currentAudio = null
  }
}

export function isElevenLabsSpeaking() {
  if (currentBufferSource) return true
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
  if (USE_API_PROXY) return { label: 'server proxy', error: 'Credits hidden in proxy mode' }
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
  if (USE_API_PROXY) return
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
  if (USE_API_PROXY) return [ELEVENLABS_VOICE_ID].filter(Boolean)

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

/** iPhone: play TTS through unlocked AudioContext (survives Gemini delay). */
async function playBlobViaWebAudio(blob, { onStart, onEnd, onError }) {
  const ctx = getSharedAudioContext()
  if (!ctx) throw new Error('Web Audio unavailable')

  if (ctx.state === 'suspended') {
    await withTimeout(ctx.resume(), 800)
  }
  startSilentKeepAlive(ctx)

  const arrayBuffer = await blob.arrayBuffer()
  // copy — decodeAudioData may detach the buffer on some WebKits
  const copy = arrayBuffer.slice(0)
  const audioBuffer = await ctx.decodeAudioData(copy)

  stopBufferSource()
  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  gain.gain.value = 1
  source.buffer = audioBuffer
  source.connect(gain)
  gain.connect(ctx.destination)
  currentBufferSource = source

  source.onended = () => {
    if (currentBufferSource === source) currentBufferSource = null
    try {
      source.disconnect()
      gain.disconnect()
    } catch {
      // ignore
    }
    disconnectTtsAudio()
    currentAbort = null
    onEnd?.()
  }

  try {
    source.start(0)
    startSpeechLipSync()
    onStart?.()
  } catch (error) {
    currentBufferSource = null
    onError?.(error instanceof Error ? error : new Error('Web Audio play failed'))
    throw error
  }
}

async function playBlobViaHtmlAudio(blob, { onStart, onEnd, onError }) {
  const objectUrl = URL.createObjectURL(blob)
  currentObjectUrl = objectUrl
  const audio = getTtsAudioElement()
  audio.muted = false
  audio.volume = 1
  audio.src = objectUrl
  audio._objectUrl = objectUrl
  currentAudio = audio

  const cleanup = () => {
    if (currentObjectUrl === objectUrl) {
      URL.revokeObjectURL(objectUrl)
      currentObjectUrl = null
    }
    audio._objectUrl = null
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

  const ctx = getSharedAudioContext()
  if (ctx?.state === 'suspended') {
    await ctx.resume().catch(() => {})
  }
  connectTtsAudio(audio)
  await audio.play()
  onStart?.()
}

async function playBlob(blob, { onStart, onEnd, onError }) {
  if (!blob?.size) {
    throw new Error('ElevenLabs returned empty audio')
  }

  // Resume context only — never rewrite TTS src with silent unlock WAV.
  void ensureMobileAudioUnlocked({ force: false })

  try {
    if (isAppleMobileBrowser()) {
      try {
        await playBlobViaWebAudio(blob, { onStart, onEnd, onError })
        return
      } catch (webAudioError) {
        console.warn('[Audio] Web Audio TTS failed, trying HTML audio:', webAudioError)
      }
    }
    await playBlobViaHtmlAudio(blob, { onStart, onEnd, onError })
  } catch (error) {
    const name = error instanceof Error ? error.name : 'PlaybackError'
    throw new Error(
      `iPhone audio block (${name}) — Silent mode off karo, volume up, phir camera allow / screen tap karke dubara try karo`,
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
  if (USE_API_PROXY) {
    return requestElevenLabsViaProxy(text, signal)
  }

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
  if (USE_API_PROXY) {
    return { ok: true, voiceId: 'server-proxy', model: ELEVENLABS_MODEL }
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
    console.warn(
      import.meta.env.PROD
        ? '[ElevenLabs] Not configured — set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID on Netlify (server env).'
        : '[ElevenLabs] Not configured — using browser TTS. Add VITE_ELEVENLABS_API_KEY to .env',
    )
    return
  }

  if (USE_API_PROXY) {
    console.log('[ElevenLabs] Using Netlify proxy — API key stays server-side')
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
