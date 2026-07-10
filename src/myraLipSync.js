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

  analyser.getByteTimeDomainData(dataArray)
  let sum = 0
  for (let i = 0; i < dataArray.length; i += 1) {
    const v = (dataArray[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / dataArray.length)
  return Math.min(1, Math.max(0, (rms - 0.02) * 4.5))
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
  ensureAudioGraph()
  audioCtx?.resume().catch(() => {})
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
