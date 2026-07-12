import React, { useRef, useEffect, useState, useCallback } from 'react'
import { AmbientLight, DirectionalLight, Clock } from 'three'
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js'
import Tesseract from 'tesseract.js'
import {
  askGeminiViaProxy,
  USE_API_PROXY,
} from './apiProxy.js'
import {
  MYRA_SYSTEM_PROMPT,
  appendMyraHistory,
  buildMyraUserPrompt,
  myraResponseHasSystemSleep,
  clearMyraSession,
  fetchLiveContext,
  markBootComplete,
  prepareMyraSpeechText,
  registerProductScan,
} from './myraPrompt.js'
import {
  isElevenLabsConfigured,
  speakWithElevenLabs,
  primeMobileAudio,
  stopElevenLabsSpeech,
} from './elevenLabsTts.js'
import { MyraModel, preloadMyraModels, tickMyraMixer, MYRA_MODEL_PATH } from './myraModel.js'
import { mountTargetAnchorVideo, preloadTargetVideo } from './myraTargetVideo.js'
import { startSpeechLipSync, stopSpeechLipSync } from './myraLipSync.js'
import {
  appendLedgerMessage,
  buildGeminiMemoryText,
  finishLedgerScan,
  getSessionRole,
  getLedgerWelcomeMode,
  getLedgerSessionInfo,
  isLedgerConfigured,
  prefetchLedgerMemory,
  probeLedgerHealth,
  startLedgerScan,
} from './myraLedger.js'

const GEMINI_API_KEY = String(import.meta.env.VITE_GEMINI_API_KEY ?? '').trim()
let geminiClient = null

async function getGeminiClient() {
  if (USE_API_PROXY || !GEMINI_API_KEY) return null
  if (!geminiClient) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    geminiClient = new GoogleGenerativeAI(GEMINI_API_KEY)
  }
  return geminiClient
}

function isGeminiConfigured() {
  return USE_API_PROXY || Boolean(GEMINI_API_KEY)
}

function logAxeraiBuildConfig() {
  const geminiOk = isGeminiConfigured()
  const elevenOk = isElevenLabsConfigured()
  const ledgerOk = isLedgerConfigured()
  console.info(
    `[Axerai] Runtime — Gemini: ${geminiOk ? (USE_API_PROXY ? 'proxy' : 'local key') : 'MISSING'}, ElevenLabs: ${elevenOk ? (USE_API_PROXY ? 'proxy' : 'local key') : 'browser TTS'}, Supabase: ${ledgerOk ? 'yes' : 'MISSING'}, host: ${window.location.hostname}`,
  )
  if (ledgerOk) {
    void probeLedgerHealth()
  } else {
    console.warn('[Axerai] Ledger OFF — add VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY to .env and restart npm run dev.')
  }
  if (import.meta.env.PROD && USE_API_PROXY) {
    console.info('[Axerai] API keys are server-side via Netlify Functions — not exposed in browser bundle.')
  }
  if (!USE_API_PROXY && !geminiOk) {
    console.warn('[Axerai] Local dev — add VITE_GEMINI_API_KEY to .env or run netlify dev with GEMINI_API_KEY.')
  }
}
const GEMINI_VISION_ENABLED = false
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite']
const GEMINI_RETRIES_PER_MODEL = 1
const MINDAR_TARGET = '/targets.mind'
const INTRO_VIDEO_PATH = '/videos/intro.mp4'
const INTRO_LOADING_BG = '/images/richera-loading.png'
const INTRO_LOADING_MIN_MS = 3000
/** Roman Hinglish transcript — hi-IN returns Devanagari (अ आ) on most phones */
const SPEECH_RECO_LANG = 'en-IN'
/** Pause after speech ends before auto-send (live mic) */
const LIVE_MIC_SILENCE_MS = 2800
/** Mic energy must stay low this long after last heard voice */
const LIVE_MIC_VOICE_TAIL_MS = 650
const LIVE_MIC_VOICE_ENERGY = 20

function pickBackCameraId(devices) {
  const back = devices.find((device) => /back|rear|environment|wide/i.test(device.label))
  return back?.deviceId ?? ''
}

async function requestStartupPermissions() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  stream.getTracks().forEach((track) => track.stop())

  await new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve()
      return
    }
    navigator.geolocation.getCurrentPosition(() => resolve(), () => resolve(), {
      enableHighAccuracy: false,
      timeout: 12000,
      maximumAge: 300000,
    })
  })
}

async function applyTrackZoom(track, factor) {
  if (!track) return false
  try {
    const caps = track.getCapabilities?.()
    if (caps?.zoom) {
      const zoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min, factor))
      await track.applyConstraints({ advanced: [{ zoom }] })
      return true
    }
  } catch (error) {
    console.warn('[Camera] zoom failed:', error)
  }
  return false
}

async function applyTrackTorch(track, enabled) {
  if (!track) return false
  try {
    const caps = track.getCapabilities?.()
    if (caps?.torch) {
      await track.applyConstraints({ advanced: [{ torch: enabled }] })
      return true
    }
  } catch (error) {
    console.warn('[Camera] torch failed:', error)
  }
  return false
}

function pickMyraVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? []
  const preferred = [
    'Microsoft Swara Online (Natural)',
    'Microsoft Swara Online',
    'Microsoft Swara',
    'Google हिन्दी',
    'Microsoft Hemant',
    'Microsoft Zira Online (Natural)',
    'Microsoft Zira',
  ]
  for (const name of preferred) {
    const match = voices.find((voice) => voice.name.includes(name))
    if (match) return match
  }
  return (
    voices.find((voice) => voice.lang.startsWith('hi')) ||
    voices.find((voice) => voice.lang.startsWith('en-IN')) ||
    voices[0] ||
    null
  )
}

function applyMyraVoice(utterance, voiceRef) {
  const voice = voiceRef.current || pickMyraVoice()
  if (voice) {
    utterance.voice = voice
    utterance.lang = voice.lang
  } else {
    utterance.lang = 'hi-IN'
  }
}

function IntroLoadingScreen({ videoReady, onReady, handoff }) {
  const [minDone, setMinDone] = useState(false)
  const [progress, setProgress] = useState(0)
  const readyFiredRef = useRef(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setMinDone(true), INTRO_LOADING_MIN_MS)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    const startedAt = performance.now()

    const animateProgress = () => {
      if (cancelled) return
      const elapsed = performance.now() - startedAt
      const timePct = Math.min(92, (elapsed / INTRO_LOADING_MIN_MS) * 92)
      if (minDone && videoReady) {
        setProgress(100)
        return
      }
      if (videoReady) {
        setProgress(Math.max(timePct, 95))
      } else {
        setProgress(timePct)
      }
      requestAnimationFrame(animateProgress)
    }

    requestAnimationFrame(animateProgress)
    return () => {
      cancelled = true
    }
  }, [videoReady, minDone])

  useEffect(() => {
    if (!minDone || !videoReady || readyFiredRef.current) return undefined
    readyFiredRef.current = true
    const timer = window.setTimeout(() => onReady?.(), 420)
    return () => window.clearTimeout(timer)
  }, [minDone, videoReady, onReady])

  return (
    <div
      className={`intro-loading${handoff ? ' intro-loading--handoff' : ''}${progress >= 100 ? ' intro-loading--complete' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Loading Richera experience"
    >
      <div className="intro-loading__stage">
        <img src={INTRO_LOADING_BG} alt="" className="intro-loading__bg" aria-hidden />
        <div className="intro-loading__shade" aria-hidden />
        <div className="intro-loading__content">
          <h1 className="intro-loading__brand">Richera</h1>
          <p className="intro-loading__credit">powered by axerai</p>
          <div className="intro-loading__bar" aria-hidden>
            <div className="intro-loading__bar-track">
              <div className="intro-loading__bar-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function IntroOverlay({
  onExitStart,
  onExitComplete,
  visible = false,
  active = false,
  handoffIn = false,
  onVideoReady,
}) {
  const videoRef = useRef(null)
  const exitingRef = useRef(false)
  const readyNotifiedRef = useRef(false)
  const [exiting, setExiting] = useState(false)
  const [exitFrameSrc, setExitFrameSrc] = useState(null)

  const captureVideoFrame = useCallback(() => {
    const video = videoRef.current
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return false

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return false

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      setExitFrameSrc(canvas.toDataURL('image/jpeg', 0.92))
      return true
    } catch {
      return false
    }
  }, [])

  const beginExit = useCallback(
    (lockLastFrame = false) => {
      if (exitingRef.current) return
      exitingRef.current = true

      const video = videoRef.current
      if (lockLastFrame && video) captureVideoFrame()
      if (video) video.pause()

      setExiting(true)
      onExitStart?.()
      window.setTimeout(() => onExitComplete?.(), 1450)
    },
    [captureVideoFrame, onExitStart, onExitComplete],
  )

  const handleVideoEnded = useCallback(() => {
    const video = videoRef.current
    if (!video) {
      beginExit(true)
      return
    }

    const finish = () => beginExit(true)

    if (Number.isFinite(video.duration) && video.duration > 0) {
      const target = Math.max(0, video.duration - 0.034)
      video.addEventListener('seeked', finish, { once: true })
      video.currentTime = target
      return
    }

    finish()
  }, [beginExit])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined

    const notifyReady = () => {
      if (readyNotifiedRef.current) return
      readyNotifiedRef.current = true
      onVideoReady?.()
    }

    video.pause()
    video.currentTime = 0
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')

    const onCanPlay = () => {
      window.clearTimeout(failTimer)
      notifyReady()
    }

    const failTimer = window.setTimeout(onCanPlay, 45000)

    if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      onCanPlay()
    } else {
      video.addEventListener('canplaythrough', onCanPlay, { once: true })
      video.addEventListener('canplay', onCanPlay, { once: true })
    }

    return () => {
      window.clearTimeout(failTimer)
      video.removeEventListener('canplaythrough', onCanPlay)
      video.removeEventListener('canplay', onCanPlay)
    }
  }, [onVideoReady])

  useEffect(() => {
    const video = videoRef.current
    if (!video || active) return undefined

    video.pause()
    video.currentTime = 0
    video.muted = true
    return undefined
  }, [active])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !active || !visible) return undefined

    let cancelled = false

    const waitForCanPlay = () =>
      new Promise((resolve) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          resolve()
          return
        }
        const onReady = () => resolve()
        video.addEventListener('canplay', onReady, { once: true })
        video.addEventListener('loadeddata', onReady, { once: true })
        window.setTimeout(resolve, 10000)
      })

    const startPlayback = async () => {
      await waitForCanPlay()
      if (cancelled) return

      video.pause()
      video.currentTime = 0
      video.playsInline = true
      video.setAttribute('playsinline', '')
      video.setAttribute('webkit-playsinline', '')
      primeMobileAudio()
      video.muted = false
      video.volume = 1

      try {
        await video.play()
        if (!cancelled && !video.paused) return
      } catch {
        // fall through to muted retry
      }

      if (cancelled) return
      video.muted = true
      try {
        await video.play()
        if (cancelled || video.paused) return
        video.muted = false
        video.volume = 1
        await video.play().catch(() => {
          video.muted = true
        })
      } catch {
        // best effort — video visible even if autoplay blocked
      }
    }

    startPlayback()

    return () => {
      cancelled = true
    }
  }, [active, visible])

  return (
    <div className={`intro-overlay${exiting ? ' intro-overlay--exit' : ''}${visible ? ' intro-overlay--active' : ' intro-overlay--preparing'}${handoffIn ? ' intro-overlay--handoff-in' : ''}`}>
      <div className="intro-overlay__grid" aria-hidden />
      <div className="intro-overlay__vignette" aria-hidden />
      <div className="intro-scan-beam" aria-hidden />
      <div className="intro-flash" aria-hidden />
      {exitFrameSrc ? (
        <img src={exitFrameSrc} alt="" className="intro-overlay__video" aria-hidden />
      ) : null}
      <video
        ref={videoRef}
        src={INTRO_VIDEO_PATH}
        className={`intro-overlay__video${exitFrameSrc ? ' intro-overlay__video--hidden' : ''}`}
        playsInline
        muted
        preload="auto"
        onEnded={handleVideoEnded}
      />
      <button
        type="button"
        onClick={() => beginExit(false)}
        disabled={exiting || !visible}
        className="intro-overlay__skip"
      >
        Skip
      </button>
    </div>
  )
}

function IntroShell({ onExitStart, onExitComplete }) {
  const [videoReady, setVideoReady] = useState(false)
  const [loadingComplete, setLoadingComplete] = useState(false)
  const [handoff, setHandoff] = useState(false)
  const [showVideo, setShowVideo] = useState(false)
  const [loadingVisible, setLoadingVisible] = useState(true)

  useEffect(() => {
    if (!loadingComplete) return undefined
    setHandoff(true)

    const revealTimer = window.setTimeout(() => {
      setShowVideo(true)
      setLoadingVisible(false)
    }, 900)

    return () => window.clearTimeout(revealTimer)
  }, [loadingComplete])

  return (
    <div className="intro-shell">
      <IntroOverlay
        visible={showVideo}
        active={showVideo}
        handoffIn={handoff}
        onVideoReady={() => setVideoReady(true)}
        onExitStart={onExitStart}
        onExitComplete={onExitComplete}
      />
      {loadingVisible ? (
        <IntroLoadingScreen
          videoReady={videoReady}
          handoff={handoff}
          onReady={() => setLoadingComplete(true)}
        />
      ) : null}
    </div>
  )
}

async function waitForVideoFrames(video, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      try {
        await video.play()
      } catch {
        // muted inline video usually still plays
      }
      return
    }
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }

  throw new Error('MindAR camera feed timed out')
}

function resolveMindARCameraFromStream(stream, fallbackFacing = 'environment') {
  const track = stream?.getVideoTracks()?.[0]
  const settings = track?.getSettings?.() ?? {}
  const deviceId = settings.deviceId || ''
  const facingMode = settings.facingMode

  let shouldFaceUser
  if (facingMode === 'user') shouldFaceUser = true
  else if (facingMode === 'environment') shouldFaceUser = false
  else shouldFaceUser = fallbackFacing === 'user' || Boolean(deviceId)

  return {
    shouldFaceUser,
    userDeviceId: shouldFaceUser ? deviceId || undefined : undefined,
    environmentDeviceId: !shouldFaceUser ? deviceId || undefined : undefined,
  }
}

async function startMindARWithPreviewStream(mindarThree, container, stream) {
  const video = document.createElement('video')
  video.setAttribute('autoplay', '')
  video.setAttribute('muted', '')
  video.setAttribute('playsinline', '')
  video.style.position = 'absolute'
  video.style.top = '0px'
  video.style.left = '0px'
  video.style.zIndex = '-2'
  container.appendChild(video)

  mindarThree.video = video
  mindarThree.stream = stream
  video.srcObject = stream

  await waitForVideoFrames(video)
  video.setAttribute('width', String(video.videoWidth))
  video.setAttribute('height', String(video.videoHeight))

  await mindarThree._startAR()
  mindarThree.resize()
}

function softTeardownMindAR(mindarThree, keepCameraAlive) {
  if (!mindarThree) return

  try {
    mindarThree.renderer?.setAnimationLoop(null)
    mindarThree.controller?.stopProcessVideo?.()
  } catch {
    // ignore partial init
  }

  if (keepCameraAlive) {
    const videoEl = mindarThree.video
    if (videoEl) {
      videoEl.srcObject = null
      videoEl.remove()
    }
    mindarThree.video = null
    return
  }

  try {
    mindarThree.stop()
  } catch {
    // ignore
  }
}

function MindARSession({ previewStream, cameraProfile, onReleasePreview, onError, onSessionReady, onTargetVideoEnded, showMyra, isTalking }) {
  const containerRef = useRef(null)
  const [anchorGroup, setAnchorGroup] = useState(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let active = true
    let mindarThree = null
    let started = false
    let disposeTargetVideo = null
    let keepCameraAlive = Boolean(previewStream?.active)
    const sessionGen = { id: 0 }
    sessionGen.id = Math.random()

    async function startMindAR() {
      const mySession = sessionGen.id
      try {
        console.log('[MindAR] boot — reusing scan camera stream')

        mindarThree = new MindARThree({
          container,
          imageTargetSrc: MINDAR_TARGET,
          uiLoading: 'no',
          uiScanning: 'no',
          uiError: 'no',
          userDeviceId: cameraProfile?.userDeviceId,
          environmentDeviceId: cameraProfile?.environmentDeviceId,
        })
        if (cameraProfile) {
          mindarThree.shouldFaceUser = cameraProfile.shouldFaceUser
        }

        const { renderer, scene, camera } = mindarThree
        const anchor = mindarThree.addAnchor(0)

        disposeTargetVideo = mountTargetAnchorVideo({
          anchor,
          anchorGroup: anchor.group,
          onEnded: () => {
            if (!active || sessionGen.id !== mySession) return
            disposeTargetVideo?.()
            disposeTargetVideo = null
            onTargetVideoEnded?.()
          },
        })

        if (!active) return
        setAnchorGroup(anchor.group)

        scene.add(new AmbientLight(0xffffff, 1.4))
        const directional = new DirectionalLight(0xffffff, 2.5)
        directional.position.set(5, 5, 5)
        scene.add(directional)
        const fill = new DirectionalLight(0xffffff, 1.2)
        fill.position.set(-4, 2, 4)
        scene.add(fill)

        if (previewStream?.active) {
          await startMindARWithPreviewStream(mindarThree, container, previewStream)
        } else {
          console.warn('[MindAR] scan stream inactive — opening camera directly')
          onReleasePreview?.()
          await mindarThree.start()
          mindarThree.resize()
          const mindarVideo = container.querySelector('video')
          if (mindarVideo) await waitForVideoFrames(mindarVideo)
          keepCameraAlive = false
        }

        if (!active || sessionGen.id !== mySession) return

        const mindarVideo = mindarThree.video || container.querySelector('video')
        if (!mindarVideo || mindarVideo.videoWidth === 0) {
          throw new Error('MindAR camera feed is not ready')
        }

        console.log(
          '[MindAR] ready',
          `${mindarVideo.videoWidth}x${mindarVideo.videoHeight}`,
          'streamActive=',
          mindarVideo.srcObject instanceof MediaStream
            ? mindarVideo.srcObject.active
            : false,
        )

        started = true
        if (sessionGen.id === mySession) {
          onSessionReady?.()
        }

        if (!active || sessionGen.id !== mySession) {
          softTeardownMindAR(mindarThree, keepCameraAlive)
          return
        }

        const clock = new Clock()

        renderer.setAnimationLoop(() => {
          const delta = clock.getDelta()
          tickMyraMixer(anchor.group, delta)
          renderer.render(scene, camera)
        })
      } catch (error) {
        if (!active || sessionGen.id !== mySession) return
        console.error('[MindAR] session failed', error)
        onError?.(
          error instanceof Error
            ? error.message
            : 'AR initialization failed',
        )
        softTeardownMindAR(mindarThree, keepCameraAlive)
      }
    }

    startMindAR()

    return () => {
      sessionGen.id = 0
      active = false
      disposeTargetVideo?.()
      disposeTargetVideo = null
      setAnchorGroup(null)
      softTeardownMindAR(mindarThree, keepCameraAlive)
      if (container) container.replaceChildren()
    }
  }, [previewStream, cameraProfile, onReleasePreview, onError, onSessionReady, onTargetVideoEnded])

  return (
    <div
      className="absolute inset-0 z-10 w-full h-full overflow-hidden"
      style={{ width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        className="mindar-host absolute inset-0 h-full w-full overflow-hidden"
      />

      {anchorGroup && showMyra ? (
        <MyraModel
          key={MYRA_MODEL_PATH}
          anchorGroup={anchorGroup}
          isTalking={isTalking}
        />
      ) : null}
    </div>
  )
}

/** Ledger + backend always use this one code for the RICHERA product. */
const VERIFICATION_CODE = 'R'
/** OCR may read only part of the card — every fragment maps to VERIFICATION_CODE. */
const RICHERA_SCAN_FRAGMENTS = ['RICHERA', 'RICH', 'RIC', 'RI', 'RA', 'CH']
const FALLBACK_WELCOME_SPEECH =
  'Arrey finally! Lagta hai crystal ne mujhe jagaa diya. Main Myra hoon... Richira se aayi hoon tumse milne. Pehle ye batao, aaj ka scene kya hai?'

function compactOcrText(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

function matchBrandFromOcr(text) {
  const compact = compactOcrText(text)
  if (!compact) return null

  for (const fragment of RICHERA_SCAN_FRAGMENTS) {
    if (compact.includes(fragment)) return VERIFICATION_CODE
  }

  return null
}

function drawVideoFrameToCanvas(video, { centerCropFactor = 1 } = {}) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const canvas = document.createElement('canvas')
  canvas.width = vw
  canvas.height = vh

  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  if (centerCropFactor > 1) {
    const cropW = vw / centerCropFactor
    const cropH = vh / centerCropFactor
    const sx = (vw - cropW) / 2
    const sy = (vh - cropH) / 2
    ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, vw, vh)
  } else {
    ctx.drawImage(video, 0, 0, vw, vh)
  }

  return canvas
}

function preprocessCanvasForOcr(sourceCanvas) {
  const scale = Math.min(2.5, 2400 / Math.max(sourceCanvas.width, 1))
  const w = Math.max(1, Math.round(sourceCanvas.width * scale))
  const h = Math.max(1, Math.round(sourceCanvas.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  if (!ctx) return sourceCanvas

  ctx.drawImage(sourceCanvas, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const data = imageData.data

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    const contrast = Math.min(255, Math.max(0, (gray - 128) * 1.6 + 128))
    const value = contrast > 145 ? 255 : contrast < 110 ? 0 : contrast
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

async function recognizeProductFromFrame(sourceCanvas) {
  const passes = [
    sourceCanvas.toDataURL('image/png'),
    preprocessCanvasForOcr(sourceCanvas).toDataURL('image/png'),
  ]

  let combinedText = ''
  for (const imageData of passes) {
    const { data } = await Tesseract.recognize(imageData, 'eng')
    combinedText += `\n${data.text}`
    const code = matchBrandFromOcr(combinedText)
    if (code) {
      console.info('[Scan] product matched:', code, combinedText.slice(0, 240))
      return { verified: true, verificationCode: code, ocrText: combinedText }
    }
  }

  console.warn('[Scan] product not found in OCR:', combinedText.slice(0, 320))
  return { verified: false, verificationCode: null, ocrText: combinedText }
}

async function persistHistoryEntry(role, text) {
  appendMyraHistory(role, text)
  if (isLedgerConfigured()) {
    await appendLedgerMessage(role, text)
  }
}

function geminiErrorText(error) {
  return String(error?.message ?? error).toLowerCase()
}

function isGeminiFatalError(error) {
  const msg = geminiErrorText(error)
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('api key') ||
    msg.includes('account_state_invalid') ||
    msg.includes('permission denied')
  )
}

function isGeminiModelUnavailable(error) {
  const msg = geminiErrorText(error)
  return msg.includes('404') || msg.includes('not found') || msg.includes('not supported')
}

function isGeminiRetryableError(error) {
  const msg = geminiErrorText(error)
  return (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('failed to parse stream') ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  )
}

function geminiRetryDelayMs(attempt) {
  return 400 * attempt
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

function compressImageForGemini(dataUrl, maxSize = 768) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
      const width = Math.max(1, Math.round(img.width * scale))
      const height = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

function App() {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const spokeForScanRef = useRef(false)
  const mindarDelayRef = useRef(null)
  const arStreamRef = useRef(null)
  const mindarReadyRef = useRef(false)
  const jarvisRecognitionRef = useRef(null)
  const jarvisActiveRef = useRef(false)
  const jarvisBusyRef = useRef(false)
  const jarvisMicCycleRef = useRef(0)
  const jarvisSpeechTimerRef = useRef(null)
  const aiSpeakingRef = useRef(false)
  const myraVoiceRef = useRef(null)
  const liveContextRef = useRef(null)
  const scanSnapshotRef = useRef(null)
  const endExperienceRef = useRef(null)
  const micStreamRef = useRef(null)
  const startupPermissionsDoneRef = useRef(false)
  const liveMicRecognitionRef = useRef(null)
  const liveMicAnalyserRef = useRef(null)
  const liveMicAudioCtxRef = useRef(null)
  const liveMicRafRef = useRef(null)
  const liveMicStreamRef = useRef(null)
  const liveMicFinalRef = useRef('')
  const liveMicDisplayRef = useRef('')
  const liveMicSilenceTimerRef = useRef(null)
  const liveMicLastSpeechAtRef = useRef(0)
  const liveMicLastVoiceAtRef = useRef(0)
  const liveMicPendingInterimRef = useRef(false)
  const composeModeRef = useRef(null)
  const sendMyraUserMessageRef = useRef(() => {})
  const startLiveMicModeRef = useRef(async () => false)

  const [introVisible, setIntroVisible] = useState(true)
  const [mainRevealed, setMainRevealed] = useState(false)
  const [devices, setDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [cameraFacing, setCameraFacing] = useState('environment')
  const [cameraError, setCameraError] = useState(null)
  const [scanToast, setScanToast] = useState(null)
  const [isVerified, setIsVerified] = useState(false)
  const [showMindAR, setShowMindAR] = useState(false)
  const [arError, setArError] = useState(null)
  const [isScanning, setIsScanning] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [isAiThinking, setIsAiThinking] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [isMyraTalking, setisMyraTalking] = useState(false)
  const [mindarReady, setMindarReady] = useState(false)
  const [targetVideoDone, setTargetVideoDone] = useState(false)
  const [arPreviewStream, setArPreviewStream] = useState(null)
  const [arCameraProfile, setArCameraProfile] = useState(null)
  const [jarvisUiReady, setJarvisUiReady] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [userImagePreview, setUserImagePreview] = useState(null)
  const [composeMode, setComposeMode] = useState(null)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [voiceLevels, setVoiceLevels] = useState(() => Array(12).fill(0.15))
  const userImageRef = useRef(null)
  const composeInputRef = useRef(null)
  const liveTranscriptScrollRef = useRef(null)
  const imageUploadRef = useRef(null)
  const pttHoldingRef = useRef(false)
  const pttTranscriptRef = useRef('')
  const pttStartInFlightRef = useRef(false)
  const pttCommittedRef = useRef(false)
  const pttEndListenerRef = useRef(null)
  const endPushToTalkRef = useRef(() => {})

  const handleIntroExitStart = useCallback(() => {
    window.setTimeout(() => setMainRevealed(true), 420)
  }, [])

  const handleIntroExitComplete = useCallback(() => {
    setIntroVisible(false)
  }, [])

  // --- GEMINI MYRA AI LOGIC ---
  const clearJarvisSpeechTimer = useCallback(() => {
    if (jarvisSpeechTimerRef.current) {
      clearTimeout(jarvisSpeechTimerRef.current)
      jarvisSpeechTimerRef.current = null
    }
  }, [])

  const stopMicStream = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((track) => track.stop())
    micStreamRef.current = null
  }, [])

  const ensureMicPermission = useCallback(async () => {
    if (startupPermissionsDoneRef.current) return true
    try {
      if (micStreamRef.current?.active) {
        micStreamRef.current.getTracks().forEach((track) => track.stop())
        micStreamRef.current = null
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      stream.getTracks().forEach((track) => track.stop())
      return true
    } catch (error) {
      console.error('[Jarvis] Microphone permission failed:', error)
      return false
    }
  }, [])

  const stopLiveMicMode = useCallback(() => {
    if (liveMicSilenceTimerRef.current) {
      clearTimeout(liveMicSilenceTimerRef.current)
      liveMicSilenceTimerRef.current = null
    }
    if (liveMicRafRef.current) {
      cancelAnimationFrame(liveMicRafRef.current)
      liveMicRafRef.current = null
    }
    liveMicAnalyserRef.current = null
    if (liveMicAudioCtxRef.current) {
      liveMicAudioCtxRef.current.close().catch(() => {})
      liveMicAudioCtxRef.current = null
    }
    liveMicStreamRef.current?.getTracks().forEach((track) => track.stop())
    liveMicStreamRef.current = null
    try {
      liveMicRecognitionRef.current?.abort()
    } catch {
      // ignore
    }
    liveMicRecognitionRef.current = null
    liveMicFinalRef.current = ''
    liveMicDisplayRef.current = ''
    liveMicLastSpeechAtRef.current = 0
    liveMicLastVoiceAtRef.current = 0
    liveMicPendingInterimRef.current = false
    setLiveTranscript('')
    setVoiceLevels(Array(12).fill(0.15))
    setIsListening(false)
  }, [])

  const stopJarvisMode = useCallback(() => {
    jarvisActiveRef.current = false
    jarvisBusyRef.current = false
    aiSpeakingRef.current = false
    pttHoldingRef.current = false
    pttTranscriptRef.current = ''
    pttCommittedRef.current = false
    if (pttEndListenerRef.current) {
      window.removeEventListener('pointerup', pttEndListenerRef.current)
      window.removeEventListener('pointercancel', pttEndListenerRef.current)
      pttEndListenerRef.current = null
    }
    jarvisMicCycleRef.current += 1
    window.speechSynthesis.cancel()
    stopElevenLabsSpeech()
    stopSpeechLipSync()
    stopMicStream()
    stopLiveMicMode()
    clearJarvisSpeechTimer()
    setIsListening(false)
    setIsAiThinking(false)
    setisMyraTalking(false)
    setJarvisUiReady(false)
    setComposeText('')
    userImageRef.current = null
    setUserImagePreview(null)
    setComposeMode(null)
    setLiveTranscript('')
    const track = streamRef.current?.getVideoTracks()[0] ?? null
    applyTrackTorch(track, false).catch(() => {})
    try {
      jarvisRecognitionRef.current?.abort()
    } catch {
      // ignore abort errors during teardown
    }
    jarvisRecognitionRef.current = null
  }, [clearJarvisSpeechTimer, stopLiveMicMode, stopMicStream])

  const speakWithBrowserTts = useCallback((fullResponse, onDone, onAudioStart) => {
    const utterance = new SpeechSynthesisUtterance(fullResponse)
    applyMyraVoice(utterance, myraVoiceRef)
    utterance.rate = 1.06
    utterance.pitch = 1

    const finish = () => {
      stopSpeechLipSync()
      aiSpeakingRef.current = false
      setisMyraTalking(false)
      setIsAiThinking(false)
      onDone?.()
    }

    utterance.onstart = () => {
      startSpeechLipSync()
      onAudioStart?.()
    }
    utterance.onend = finish
    utterance.onerror = finish
    window.speechSynthesis.speak(utterance)
  }, [])

  const speakMyraReply = useCallback(async (fullResponse, onDone) => {
    const speechText = prepareMyraSpeechText(fullResponse)
    if (!speechText) {
      onDone?.()
      return
    }

    window.speechSynthesis.cancel()
    stopElevenLabsSpeech()
    aiSpeakingRef.current = true

    const finish = () => {
      stopSpeechLipSync()
      aiSpeakingRef.current = false
      setisMyraTalking(false)
      setIsAiThinking(false)
      onDone?.()
    }

    const startTalkingAnimation = () => {
      startSpeechLipSync()
      setisMyraTalking(true)
      setIsAiThinking(false)
    }

    if (isElevenLabsConfigured()) {
      try {
        await speakWithElevenLabs(speechText, {
          onStart: startTalkingAnimation,
          onEnd: finish,
        })
        return
      } catch (error) {
        console.error('[ElevenLabs] TTS failed, using browser voice:', error)
        setIsAiThinking(false)
      }
    }

    speakWithBrowserTts(speechText, onDone, startTalkingAnimation)
  }, [speakWithBrowserTts])

  const askGemini = useCallback(async (userPrompt, _imageDataUrl = null) => {
    const imagePart =
      GEMINI_VISION_ENABLED && _imageDataUrl ? parseDataUrl(_imageDataUrl) : null

    if (USE_API_PROXY) {
      return askGeminiViaProxy({
        userPrompt,
        systemInstruction: MYRA_SYSTEM_PROMPT,
        models: GEMINI_MODELS,
        imagePart,
        generationConfig: {
          temperature: 1.15,
          topP: 0.95,
        },
      })
    }

    const parts = []
    if (imagePart) {
      parts.push({
        inlineData: {
          mimeType: imagePart.mimeType,
          data: imagePart.data,
        },
      })
    }
    parts.push({ text: userPrompt })

    const client = await getGeminiClient()
    if (!client) {
      throw new Error('Gemini not configured — add VITE_GEMINI_API_KEY for local dev')
    }

    let lastError = null

    for (let modelIndex = 0; modelIndex < GEMINI_MODELS.length; modelIndex += 1) {
      const modelName = GEMINI_MODELS[modelIndex]
      const isFallback = modelIndex > 0

      if (imagePart) {
        const kb = Math.round((imagePart.data.length * 3) / 4 / 1024)
        console.log(
          `[Gemini] ${modelName}${isFallback ? ' (fallback)' : ''} vision ON — ${imagePart.mimeType}, ~${kb}KB`,
        )
      }

      for (let attempt = 1; attempt <= GEMINI_RETRIES_PER_MODEL; attempt += 1) {
        try {
          const model = client.getGenerativeModel({
            model: modelName,
            systemInstruction: MYRA_SYSTEM_PROMPT,
            generationConfig: {
              temperature: 1.15,
              topP: 0.95,
            },
          })

          const result = await model.generateContentStream(parts)
          let fullResponse = ''
          for await (const chunk of result.stream) {
            fullResponse += chunk.text()
          }

          if (isFallback || attempt > 1) {
            console.log(`[Gemini] OK — ${modelName}${attempt > 1 ? ` (retry ${attempt})` : ''}`)
          }

          return fullResponse
        } catch (error) {
          lastError = error
          const msg = error?.message ?? String(error)
          console.warn(
            `[Gemini] ${modelName} attempt ${attempt}/${GEMINI_RETRIES_PER_MODEL} failed:`,
            msg,
          )

          if (isGeminiFatalError(error)) throw error

          if (isGeminiModelUnavailable(error)) break

          const canRetry =
            isGeminiRetryableError(error) && attempt < GEMINI_RETRIES_PER_MODEL
          if (canRetry) {
            await new Promise((resolve) => {
              window.setTimeout(resolve, geminiRetryDelayMs(attempt))
            })
            continue
          }

          break
        }
      }
    }

    throw lastError ?? new Error('Gemini request failed after retries and fallbacks')
  }, [])

  const pauseMicForGemini = useCallback(() => {
    jarvisBusyRef.current = true
    pttHoldingRef.current = false
    pttTranscriptRef.current = ''
    pttCommittedRef.current = false
    setIsListening(false)
    setIsAiThinking(true)
    if (liveMicSilenceTimerRef.current) {
      clearTimeout(liveMicSilenceTimerRef.current)
      liveMicSilenceTimerRef.current = null
    }
    liveMicPendingInterimRef.current = false
    try {
      jarvisRecognitionRef.current?.abort()
    } catch {
      // ignore
    }
    try {
      liveMicRecognitionRef.current?.abort()
    } catch {
      // ignore
    }
    liveMicRecognitionRef.current = null
  }, [])

  const resumeMicAfterGemini = useCallback(async () => {
    if (!jarvisActiveRef.current) return
    jarvisBusyRef.current = false
    setIsAiThinking(false)
    if (composeModeRef.current !== 'liveMic') {
      setIsListening(false)
      return
    }

    primeMobileAudio()
    let ok = await startLiveMicModeRef.current({ softRestart: true })
    if (!ok) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 280)
      })
      ok = await startLiveMicModeRef.current({ softRestart: false })
    }
    if (!ok) {
      console.warn('[Jarvis] Live mic could not resume after Myra reply')
      setIsListening(false)
    }
  }, [])

  const deliverMyraGeminiResponse = useCallback(
    (fullResponse, afterSpeech) => {
      const onSpeechDone = async () => {
        setJarvisUiReady(true)
        await afterSpeech?.()
      }

      if (myraResponseHasSystemSleep(fullResponse)) {
        speakMyraReply(fullResponse, () => {
          endExperienceRef.current?.()
        })
        return
      }

      speakMyraReply(fullResponse, onSpeechDone)
    },
    [speakMyraReply],
  )

  const sendMyraUserMessage = useCallback(
    async (userText, { cycleId, imageDataUrl } = {}) => {
      if (!isGeminiConfigured()) return
      const trimmed = String(userText).trim()
      const image = imageDataUrl || null
      if (!trimmed && !image) return
      if (cycleId != null && jarvisMicCycleRef.current !== cycleId) return

      window.speechSynthesis.cancel()
      stopElevenLabsSpeech()
      jarvisMicCycleRef.current += 1
      clearJarvisSpeechTimer()

      try {
        jarvisRecognitionRef.current?.abort()
      } catch {
        // ignore
      }

      if (!jarvisActiveRef.current) {
        jarvisActiveRef.current = true
        jarvisBusyRef.current = false
      }

      pauseMicForGemini()

      try {
        await persistHistoryEntry('user', trimmed || '[image shared]')

        const prompt = buildMyraUserPrompt({
          type: 'reply',
          userText:
            trimmed ||
            (GEMINI_VISION_ENABLED
              ? 'User ne ek photo bheji hai — dekh kar naturally respond karo.'
              : 'User ne ek photo bheji hai — naturally respond karo.'),
          liveContext: liveContextRef.current,
          memoryText: buildGeminiMemoryText(),
          sessionRole: getSessionRole(),
        })

        const fullResponse = await askGemini(prompt)
        const cleanResponse = prepareMyraSpeechText(fullResponse)

        await persistHistoryEntry('myra', cleanResponse)
        console.log('[Jarvis] Myra says:', cleanResponse)
        deliverMyraGeminiResponse(fullResponse, resumeMicAfterGemini)
      } catch (error) {
        console.error('[Jarvis] Gemini AI error:', error)
        resumeMicAfterGemini()
      }
    },
    [
      askGemini,
      pauseMicForGemini,
      resumeMicAfterGemini,
      deliverMyraGeminiResponse,
      clearJarvisSpeechTimer,
    ],
  )

  const handleSendCompose = useCallback(() => {
    if (isAiThinking || isMyraTalking) return
    primeMobileAudio()
    const text = composeText.trim()
    const image = userImageRef.current
    if (!text && !image) return

    sendMyraUserMessage(text || 'Dekh is photo ko — bata kya lag raha hai.', {
      imageDataUrl: image,
    })
    setComposeText('')
    userImageRef.current = null
    setUserImagePreview(null)
  }, [composeText, isAiThinking, isMyraTalking, sendMyraUserMessage])

  const handleComposeKeyDown = useCallback(
    (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        handleSendCompose()
      }
    },
    [handleSendCompose],
  )

  const handleImageUpload = useCallback(async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !file.type.startsWith('image/')) return

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const compressed = await compressImageForGemini(dataUrl)
      userImageRef.current = compressed
      setUserImagePreview(compressed)
    } catch (error) {
      console.error('[Jarvis] Image upload failed:', error)
      setScanToast({ type: 'error', message: "Couldn't load photo" })
    }
  }, [])

  const clearUserImage = useCallback(() => {
    userImageRef.current = null
    setUserImagePreview(null)
  }, [])

  const prepareJarvisMode = useCallback(async () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      console.error('[Jarvis] Speech Recognition is not supported in this browser')
      return false
    }
    if (!isGeminiConfigured()) {
      console.error(
        import.meta.env.PROD
          ? '[Jarvis] Gemini proxy unavailable — Netlify me GEMINI_API_KEY set karke redeploy karo'
          : '[Jarvis] Gemini missing — add VITE_GEMINI_API_KEY to .env for local dev',
      )
      return false
    }

    const micReady = await ensureMicPermission()
    if (!micReady) {
      console.error('[Jarvis] Allow microphone access in the browser to talk to Myra')
      return false
    }

    jarvisActiveRef.current = true
    jarvisBusyRef.current = false
    return true
  }, [ensureMicPermission])

  const clearLiveMicSilenceTimer = useCallback(() => {
    if (liveMicSilenceTimerRef.current) {
      clearTimeout(liveMicSilenceTimerRef.current)
      liveMicSilenceTimerRef.current = null
    }
  }, [])

  const isLiveMicVoiceActive = useCallback(() => {
    const node = liveMicAnalyserRef.current
    if (!node) return false
    const bins = new Uint8Array(node.frequencyBinCount)
    node.getByteFrequencyData(bins)
    const avg = bins.reduce((sum, value) => sum + value, 0) / Math.max(1, bins.length)
    return avg > LIVE_MIC_VOICE_ENERGY
  }, [])

  const rescheduleLiveMicSend = useCallback(() => {
    clearLiveMicSilenceTimer()
    liveMicSilenceTimerRef.current = setTimeout(() => {
      liveMicSilenceTimerRef.current = null
      flushLiveMicUtteranceRef.current?.()
    }, LIVE_MIC_SILENCE_MS)
  }, [clearLiveMicSilenceTimer])

  const flushLiveMicUtteranceRef = useRef(null)

  const flushLiveMicUtterance = useCallback(() => {
    const text = liveMicDisplayRef.current.trim()
    if (!text || composeModeRef.current !== 'liveMic' || jarvisBusyRef.current) {
      clearLiveMicSilenceTimer()
      return
    }

    const now = Date.now()
    const quietFor = now - Math.max(liveMicLastVoiceAtRef.current, liveMicLastSpeechAtRef.current)

    if (liveMicPendingInterimRef.current || quietFor < LIVE_MIC_SILENCE_MS || isLiveMicVoiceActive()) {
      if (isLiveMicVoiceActive()) {
        liveMicLastVoiceAtRef.current = now
      }
      rescheduleLiveMicSend()
      return
    }

    clearLiveMicSilenceTimer()
    liveMicDisplayRef.current = ''
    liveMicFinalRef.current = ''
    liveMicPendingInterimRef.current = false
    liveMicLastSpeechAtRef.current = 0
    liveMicLastVoiceAtRef.current = 0
    setLiveTranscript('')

    sendMyraUserMessageRef.current(text)
  }, [clearLiveMicSilenceTimer, isLiveMicVoiceActive, rescheduleLiveMicSend])

  useEffect(() => {
    flushLiveMicUtteranceRef.current = flushLiveMicUtterance
  }, [flushLiveMicUtterance])

  const scheduleLiveMicSend = useCallback(() => {
    rescheduleLiveMicSend()
  }, [rescheduleLiveMicSend])

  const startLiveMicAnalyser = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      liveMicStreamRef.current = stream
      const audioCtx = new AudioContext()
      liveMicAudioCtxRef.current = audioCtx
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume().catch(() => {})
      }
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 64
      source.connect(analyser)
      liveMicAnalyserRef.current = analyser

      const tick = () => {
        const node = liveMicAnalyserRef.current
        if (!node) return
        const bins = new Uint8Array(node.frequencyBinCount)
        node.getByteFrequencyData(bins)
        const avg = bins.reduce((sum, value) => sum + value, 0) / Math.max(1, bins.length)
        const chunk = Math.max(1, Math.floor(bins.length / 12))
        const levels = Array.from({ length: 12 }, (_, index) => {
          const slice = bins.slice(index * chunk, (index + 1) * chunk)
          const sliceAvg = slice.reduce((sum, value) => sum + value, 0) / slice.length
          return Math.max(0.12, Math.min(1, sliceAvg / 90))
        })
        setVoiceLevels(levels)

        if (avg > LIVE_MIC_VOICE_ENERGY) {
          liveMicLastVoiceAtRef.current = Date.now()
          clearLiveMicSilenceTimer()
        } else if (
          liveMicDisplayRef.current.trim() &&
          composeModeRef.current === 'liveMic' &&
          !jarvisBusyRef.current &&
          !liveMicSilenceTimerRef.current
        ) {
          const quietFor = Date.now() - liveMicLastVoiceAtRef.current
          const sinceSpeech = Date.now() - liveMicLastSpeechAtRef.current
          if (
            quietFor >= LIVE_MIC_VOICE_TAIL_MS &&
            sinceSpeech >= LIVE_MIC_SILENCE_MS &&
            !liveMicPendingInterimRef.current
          ) {
            rescheduleLiveMicSend()
          }
        }

        liveMicRafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch (error) {
      console.warn('[Jarvis] Live mic analyser failed:', error)
    }
  }, [clearLiveMicSilenceTimer, rescheduleLiveMicSend])

  const startLiveMicMode = useCallback(async ({ softRestart = false } = {}) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      console.error('[Jarvis] Speech Recognition is not supported in this browser')
      return false
    }

    const micReady = await ensureMicPermission()
    if (!micReady) return false

    if (!softRestart) {
      stopLiveMicMode()
      stopMicStream()
      try {
        jarvisRecognitionRef.current?.abort()
      } catch {
        // ignore
      }
      jarvisRecognitionRef.current = null
      await startLiveMicAnalyser()
    } else {
      clearLiveMicSilenceTimer()
      liveMicDisplayRef.current = ''
      liveMicFinalRef.current = ''
      liveMicPendingInterimRef.current = false
      liveMicLastSpeechAtRef.current = 0
      liveMicLastVoiceAtRef.current = 0
      setLiveTranscript('')

      try {
        liveMicRecognitionRef.current?.abort()
      } catch {
        // ignore
      }
      liveMicRecognitionRef.current = null

      const streamAlive = liveMicStreamRef.current?.active
      const analyserAlive = Boolean(liveMicAnalyserRef.current)
      if (!streamAlive || !analyserAlive) {
        await startLiveMicAnalyser()
      } else if (liveMicAudioCtxRef.current?.state === 'suspended') {
        await liveMicAudioCtxRef.current.resume().catch(() => {})
      }
    }

    const recognition = new SpeechRecognition()
    liveMicRecognitionRef.current = recognition
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = SPEECH_RECO_LANG
    recognition.maxAlternatives = 1

    recognition.onresult = (speechEvent) => {
      let committed = ''
      let interim = ''
      let hasInterim = false

      for (let i = 0; i < speechEvent.results.length; i += 1) {
        const result = speechEvent.results[i]
        const piece = result[0]?.transcript ?? ''
        if (result.isFinal) {
          committed += piece
        } else {
          interim += piece
          hasInterim = true
        }
      }

      const display = `${committed}${interim}`.trim()
      if (!display) return

      liveMicFinalRef.current = committed.trim()
      liveMicDisplayRef.current = display
      liveMicPendingInterimRef.current = hasInterim
      liveMicLastSpeechAtRef.current = Date.now()
      if (hasInterim || isLiveMicVoiceActive()) {
        liveMicLastVoiceAtRef.current = Date.now()
      }
      setLiveTranscript(display)
      setIsListening(true)
      scheduleLiveMicSend()
    }

    recognition.onerror = (errorEvent) => {
      if (errorEvent.error === 'aborted') return
      console.warn('[Jarvis] Live mic error:', errorEvent.error)
      if (
        composeModeRef.current === 'liveMic' &&
        !jarvisBusyRef.current &&
        errorEvent.error !== 'not-allowed'
      ) {
        window.setTimeout(() => {
          if (composeModeRef.current !== 'liveMic' || jarvisBusyRef.current) return
          startLiveMicModeRef.current({ softRestart: true })
        }, 220)
      }
    }

    recognition.onend = () => {
      if (composeModeRef.current !== 'liveMic' || jarvisBusyRef.current) return
      if (liveMicDisplayRef.current.trim()) {
        scheduleLiveMicSend()
      }
      window.setTimeout(() => {
        if (composeModeRef.current !== 'liveMic' || jarvisBusyRef.current) return
        try {
          liveMicRecognitionRef.current?.start()
        } catch {
          // ignore restart race
        }
      }, 120)
    }

    try {
      recognition.start()
      setIsListening(true)
      jarvisActiveRef.current = true
      return true
    } catch (error) {
      console.error('[Jarvis] Live mic start failed:', error)
      stopLiveMicMode()
      return false
    }
  }, [
    ensureMicPermission,
    flushLiveMicUtterance,
    isLiveMicVoiceActive,
    scheduleLiveMicSend,
    startLiveMicAnalyser,
    stopLiveMicMode,
    stopMicStream,
  ])

  const toggleComposeMode = useCallback(
    (mode) => {
      primeMobileAudio()
      if (composeMode === mode) {
        if (mode === 'keyboard') {
          setComposeMode('liveMic')
          composeModeRef.current = 'liveMic'
          startLiveMicMode()
          return
        }
        setComposeMode(null)
        composeModeRef.current = null
        stopLiveMicMode()
        return
      }

      setComposeMode(mode)
      composeModeRef.current = mode
      if (mode === 'keyboard') {
        stopLiveMicMode()
        window.setTimeout(() => composeInputRef.current?.focus(), 80)
        return
      }

      if (mode === 'liveMic') {
        setComposeText('')
        startLiveMicMode()
      }
    },
    [composeMode, startLiveMicMode, stopLiveMicMode],
  )

  useEffect(() => {
    composeModeRef.current = composeMode
  }, [composeMode])

  useEffect(() => {
    sendMyraUserMessageRef.current = sendMyraUserMessage
    startLiveMicModeRef.current = startLiveMicMode
  }, [sendMyraUserMessage, startLiveMicMode])

  useEffect(() => {
    const el = liveTranscriptScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [liveTranscript])

  const commitPttTranscript = useCallback(() => {
    if (pttCommittedRef.current) return
    pttCommittedRef.current = true

    if (pttEndListenerRef.current) {
      window.removeEventListener('pointerup', pttEndListenerRef.current)
      window.removeEventListener('pointercancel', pttEndListenerRef.current)
      pttEndListenerRef.current = null
    }

    const text = pttTranscriptRef.current.trim()
    pttTranscriptRef.current = ''
    pttHoldingRef.current = false
    setIsListening(false)

    try {
      jarvisRecognitionRef.current?.abort()
    } catch {
      // ignore
    }
    jarvisRecognitionRef.current = null

    if (text) {
      console.log('[Jarvis] Push-to-talk:', text)
      sendMyraUserMessage(text)
      return
    }

    console.warn('[Jarvis] PTT: no speech detected')
    setScanToast({
      type: 'error',
      message: 'No speech detected',
    })
  }, [sendMyraUserMessage])

  const attachPttReleaseListeners = useCallback(() => {
    if (pttEndListenerRef.current) return

    const onRelease = () => {
      endPushToTalkRef.current()
    }

    pttEndListenerRef.current = onRelease
    window.addEventListener('pointerup', onRelease)
    window.addEventListener('pointercancel', onRelease)
  }, [])

  const detachPttReleaseListeners = useCallback(() => {
    if (!pttEndListenerRef.current) return
    window.removeEventListener('pointerup', pttEndListenerRef.current)
    window.removeEventListener('pointercancel', pttEndListenerRef.current)
    pttEndListenerRef.current = null
  }, [])

  const startPushToTalkRecognition = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) return false

    stopMicStream()
    pttCommittedRef.current = false

    try {
      jarvisRecognitionRef.current?.abort()
    } catch {
      // ignore
    }

    const recognition = new SpeechRecognition()
    jarvisRecognitionRef.current = recognition
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = SPEECH_RECO_LANG
    recognition.maxAlternatives = 1

    recognition.onresult = (speechEvent) => {
      let text = ''
      for (let i = 0; i < speechEvent.results.length; i += 1) {
        text += speechEvent.results[i][0]?.transcript ?? ''
      }
      const trimmed = text.trim()
      if (trimmed) {
        pttTranscriptRef.current = trimmed
        console.log('[Jarvis] PTT hearing:', trimmed)
      }
    }

    recognition.onerror = (errorEvent) => {
      console.warn('[Jarvis] PTT mic error:', errorEvent.error)
      if (errorEvent.error === 'not-allowed' || errorEvent.error === 'service-not-allowed') {
        pttHoldingRef.current = false
        commitPttTranscript()
      }
    }

    recognition.onend = () => {
      if (pttHoldingRef.current) {
        try {
          recognition.start()
        } catch (error) {
          console.warn('[Jarvis] PTT restart failed:', error)
          pttHoldingRef.current = false
          commitPttTranscript()
        }
        return
      }

      const text = pttTranscriptRef.current.trim()
      if (text) {
        commitPttTranscript()
      } else {
        pttCommittedRef.current = true
        detachPttReleaseListeners()
        pttHoldingRef.current = false
        setIsListening(false)
        jarvisRecognitionRef.current = null
      }
    }

    try {
      recognition.start()
      console.log('[Jarvis] PTT listening started')
      return true
    } catch (error) {
      console.error('[Jarvis] Push-to-talk start failed:', error)
      jarvisRecognitionRef.current = null
      return false
    }
  }, [commitPttTranscript, detachPttReleaseListeners, stopMicStream])

  const startPushToTalk = useCallback(
    async (event) => {
      if (event?.button != null && event.button !== 0) return
      event?.preventDefault()
      if (isAiThinking || isMyraTalking || pttHoldingRef.current) return
      primeMobileAudio()

      const button = event?.currentTarget
      if (button?.setPointerCapture && event.pointerId != null) {
        try {
          button.setPointerCapture(event.pointerId)
        } catch {
          // ignore
        }
      }

      pttHoldingRef.current = true
      pttTranscriptRef.current = ''
      pttCommittedRef.current = false
      setIsListening(true)
      attachPttReleaseListeners()

      if (!jarvisActiveRef.current) {
        pttStartInFlightRef.current = true
        const ready = await prepareJarvisMode()
        pttStartInFlightRef.current = false

        if (!ready || !pttHoldingRef.current) {
          pttHoldingRef.current = false
          setIsListening(false)
          detachPttReleaseListeners()
          return
        }
      }

      if (!startPushToTalkRecognition()) {
        pttHoldingRef.current = false
        setIsListening(false)
        detachPttReleaseListeners()
        setScanToast({
          type: 'error',
          message: 'Microphone unavailable — refresh and try again',
        })
      }
    },
    [
      isAiThinking,
      isMyraTalking,
      prepareJarvisMode,
      startPushToTalkRecognition,
      attachPttReleaseListeners,
      detachPttReleaseListeners,
    ],
  )

  const endPushToTalk = useCallback(
    (event) => {
      if (!pttHoldingRef.current && !pttStartInFlightRef.current) return

      const button = event?.currentTarget
      if (button?.releasePointerCapture && event?.pointerId != null) {
        try {
          button.releasePointerCapture(event.pointerId)
        } catch {
          // ignore
        }
      }

      pttHoldingRef.current = false
      setIsListening(false)
      detachPttReleaseListeners()

      if (pttStartInFlightRef.current) return

      const recognition = jarvisRecognitionRef.current
      if (!recognition) {
        if (!pttCommittedRef.current) commitPttTranscript()
        return
      }

      recognition.onend = () => {
        commitPttTranscript()
      }

      try {
        recognition.stop()
      } catch {
        commitPttTranscript()
      }
    },
    [commitPttTranscript, detachPttReleaseListeners],
  )

  useEffect(() => {
    endPushToTalkRef.current = endPushToTalk
  }, [endPushToTalk])

  const speakMyraWelcome = useCallback(async () => {
    window.speechSynthesis.cancel()
    stopElevenLabsSpeech()
    setIsAiThinking(true)

    const finishWelcome = async (text) => {
      markBootComplete()
      const cleanText = prepareMyraSpeechText(text)
      await persistHistoryEntry('myra', cleanText)
      deliverMyraGeminiResponse(text, async () => {
        const ready = await prepareJarvisMode()
        if (!ready) return
        setComposeMode('liveMic')
        composeModeRef.current = 'liveMic'
        await startLiveMicMode()
      })
    }

    if (!isGeminiConfigured()) {
      await finishWelcome(FALLBACK_WELCOME_SPEECH)
      return
    }

    try {
      registerProductScan()
      let liveContext = liveContextRef.current
      if (!liveContext?.localTime) {
        liveContext = await fetchLiveContext()
        liveContextRef.current = liveContext
      }

      const welcomeMode = getLedgerWelcomeMode()
      const isReturnScan =
        welcomeMode === 'SENDER_RETURN' || welcomeMode === 'RECEIVER_RETURN'

      const prompt = buildMyraUserPrompt({
        type: isReturnScan ? 'resume' : 'welcome',
        liveContext,
        memoryText: buildGeminiMemoryText(),
        sessionRole: getSessionRole(),
      })

      const fullResponse = await askGemini(prompt)
      const cleanResponse = prepareMyraSpeechText(fullResponse)
      console.log(`[Jarvis] Myra ${isReturnScan ? 'resume' : 'welcome'}:`, cleanResponse)
      await finishWelcome(fullResponse)
    } catch (error) {
      console.error('[Jarvis] Welcome Gemini error:', error)
      setIsAiThinking(false)
      await finishWelcome(FALLBACK_WELCOME_SPEECH)
    }
  }, [askGemini, deliverMyraGeminiResponse, prepareJarvisMode, startLiveMicMode])

  // --- END GEMINI LOGIC ---

  function releasePreviewCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    const videoStream = videoRef.current?.srcObject
    if (videoStream instanceof MediaStream) {
      videoStream.getTracks().forEach((track) => track.stop())
    }
  }

  function stopStandardVideo() {
    releasePreviewCamera()

    if (videoRef.current) {
      videoRef.current.srcObject = null
      videoRef.current.load()
    }

    setVideoReady(false)
  }

  function clearMindARDelay() {
    if (mindarDelayRef.current) {
      clearTimeout(mindarDelayRef.current)
      mindarDelayRef.current = null
    }
  }

  function scheduleMindAR() {
    clearMindARDelay()
    mindarReadyRef.current = false
    setMindarReady(false)
    const stream = streamRef.current
    arStreamRef.current = stream
    setArPreviewStream(stream)
    setArCameraProfile(resolveMindARCameraFromStream(stream, cameraFacing))
    setShowMindAR(true)
  }

  const releasePreviewForMindAR = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    releasePreviewCamera()
  }, [])

  const handleMindARReady = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setVideoReady(false)
    mindarReadyRef.current = true
    setMindarReady(true)
  }, [])

  const handleMindARError = useCallback((message) => {
    if (mindarReadyRef.current) {
      console.warn('[MindAR] ignoring stale session error:', message)
      return
    }
    setArError(message)
    setShowMindAR(false)
    setMindarReady(false)
    mindarReadyRef.current = false
    arStreamRef.current = null
    setArPreviewStream(null)
    setArCameraProfile(null)
  }, [])

  const handleTargetVideoEnded = useCallback(() => {
    setTargetVideoDone(true)
    if (spokeForScanRef.current) return
    spokeForScanRef.current = true
    speakMyraWelcome()
  }, [speakMyraWelcome])

  const endExperience = useCallback(() => {
    void finishLedgerScan()
    clearMindARDelay()
    stopStandardVideo()
    setIsVerified(false)
    setShowMindAR(false)
    setTargetVideoDone(false)
    setMindarReady(false)
    mindarReadyRef.current = false
    arStreamRef.current = null
    setArPreviewStream(null)
    setArCameraProfile(null)
    setArError(null)
    setScanToast(null)
    window.speechSynthesis.cancel()
    stopElevenLabsSpeech()
    setisMyraTalking(false)
    clearMyraSession()
    liveContextRef.current = null
    scanSnapshotRef.current = null
    setComposeText('')
    userImageRef.current = null
    setUserImagePreview(null)
    setJarvisUiReady(false)
    stopJarvisMode()
  }, [stopJarvisMode])

  useEffect(() => {
    endExperienceRef.current = endExperience
  }, [endExperience])

  async function captureFrame() {
    if (isScanning) return
    primeMobileAudio()

    if (isVerified) {
      endExperience()
      return
    }

    const video = videoRef.current
    if (!video || video.readyState < 2 || video.videoWidth === 0) return

    window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))

    const canvas = drawVideoFrameToCanvas(video, { centerCropFactor: 1 })

    setScanToast(null)
    setIsVerified(false)
    setShowMindAR(false)
    setArError(null)
    clearMindARDelay()
    spokeForScanRef.current = false
    setIsScanning(true)

    try {
      const { verified, verificationCode } = await recognizeProductFromFrame(canvas)
      if (verified && verificationCode) {
        if (isLedgerConfigured()) {
          await prefetchLedgerMemory(verificationCode)
          const ledgerScan = await startLedgerScan(verificationCode)
          if (!ledgerScan) {
            setScanToast({
              type: 'error',
              message: 'Scan OK but ledger save failed — Supabase tables check karo (F12 console).',
            })
          } else {
            console.info('[Ledger] session', getLedgerSessionInfo())
          }
        } else {
          console.warn('[Ledger] Keys missing — this scan will not be saved.')
        }

        setIsVerified(true)
        setTargetVideoDone(false)
        setArError(null)
        scheduleMindAR()
        scanSnapshotRef.current = null
      } else {
        scanSnapshotRef.current = null
        setIsVerified(false)
        setShowMindAR(false)
        setScanToast({ type: 'error', message: 'Product not detected — center the box in frame' })
      }
    } catch (err) {
      setIsVerified(false)
      setScanToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Scan failed',
      })
    } finally {
      setIsScanning(false)
    }
  }

  const attachCameraToVideo = useCallback(async () => {
    const video = videoRef.current
    const stream = streamRef.current
    if (!video || !stream) return false

    if (video.srcObject !== stream) {
      video.srcObject = stream
    }

    try {
      await video.play()
      setVideoReady(true)
      return true
    } catch {
      return false
    }
  }, [])

  const bindCameraVideo = useCallback(
    (node) => {
      videoRef.current = node
      if (node) attachCameraToVideo()
    },
    [attachCameraToVideo],
  )

  const loadDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices()
    const videoInputs = all.filter((device) => device.kind === 'videoinput')
    setDevices(videoInputs)
    return videoInputs
  }, [])

  useEffect(() => {
    if (introVisible) return undefined

    let mounted = true

    async function init() {
      try {
        await requestStartupPermissions()
        startupPermissionsDoneRef.current = true
        primeMobileAudio()

        if (!mounted) return

        const videoInputs = await loadDevices()
        const backId = pickBackCameraId(videoInputs)
        if (backId) {
          setSelectedDeviceId(backId)
        } else {
          setSelectedDeviceId('')
          setCameraFacing('environment')
        }

        try {
          const liveContext = await fetchLiveContext()
          if (mounted) liveContextRef.current = liveContext
        } catch (error) {
          console.warn('[Axerai] Live context prefetch failed:', error)
        }
      } catch (err) {
        if (!mounted) return
        setCameraError(
          err instanceof Error ? err.message : 'Could not access camera',
        )
      }
    }

    init()

    const handleDeviceChange = () => {
      loadDevices()
    }
    navigator.mediaDevices?.addEventListener('devicechange', handleDeviceChange)

    return () => {
      mounted = false
      navigator.mediaDevices?.removeEventListener(
        'devicechange',
        handleDeviceChange,
      )
    }
  }, [introVisible, loadDevices])

  useEffect(() => {
    if (introVisible || isVerified) return

    let cancelled = false

    async function startStream() {
      const activeId =
        streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId
      if (
        selectedDeviceId &&
        activeId === selectedDeviceId &&
        streamRef.current
      ) {
        await attachCameraToVideo()
        return
      }

      streamRef.current?.getTracks().forEach((track) => track.stop())

      try {
        let stream
        const videoConstraints = selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId } }
          : { facingMode: { ideal: cameraFacing } }

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: false,
          })
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: cameraFacing } },
            audio: false,
          })
        }

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream
        setCameraError(null)
        await attachCameraToVideo()
      } catch (err) {
        if (cancelled) return
        setVideoReady(false)
        setCameraError(
          err instanceof Error ? err.message : 'Could not access camera',
        )
      }
    }

    startStream()

    return () => {
      cancelled = true
    }
  }, [selectedDeviceId, cameraFacing, isVerified, introVisible, attachCameraToVideo])

  useEffect(() => {
    if (isVerified) {
      const track = streamRef.current?.getVideoTracks()[0] ?? null
      applyTrackZoom(track, 1).catch(() => {})
    }
  }, [isVerified, videoReady, selectedDeviceId, cameraFacing])

  const flipCamera = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0] ?? null
    await applyTrackTorch(track, false).catch(() => {})
    setSelectedDeviceId('')
    setCameraFacing((facing) => (facing === 'environment' ? 'user' : 'environment'))
  }, [])

  useEffect(() => {
    const turnOffTorch = () => {
      const track = streamRef.current?.getVideoTracks()[0] ?? arStreamRef.current?.getVideoTracks()[0] ?? null
      applyTrackTorch(track, false).catch(() => {})
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') turnOffTorch()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!mainRevealed) return
    attachCameraToVideo()
  }, [mainRevealed, attachCameraToVideo])

  useEffect(() => {
    preloadMyraModels()
    preloadTargetVideo()
    logAxeraiBuildConfig()
  }, [])

  useEffect(() => {
    return () => {
      clearMindARDelay()
      window.speechSynthesis.cancel()
      stopElevenLabsSpeech()
      stopJarvisMode()
      stopMicStream()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [stopJarvisMode])

  useEffect(() => {
    const syncVoice = () => {
      myraVoiceRef.current = pickMyraVoice()
    }
    syncVoice()
    window.speechSynthesis?.addEventListener('voiceschanged', syncVoice)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', syncVoice)
  }, [])

  useEffect(() => {
    if (!scanToast) return
    const timer = setTimeout(() => setScanToast(null), 3200)
    return () => clearTimeout(timer)
  }, [scanToast])

  const myraPttButton = (
    <button
      type="button"
      className={`myra-ptt-fingerprint myra-ptt-fingerprint--compact${isListening ? ' myra-ptt-fingerprint--active' : ''}`}
      aria-label={isListening ? 'Listening' : 'Hold to speak'}
      onPointerDown={startPushToTalk}
      onPointerUp={endPushToTalk}
      onPointerCancel={endPushToTalk}
      onLostPointerCapture={endPushToTalk}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="myra-ptt-fingerprint__pulse" aria-hidden />
      <span className="myra-ptt-fingerprint__ring myra-ptt-fingerprint__ring--1" aria-hidden />
      <span className="myra-ptt-fingerprint__ring myra-ptt-fingerprint__ring--2" aria-hidden />
      <span className="myra-ptt-fingerprint__ring myra-ptt-fingerprint__ring--3" aria-hidden />
      <svg className="myra-ptt-fingerprint__fp" viewBox="0 0 100 100" fill="none" aria-hidden>
        <path
          d="M50 18c-8 0-14 6-14 14 0 4 2 8 5 10-6 2-10 8-10 14 0 9 7 16 16 16"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path
          d="M62 24c6 3 10 9 10 16 0 5-2 9-5 12"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path
          d="M38 30c-5 4-8 10-8 17 0 4 1 7 3 10"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path
          d="M50 52c5 0 9 4 9 9s-4 9-9 9"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path
          d="M68 42c4 5 6 11 6 18 0 12-10 22-22 22"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path
          d="M32 48c-3 5-5 11-5 17 0 14 11 25 25 25"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
      <span className="myra-ptt-fingerprint__core" aria-hidden>
        <svg viewBox="0 0 24 24" className="myra-ptt-fingerprint__mic" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3z" />
          <path strokeLinecap="round" d="M19 11v1a7 7 0 01-14 0v-1" />
          <path strokeLinecap="round" d="M12 19v3" />
        </svg>
      </span>
    </button>
  )

  const keyboardButton = (
    <button
      type="button"
      onClick={() => toggleComposeMode('keyboard')}
      aria-label="Keyboard"
      aria-pressed={composeMode === 'keyboard'}
      className={`hud-icon-btn flex h-10 w-10 items-center justify-center rounded-full${composeMode === 'keyboard' ? ' hud-icon-btn--active' : ''}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path strokeLinecap="round" d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
      </svg>
    </button>
  )

  const cameraFlipButton = (
    <button
      type="button"
      onClick={flipCamera}
      aria-label="Flip camera"
      className="hud-icon-btn hud-camera-flip flex h-10 w-10 items-center justify-center rounded-full"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" d="M11 7H7a2 2 0 00-2 2v2M7 17h4M13 7h4a2 2 0 012 2v2M17 17h-4" />
        <path strokeLinecap="round" d="M8 4L5 7l3 3M16 20l3-3-3-3" />
      </svg>
    </button>
  )

  return (
    <>
      {introVisible ? (
        <IntroShell onExitStart={handleIntroExitStart} onExitComplete={handleIntroExitComplete} />
      ) : null}

      <div className={`axerai-app relative flex h-[100dvh] h-[100svh] w-full flex-col overflow-hidden text-white${mainRevealed ? ' main-reveal--active' : ''}${introVisible ? ' axerai-app--during-intro' : ''}`}>
        <div className="axerai-bg pointer-events-none absolute inset-0" />
        <div className="axerai-grid pointer-events-none absolute inset-0" />
        <div className="axerai-orb axerai-orb--1 pointer-events-none absolute" aria-hidden />
        <div className="axerai-orb axerai-orb--2 pointer-events-none absolute" aria-hidden />
        <div className="axerai-scanlines pointer-events-none absolute inset-0" aria-hidden />

        <div className="relative z-10 flex h-full min-h-0 w-full flex-col">
          {cameraError ? (
            <div className="axerai-stage-error rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-center text-sm text-red-200 backdrop-blur-md">
              {cameraError}
            </div>
          ) : null}

          {!cameraError && (
            <div className="axerai-stage-shell">
            <div className="main-reveal-item main-reveal-item--2 hud-viewport hud-viewport--stage relative h-full min-h-0 w-full flex-1">
              {!mindarReady && (
                <video
                  ref={bindCameraVideo}
                  autoPlay
                  playsInline
                  muted
                  onLoadedData={() => setVideoReady(true)}
                  onEmptied={() => setVideoReady(false)}
                  className={`absolute inset-0 h-full w-full bg-black object-cover transition-transform duration-200 ${isVerified ? 'z-[4]' : 'z-[1]'}`}
                />
              )}
              {isVerified && showMindAR && arPreviewStream && arCameraProfile && (
                <div
                  className={`absolute inset-0 z-[2] ${mindarReady ? 'opacity-100' : 'opacity-0'}`}
                >
                  <MindARSession
                    key={arPreviewStream.id}
                    previewStream={arPreviewStream}
                    cameraProfile={arCameraProfile}
                    onReleasePreview={releasePreviewForMindAR}
                    onError={handleMindARError}
                    onSessionReady={handleMindARReady}
                    onTargetVideoEnded={handleTargetVideoEnded}
                    showMyra={targetVideoDone}
                    isTalking={isMyraTalking}
                  />
                </div>
              )}
              {isVerified && !mindarReady && (
                <div className="pointer-events-none absolute inset-0 z-[5] flex items-end justify-center pb-6">
                  <div className="rounded-full border border-white/15 bg-black/45 px-4 py-2 text-xs text-white/75 backdrop-blur-md">
                    Starting AR…
                  </div>
                </div>
              )}

              <div className={`hud-viewport__frame pointer-events-none absolute inset-0 z-[6]${isVerified ? ' hud-viewport__frame--ar' : ''}`} aria-hidden>
                <span className="hud-corner hud-corner--tl" />
                <span className="hud-corner hud-corner--tr" />
                <span className="hud-corner hud-corner--bl" />
                <span className="hud-corner hud-corner--br" />
                <span className="hud-crosshair" />
                <span className="hud-viewport-scan" />
              </div>

              <div className="hud-side-dock absolute z-50 hud-inset-top hud-inset-right">
                {isVerified ? (
                  <button
                    type="button"
                    onClick={endExperience}
                    aria-label="Exit experience"
                    className="hud-icon-btn flex h-9 w-9 items-center justify-center rounded-full"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M7 7h10v10" />
                    </svg>
                  </button>
                ) : null}
                {cameraFlipButton}
                {isVerified && jarvisUiReady ? keyboardButton : null}
              </div>

              {isScanning && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45">
                  <div className="rounded-2xl border border-white/15 bg-black/55 px-5 py-3 text-sm font-medium text-white/90 backdrop-blur-md">
                    Verifying…
                  </div>
                </div>
              )}

              {scanToast && (
                <div className="absolute z-40 rounded-xl border border-red-400/30 bg-red-950/80 px-4 py-2 text-center text-sm text-red-100 backdrop-blur-md hud-inset-x hud-inset-top-below">
                  {scanToast.message}
                </div>
              )}

              {arError && isVerified && (
                <div className="absolute z-40 rounded-xl border border-red-400/30 bg-red-950/85 px-4 py-2 text-center text-xs text-red-200 backdrop-blur-md hud-inset-x hud-inset-top-below">
                  {arError}
                </div>
              )}

              {!isVerified && (
                <button
                  type="button"
                  onClick={captureFrame}
                  disabled={isScanning || !videoReady}
                  className="hud-viewport-scan-fab group absolute left-1/2 z-50 -translate-x-1/2 hud-inset-bottom disabled:opacity-40"
                >
                  <span className="hud-scan-btn__bg" aria-hidden />
                  <span className="hud-scan-btn__shine" aria-hidden />
                  <span className="relative flex items-center justify-center gap-2 px-6 py-3 text-sm font-bold uppercase tracking-[0.14em] text-white">
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    Scan
                  </span>
                </button>
              )}

              {isVerified && jarvisUiReady && composeMode === 'keyboard' && (
                <div className="myra-compose-wrap myra-compose-wrap--dock-clear absolute z-50 hud-inset-bottom">
                  {userImagePreview && (
                    <div className="myra-compose-preview">
                      <img src={userImagePreview} alt="" className="myra-compose-preview__img" />
                      <button
                        type="button"
                        onClick={clearUserImage}
                        className="myra-compose-preview__clear"
                        aria-label="Remove photo"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <div className="myra-compose-bar">
                    <input
                      ref={imageUploadRef}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={handleImageUpload}
                    />
                    <button
                      type="button"
                      onClick={() => imageUploadRef.current?.click()}
                      disabled={isAiThinking || isMyraTalking}
                      className="myra-compose-bar__icon-btn"
                      aria-label="Upload photo"
                    >
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="5" width="18" height="14" rx="2" />
                        <circle cx="8.5" cy="10" r="1.5" />
                        <path strokeLinecap="round" d="M21 15l-5-5L5 21" />
                      </svg>
                    </button>
                    <input
                      ref={composeInputRef}
                      type="text"
                      enterKeyHint="send"
                      value={composeText}
                      onChange={(e) => setComposeText(e.target.value)}
                      onKeyDown={handleComposeKeyDown}
                      disabled={isAiThinking || isMyraTalking}
                      placeholder="Message"
                      className="myra-compose-bar__input"
                    />
                    <button
                      type="button"
                      onClick={handleSendCompose}
                      disabled={
                        isAiThinking ||
                        isMyraTalking ||
                        (!composeText.trim() && !userImagePreview)
                      }
                      className="myra-compose-bar__send"
                      aria-label="Send message"
                    >
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                      </svg>
                    </button>
                    <div className="myra-compose-bar__mic">{myraPttButton}</div>
                  </div>
                </div>
              )}

              {isVerified && jarvisUiReady && composeMode === 'liveMic' && (
                <div className="myra-live-mic-panel myra-compose-wrap--dock-clear absolute z-50 hud-inset-bottom">
                  <div
                    ref={liveTranscriptScrollRef}
                    className="myra-live-mic-panel__transcript-wrap"
                    aria-live="polite"
                  >
                    {liveTranscript ? (
                      <p className="myra-live-mic-panel__text">{liveTranscript}</p>
                    ) : null}
                  </div>
                  <div
                    className={`myra-live-mic-capsule${isListening ? ' myra-live-mic-capsule--active' : ''}`}
                    style={{
                      '--voice-energy': (
                        voiceLevels.reduce((sum, level) => sum + level, 0) / voiceLevels.length
                      ).toFixed(2),
                    }}
                    aria-hidden
                  >
                    <span className="myra-live-mic-capsule__liquid" />
                    <span className="myra-live-mic-capsule__blob myra-live-mic-capsule__blob--1" />
                    <span className="myra-live-mic-capsule__blob myra-live-mic-capsule__blob--2" />
                  </div>
                </div>
              )}
            </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default App