import { isAppleMobileBrowser } from './mobileBrowser.js'

let audioCtx = null
let analyser = null
let sourceNode = null
let sourceElement = null
let dataArray = null
let rafId = null
let mouthLevel = 0
let speechActive = false
let syntheticPhase = 0

function ensureAudioGraph() {
  if (audioCtx) return true
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return false

  audioCtx = new Ctx()
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.45
  analyser.connect(audioCtx.destination)
  dataArray = new Uint8Array(analyser.frequencyBinCount)
  return true
}

function measureAudioLevel() {
  if (!analyser || !dataArray) return 0

  // Prefer mid speech frequencies for mouth open amount (0 silent → 1 loud).
  analyser.getByteFrequencyData(dataArray)
  const n = dataArray.length
  const start = Math.floor(n * 0.08)
  const end = Math.floor(n * 0.55)
  let sum = 0
  let count = 0
  for (let i = start; i < end; i += 1) {
    sum += dataArray[i]
    count += 1
  }
  const avg = count ? sum / count / 255 : 0
  // Map voice energy to 0..1 shape-key influence.
  return Math.min(1, Math.max(0, (avg - 0.04) * 1.55))
}

function proceduralMouthLevel() {
  syntheticPhase += 0.24
  return 0.12 + Math.abs(Math.sin(syntheticPhase)) * 0.68
}

function tickLipSync() {
  if (speechActive) {
    const audioLevel = measureAudioLevel()
    const target = audioLevel > 0.06 ? audioLevel : proceduralMouthLevel()
    mouthLevel += (target - mouthLevel) * 0.38
  } else {
    mouthLevel += (0 - mouthLevel) * 0.22
  }

  rafId = window.requestAnimationFrame(tickLipSync)
}

function startTicker() {
  if (rafId != null) return
  rafId = window.requestAnimationFrame(tickLipSync)
}

function stopTicker() {
  if (rafId == null) return
  window.cancelAnimationFrame(rafId)
  rafId = null
}

export function getMyraMouthLevel() {
  return mouthLevel
}

export function startSpeechLipSync() {
  speechActive = true
  syntheticPhase = 0
  // iOS: skip Web Audio graph — it can steal the audio session from TTS playback.
  if (!isAppleMobileBrowser()) {
    ensureAudioGraph()
    audioCtx?.resume().catch(() => {})
  }
  startTicker()
}

export function stopSpeechLipSync() {
  speechActive = false
  syntheticPhase = 0
  mouthLevel = 0
  stopTicker()
}

export function connectTtsAudio(audioEl) {
  if (!audioEl) return

  // Safari/iOS: play through <audio> only — Web Audio routing can cause echo on some devices.
  if (isAppleMobileBrowser()) {
    startSpeechLipSync()
    return
  }

  if (!ensureAudioGraph()) return

  audioCtx.resume().catch(() => {})

  if (sourceElement !== audioEl) {
    if (sourceNode) {
      try {
        sourceNode.disconnect()
      } catch {
        // ignore
      }
      sourceNode = null
    }
    sourceElement = audioEl
    try {
      sourceNode = audioCtx.createMediaElementSource(audioEl)
      sourceNode.connect(analyser)
    } catch (error) {
      console.warn('[Myra] TTS audio hook failed — using procedural lip sync', error)
    }
  }

  startSpeechLipSync()
}

export function disconnectTtsAudio() {
  stopSpeechLipSync()
}

/** @deprecated use startSpeechLipSync */
export function startSyntheticLipSync() {
  startSpeechLipSync()
}

/** @deprecated use stopSpeechLipSync */
export function stopSyntheticLipSync() {
  stopSpeechLipSync()
}
