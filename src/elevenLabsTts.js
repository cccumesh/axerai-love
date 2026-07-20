import { connectTtsAudio, disconnectTtsAudio, startSpeechLipSync } from './myraLipSync.js'
import { USE_API_PROXY, requestElevenLabsViaProxy } from './apiProxy.js'
import { isAppleMobileBrowser } from './mobileBrowser.js'

const ELEVENLABS_API_KEY = String(import.meta.env.VITE_ELEVENLABS_API_KEY ?? '').trim()
const ELEVENLABS_VOICE_ID = String(import.meta.env.VITE_ELEVENLABS_VOICE_ID ?? '').trim()
const ELEVENLABS_MODEL = 'eleven_v3'

let currentAudio = null
let currentAbort = null
let cachedWorkingVoiceId = null
let cachedVoiceCandidates = null
let connectionProbeDone = false
const cachedVoiceNames = new Map()

/**
 * ElevenLabs is OFF unless explicitly enabled.
 * Old bug: `USE_API_PROXY` alone returned true in production, so Netlify always
 * tried ElevenLabs even when the project only uses browser TTS — broke iPhone voice.
 *
 * Enable later with Netlify env: VITE_ELEVENLABS_ENABLED=true (+ server ELEVENLABS_* keys).
 */
export function isElevenLabsConfigured() {
  const explicitlyEnabled =
    String(import.meta.env.VITE_ELEVENLABS_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'

  if (USE_API_PROXY) return explicitlyEnabled
  return explicitlyEnabled || Boolean(ELEVENLABS_API_KEY)
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
/** Web Audio TTS source (fallback path). */
let currentBufferSource = null
let currentObjectUrl = null
/** If iOS blocks play(), retry once on the next user gesture. */
let pendingHtmlPlay = null
/**
 * iPhone: TTS blob ready, waiting for Meet Myra begin tap.
 * play() MUST start inside the pointerdown handler (same user gesture).
 */
let deferredTtsJob = null
/** iPhone browser speechSynthesis — also needs the same tap gesture. */
let deferredBrowserTts = null
/** After one successful gesture play, later lines may autoplay. */
let appleGestureUnlocked = false

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

function mountAudioEl(audio) {
  if (typeof document === 'undefined' || !document.body || audio.isConnected) return
  audio.setAttribute('aria-hidden', 'true')
  audio.style.cssText =
    'position:fixed;width:0;height:0;opacity:0;pointer-events:none;left:-9999px'
  document.body.appendChild(audio)
}

function makeInlineAudio() {
  const audio = new Audio()
  audio.setAttribute('playsinline', '')
  audio.setAttribute('webkit-playsinline', '')
  audio.playsInline = true
  audio.preload = 'auto'
  mountAudioEl(audio)
  return audio
}

function getUnlockAudioElement() {
  if (!unlockAudioEl) unlockAudioEl = makeInlineAudio()
  else mountAudioEl(unlockAudioEl)
  return unlockAudioEl
}

function getTtsAudioElement() {
  if (!ttsAudioEl) ttsAudioEl = makeInlineAudio()
  else mountAudioEl(ttsAudioEl)
  return ttsAudioEl
}

/** Keep Web Audio session alive on iPhone only — Android can hear tiny oscillator clicks. */
function startSilentKeepAlive(ctx) {
  if (!ctx || keepAliveOsc || !isAppleMobileBrowser()) return
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

function notifyAudioNeedsTap(needsTap) {
  try {
    window.dispatchEvent(
      new CustomEvent('axerai-audio-needs-tap', { detail: { needsTap: Boolean(needsTap) } }),
    )
  } catch {
    // ignore
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

      // Keep a near-silent looping <audio> alive — pausing often re-locks iOS.
      const unlockEl = getUnlockAudioElement()
      unlockEl.muted = false
      unlockEl.volume = 0.01
      unlockEl.loop = true
      if (unlockEl.paused) {
        unlockEl.src = SILENT_WAV
        await withTimeout(unlockEl.play(), 1200)
      }

      // Prime the same element that will play ElevenLabs later.
      const ttsEl = getTtsAudioElement()
      if (!currentAudio) {
        ttsEl.muted = false
        ttsEl.volume = 0.01
        ttsEl.loop = false
        ttsEl.src = SILENT_WAV
        const ttsPlay = await withTimeout(ttsEl.play(), 1200)
        if (ttsPlay !== 'timeout') {
          ttsEl.pause()
          try {
            ttsEl.currentTime = 0
          } catch {
            // ignore
          }
        }
        ttsEl.volume = 1
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

/**
 * Choocha Safari loophole: empty utterance spoken *synchronously* inside a user
 * gesture. Keeps speechSynthesis unlocked so later browser-TTS can speak after
 * Gemini (even when ElevenLabs credits are gone).
 */
export function primeSafariSpeechSynthesis() {
  if (!isAppleMobileBrowser()) return
  const synth = window.speechSynthesis
  if (!synth) return
  try {
    synth.resume?.()
    // Empty string — same as axerai captureFrame. Do NOT cancel() first.
    synth.speak(new SpeechSynthesisUtterance(''))
  } catch {
    // ignore
  }
}

export function isAppleSpeechGestureUnlocked() {
  return appleGestureUnlocked
}

function clearDeferredTtsJob(reason) {
  if (!deferredTtsJob) return
  const job = deferredTtsJob
  deferredTtsJob = null
  notifyAudioNeedsTap(false)
  if (reason === 'cancel') {
    job.callbacks?.onEnd?.()
    job.resolvePlay?.()
  }
}

function playQueuedBrowserTtsFromGesture() {
  const job = deferredBrowserTts
  if (!job?.text) return false

  clearSilentGestureArm()
  deferredBrowserTts = null
  notifyAudioNeedsTap(false)

  const synth = window.speechSynthesis
  if (!synth) {
    job.callbacks?.onEnd?.()
    job.resolvePlay?.()
    return false
  }

  try {
    // Do not cancel() here — iOS can drop the next speak() after cancel in the same tick.
    synth.resume?.()
  } catch {
    // ignore
  }

  const utterance = new SpeechSynthesisUtterance(job.text)
  // Prefer default Safari voice when none stored — some en-IN voices fail silently.
  if (job.voice) {
    utterance.voice = job.voice
    utterance.lang = job.voice.lang || 'hi-IN'
  } else {
    utterance.lang = job.lang || 'hi-IN'
  }
  utterance.rate = job.rate ?? 1.06
  utterance.pitch = job.pitch ?? 1
  utterance.onstart = () => {
    appleGestureUnlocked = true
    mobileAudioPrimed = true
    startSpeechLipSync()
    job.callbacks?.onStart?.()
  }
  utterance.onend = () => {
    job.callbacks?.onEnd?.()
    job.resolvePlay?.()
  }
  utterance.onerror = (event) => {
    console.warn('[Audio] iPhone browser TTS error:', event?.error || event)
    job.callbacks?.onEnd?.()
    job.resolvePlay?.()
  }

  // Must call speak() inside the user gesture — Safari drops delayed speak().
  synth.speak(utterance)
  console.info('[Audio] iPhone browser TTS started from tap')
  return true
}

/**
 * Call from Meet Myra / Begin pointerdown — starts play/speak in the same gesture.
 * This is the reliable iPhone path (autoplay after Gemini delay always fails).
 */
export function playQueuedTtsFromUserGesture() {
  const ctx = getSharedAudioContext()
  void ctx?.resume?.()

  // Browser TTS queue (default when ElevenLabs is off).
  if (deferredBrowserTts?.text) {
    return playQueuedBrowserTtsFromGesture()
  }

  const job = deferredTtsJob || pendingHtmlPlay
  if (!job?.blob) {
    void ensureMobileAudioUnlocked({ force: true })
    return false
  }

  deferredTtsJob = null
  pendingHtmlPlay = null
  notifyAudioNeedsTap(false)

  const objectUrl = URL.createObjectURL(job.blob)
  currentObjectUrl = objectUrl
  const audio = getTtsAudioElement()
  audio.muted = false
  audio.volume = 1
  audio.loop = false
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
    job.callbacks?.onEnd?.()
    job.resolvePlay?.()
  }
  audio.onerror = () => {
    disconnectTtsAudio()
    cleanup()
    const err = new Error('ElevenLabs audio playback failed')
    job.callbacks?.onError?.(err)
    job.callbacks?.onEnd?.()
    job.resolvePlay?.()
  }

  // Keep unlock loop warm for later lines.
  const unlockEl = getUnlockAudioElement()
  unlockEl.muted = false
  unlockEl.volume = 0.01
  unlockEl.loop = true
  if (unlockEl.paused) {
    unlockEl.src = SILENT_WAV
    void unlockEl.play().catch(() => {})
  }

  startSpeechLipSync()
  // Synchronous play() inside user gesture — required on iPhone.
  const playPromise = audio.play()
  appleGestureUnlocked = true
  mobileAudioPrimed = true
  job.callbacks?.onStart?.()

  void playPromise.catch((error) => {
    console.warn('[Audio] Gesture play failed:', error)
    cleanup()
    deferredTtsJob = job
    notifyAudioNeedsTap(true)
  })

  return true
}

export function hasQueuedTtsForGesture() {
  return Boolean(deferredTtsJob?.blob || pendingHtmlPlay?.blob || deferredBrowserTts?.text)
}

let silentGestureArm = null

function clearSilentGestureArm() {
  if (!silentGestureArm) return
  const arm = silentGestureArm
  silentGestureArm = null
  if (arm.hintTimer) {
    clearTimeout(arm.hintTimer)
    arm.hintTimer = null
  }
  if (arm.listener) {
    arm.events.forEach((type) => {
      window.removeEventListener(type, arm.listener, true)
    })
  }
}

/**
 * Queue Safari TTS for the next real touch — show branded Meet Myra gate immediately.
 */
function armSilentGestureBrowserTts(job) {
  clearSilentGestureArm()

  deferredBrowserTts = job
  notifyAudioNeedsTap(true)

  const events = ['pointerdown', 'touchstart', 'click']
  const onGesture = (event) => {
    // Let the Meet Myra button handle its own pointerdown; still unlock on any other touch.
    if (event?.target?.closest?.('.axerai-audio-tap')) return
    if (!deferredBrowserTts || deferredBrowserTts !== job) return
    clearSilentGestureArm()
    playQueuedBrowserTtsFromGesture()
  }

  silentGestureArm = { listener: onGesture, events, hintTimer: null }
  events.forEach((type) => {
    window.addEventListener(type, onGesture, { capture: true, passive: true })
  })
  console.info('[Audio] Meet Myra gate — waiting for begin tap')
}

/** Queue Safari speechSynthesis until Meet Myra begin tap. */
export function queueBrowserTtsForUserGesture(
  text,
  { onStart, onEnd, onError, voice = null, lang = 'hi-IN', rate = 1.06, pitch = 1, showTapHint = true } = {},
) {
  const trimmed = String(text ?? '').trim()
  return new Promise((resolve) => {
    if (!trimmed) {
      onEnd?.()
      resolve()
      return
    }
    if (deferredBrowserTts) {
      deferredBrowserTts.callbacks?.onEnd?.()
      deferredBrowserTts.resolvePlay?.()
    }
    clearSilentGestureArm()
    const job = {
      text: trimmed,
      voice,
      lang,
      rate,
      pitch,
      callbacks: { onStart, onEnd, onError },
      resolvePlay: resolve,
    }
    if (showTapHint) {
      deferredBrowserTts = job
      notifyAudioNeedsTap(true)
      console.info('[Audio] Meet Myra gate (browser TTS)')
      return
    }
    armSilentGestureBrowserTts(job)
  })
}

/**
 * Safari TTS: after unlock, speak directly. First iPhone unlock → Meet Myra gate (branded).
 */
export function speakBrowserTtsAuto(
  text,
  { onStart, onEnd, onError, voice = null, lang = 'hi-IN', rate = 1.06, pitch = 1 } = {},
) {
  const trimmed = String(text ?? '').trim()
  return new Promise((resolve) => {
    if (!trimmed) {
      onEnd?.()
      resolve()
      return
    }

    const speakDirect = () => {
      const synth = window.speechSynthesis
      if (!synth) {
        onEnd?.()
        resolve()
        return
      }
      try {
        synth.resume?.()
      } catch {
        // ignore
      }
      const utterance = new SpeechSynthesisUtterance(trimmed)
      if (voice) {
        utterance.voice = voice
        utterance.lang = voice.lang || lang
      } else {
        utterance.lang = lang
      }
      utterance.rate = rate
      utterance.pitch = pitch
      utterance.onstart = () => {
        appleGestureUnlocked = true
        startSpeechLipSync()
        onStart?.()
      }
      utterance.onend = () => {
        onEnd?.()
        resolve()
      }
      utterance.onerror = () => {
        onEnd?.()
        resolve()
      }
      synth.speak(utterance)
    }

    // Already unlocked this session — delayed speak usually works.
    if (appleGestureUnlocked || !isAppleMobileBrowser()) {
      speakDirect()
      return
    }

    // First iPhone voice = intentional Meet Myra moment (not a tech error label).
    armSilentGestureBrowserTts({
      text: trimmed,
      voice,
      lang,
      rate,
      pitch,
      callbacks: { onStart, onEnd, onError },
      resolvePlay: resolve,
    })
  })
}

function queueTtsBlobForUserGesture(blob, callbacks) {
  return new Promise((resolve) => {
    clearDeferredTtsJob('cancel')
    deferredTtsJob = {
      blob,
      callbacks,
      resolvePlay: resolve,
    }
    notifyAudioNeedsTap(true)
    console.info('[Audio] Meet Myra gate (ElevenLabs)')
  })
}

/** Refresh iOS/Safari audio unlock. speechPing is Apple-only (Android makes tung-tung beeps). */
export function unlockMobileSpeechAudio({ force = false, speechPing = false } = {}) {
  // Kick AudioContext resume synchronously inside the gesture when possible.
  const ctx = getSharedAudioContext()
  void ctx?.resume?.()

  // Prefer sync gesture play for queued TTS (do not await unlock first).
  if (hasQueuedTtsForGesture()) {
    playQueuedTtsFromUserGesture()
    return
  }

  // Must stay sync inside the gesture — async .then() loses Safari permission.
  if (speechPing) {
    primeSafariSpeechSynthesis()
  }

  void ensureMobileAudioUnlocked({ force }).then(() => {
    notifyAudioNeedsTap(
      Boolean(pendingHtmlPlay || deferredTtsJob || deferredBrowserTts?.text),
    )
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
  pendingHtmlPlay = null
  clearSilentGestureArm()
  if (deferredBrowserTts) {
    const job = deferredBrowserTts
    deferredBrowserTts = null
    notifyAudioNeedsTap(false)
    job.callbacks?.onEnd?.()
    job.resolvePlay?.()
  }
  if (deferredTtsJob) {
    const job = deferredTtsJob
    deferredTtsJob = null
    notifyAudioNeedsTap(false)
    job.callbacks?.onEnd?.()
    job.resolvePlay?.()
  }
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
  // Production proxy uses server ELEVENLABS_VOICE_ID — client VITE_ id is often empty.
  // Must still return a placeholder or speakWithElevenLabs aborts before any fetch.
  if (USE_API_PROXY) return [ELEVENLABS_VOICE_ID || 'server']

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

async function waitForAudioReady(audio, timeoutMs = 4000) {
  if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return
  await Promise.race([
    new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('Audio load failed'))
      }
      const cleanup = () => {
        audio.removeEventListener('canplaythrough', onReady)
        audio.removeEventListener('loadeddata', onReady)
        audio.removeEventListener('error', onError)
      }
      audio.addEventListener('canplaythrough', onReady, { once: true })
      audio.addEventListener('loadeddata', onReady, { once: true })
      audio.addEventListener('error', onError, { once: true })
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

/** Fallback only — Web Audio is muted by iPhone hardware Silent switch. */
async function playBlobViaWebAudio(blob, { onStart, onEnd, onError }) {
  const ctx = getSharedAudioContext()
  if (!ctx) throw new Error('Web Audio unavailable')

  if (ctx.state === 'suspended') {
    await withTimeout(ctx.resume(), 800)
  }
  startSilentKeepAlive(ctx)

  const arrayBuffer = await blob.arrayBuffer()
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
  audio.loop = false
  audio.src = objectUrl
  audio._objectUrl = objectUrl
  currentAudio = audio
  try {
    audio.load()
  } catch {
    // ignore
  }

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

  await waitForAudioReady(audio)
  // Do not route iPhone TTS through Web Audio graph — Silent switch + session steal.
  if (!isAppleMobileBrowser()) {
    connectTtsAudio(audio)
  } else {
    startSpeechLipSync()
  }

  try {
    await audio.play()
    notifyAudioNeedsTap(false)
    onStart?.()
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (isAppleMobileBrowser() && (name === 'NotAllowedError' || name === 'AbortError')) {
      // Resolve after the user taps again (unlockMobileSpeechAudio flushes this).
      pendingHtmlPlay = {
        blob,
        callbacks: { onStart, onEnd, onError },
      }
      notifyAudioNeedsTap(true)
      console.warn('[Audio] iOS blocked TTS — Meet Myra gate')
      return
    }
    cleanup()
    throw error
  }
}

async function playBlob(blob, { onStart, onEnd, onError }) {
  if (!blob?.size) {
    throw new Error('ElevenLabs returned empty audio')
  }

  // Keep session warm — never rewrite TTS src with silent unlock WAV.
  void ensureMobileAudioUnlocked({ force: false })

  try {
    // iPhone: HTMLAudioElement first (works with Silent switch better than Web Audio).
    await playBlobViaHtmlAudio(blob, { onStart, onEnd, onError })
  } catch (htmlError) {
    console.warn('[Audio] HTML TTS failed, trying Web Audio:', htmlError)
    try {
      await playBlobViaWebAudio(blob, { onStart, onEnd, onError })
    } catch (error) {
      const name = error instanceof Error ? error.name : 'PlaybackError'
      throw new Error(
        `iPhone audio block (${name}) — volume up karo, screen tap karke dubara try karo`,
      )
    }
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

export async function speakWithElevenLabs(
  text,
  { onStart, onEnd, onError, requireUserGesture = false } = {},
) {
  if (!isElevenLabsConfigured()) {
    throw new Error('ElevenLabs is not configured')
  }

  const trimmed = String(text).trim()
  if (!trimmed) {
    onEnd?.()
    return
  }

  // Don't wipe a queued tap-to-play from a prior line unless starting fresh audio fetch.
  pendingHtmlPlay = null
  if (deferredTtsJob) {
    const job = deferredTtsJob
    deferredTtsJob = null
    notifyAudioNeedsTap(false)
    job.resolvePlay?.()
  }
  if (currentAbort) {
    currentAbort.abort()
    currentAbort = null
  }
  stopBufferSource()
  if (currentAudio) {
    currentAudio.pause()
    if (currentAudio._objectUrl) {
      URL.revokeObjectURL(currentAudio._objectUrl)
      currentAudio._objectUrl = null
    }
    currentAudio = null
  }

  const controller = new AbortController()
  currentAbort = controller

  const voiceIds = await fetchVoiceCandidates()
  if (!voiceIds.length) {
    throw new Error('No ElevenLabs voice available')
  }

  // iPhone first voice: Meet Myra gate until one gesture play succeeds.
  const needsGesture =
    requireUserGesture || (isAppleMobileBrowser() && !appleGestureUnlocked)

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
      const blob = await response.blob()
      if (controller.signal.aborted) return
      if (!blob?.size) {
        lastError = 'ElevenLabs returned empty audio'
        continue
      }

      console.log(
        `[ElevenLabs] ${needsGesture ? 'Queued for tap' : 'Playing'}: ${voiceName} (${voiceId})`,
      )

      if (needsGesture) {
        await queueTtsBlobForUserGesture(blob, { onStart, onEnd, onError })
        return
      }

      await playBlob(blob, { onStart, onEnd, onError })
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
