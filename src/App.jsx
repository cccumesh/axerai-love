import React, { useRef, useEffect, useState, useCallback } from 'react'
import { AmbientLight, DirectionalLight, Clock } from 'three'
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js'
import { askGeminiViaProxy, USE_API_PROXY } from './apiProxy.js'
import {
  classifyGeminiError,
  getMyraErrorTriggerNote,
  isOfflineMyraFallback,
  MYRA_ERROR_PHASE,
  MYRA_ERROR_SITUATIONS,
  pickMyraErrorLine,
  resetMyraErrorLineMemory,
  shouldSpeakMyraError,
} from './myraErrorFallback.js'
import {
  MYRA_SYSTEM_PROMPT,
  buildMyraUserPrompt,
  myraResponseHasSystemSleep,
  clearMyraSession,
  fetchLiveContext,
  getMyraChatTurnCount,
  incrementMyraChatTurn,
  markBootComplete,
  prepareMyraLedgerText,
  prepareMyraSpeechText,
  registerProductScan,
  resetMyraChatTurns,
} from './myraPrompt.js'
import { MyraStaticSession } from './myraStaticSession.jsx'
import {
  MYRA_CHAT_LITE_CHAIN,
  myraGenerationConfig,
  resolveMyraChatModels,
} from './geminiModels.js'
import {
  ensureMobileAudioUnlocked,
  isElevenLabsConfigured,
  playQueuedTtsFromUserGesture,
  primeSafariSpeechSynthesis,
  speakBrowserTtsAuto,
  speakWithElevenLabs,
  unlockMobileSpeechAudio,
  stopElevenLabsSpeech,
} from './elevenLabsTts.js'
import { isAndroidBrowser, isAppleMobileBrowser } from './mobileBrowser.js'
import { MyraModel, tickMyraMixer, MYRA_MODEL_PATH } from './myraModel.js'
import { mountTargetAnchorVideo } from './myraTargetVideo.js'
import { loadAxeraiExperienceAssets } from './axeraiAssets.js'
import { isGeminiVerifyConfigured, VERIFY_FAIL_REASON, verifyRicheraProduct } from './myraVerify.js'
import { startSpeechLipSync, stopSpeechLipSync } from './myraLipSync.js'
import { usageFromResponse } from './geminiUsage.js'
import {
  appendLedgerMessage,
  buildGeminiMemoryText,
  finishLedgerScan,
  getSessionRole,
  getLedgerWelcomeMode,
  getLedgerSessionInfo,
  isLedgerConfigured,
  isLedgerScanActive,
  prefetchLedgerMemory,
  probeLedgerHealth,
  recordGeminiUsage,
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
  if (!geminiOk) {
    console.warn(
      '[Axerai] Gemini missing — local: VITE_GEMINI_API_KEY in .env | Netlify: GEMINI_API_KEY (Functions scope), no VITE_GEMINI on Netlify.',
    )
  }
}
const GEMINI_VISION_ENABLED = false
const GEMINI_RETRIES_PER_MODEL = 2
const MINDAR_TARGET = '/targets.mind'
const INTRO_LOADING_BG = '/images/richera-loading.png'
/** Roman Hinglish transcript — hi-IN returns Devanagari (अ आ) on most phones */
const SPEECH_RECO_LANG = 'en-IN'
/** After transcript text stops changing, auto-send (ignore background noise) */
const LIVE_MIC_SILENCE_MS = 2200
/** Visual energy only — does not gate send */
const LIVE_MIC_VOICE_ENERGY = 20
/** If target video is stuck on Safari, still start Myra welcome after verify */
/** Never block mic/keyboard UI if TTS never fires ended on mobile Safari */
const MYRA_TTS_SAFETY_MS = 35000

function pickBackCameraId(devices) {
  const back = devices.find((device) => /back|rear|environment|wide/i.test(device.label))
  return back?.deviceId ?? ''
}

async function acquireCameraStream(selectedDeviceId, cameraFacing) {
  const attempts = []

  if (selectedDeviceId) {
    attempts.push({ video: { deviceId: { exact: selectedDeviceId } }, audio: false })
  }
  attempts.push({ video: { facingMode: { ideal: cameraFacing } }, audio: false })
  if (cameraFacing === 'environment') {
    attempts.push({ video: { facingMode: { ideal: 'user' } }, audio: false })
  }
  attempts.push({ video: true, audio: false })

  let lastError = null
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error('Could not access camera')
}

const STARTUP_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/** Camera preview must never carry mic audio — Safari can sidetone/echo if audio tracks stay live. */
function stripAudioTracksFromStream(stream) {
  if (!(stream instanceof MediaStream)) return stream
  stream.getAudioTracks().forEach((track) => track.stop())
  return stream
}

/** Camera + mic in one browser prompt — stream kept alive for instant preview. */
async function acquireStartupStream() {
  const attempts = [
    {
      video: { facingMode: { ideal: 'environment' } },
      audio: STARTUP_AUDIO_CONSTRAINTS,
    },
    {
      video: { facingMode: { ideal: 'user' } },
      audio: STARTUP_AUDIO_CONSTRAINTS,
    },
    { video: true, audio: STARTUP_AUDIO_CONSTRAINTS },
  ]

  let lastError = null
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error('Could not access camera or microphone')
}

function requestGeolocationInBackground() {
  if (!navigator.geolocation) return
  navigator.geolocation.getCurrentPosition(
    () => {},
    () => {},
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
  )
}

async function permissionsLookGranted() {
  if (!navigator.permissions?.query) return false
  try {
    const [cam, mic] = await Promise.all([
      navigator.permissions.query({ name: 'camera' }),
      navigator.permissions.query({ name: 'microphone' }),
    ])
    return cam.state === 'granted' && mic.state === 'granted'
  } catch {
    return false
  }
}

async function inspectPermissionStates() {
  if (!navigator.permissions?.query) {
    return { camera: 'unknown', microphone: 'unknown' }
  }
  try {
    const [cam, mic] = await Promise.all([
      navigator.permissions.query({ name: 'camera' }),
      navigator.permissions.query({ name: 'microphone' }),
    ])
    return { camera: cam.state, microphone: mic.state }
  } catch {
    return { camera: 'unknown', microphone: 'unknown' }
  }
}

function permissionAccessHint(states, fromUserGesture) {
  if (states.camera === 'denied' || states.microphone === 'denied') {
    return 'Camera or mic blocked — allow in browser site settings (lock icon in address bar).'
  }
  if (fromUserGesture) {
    return 'Tap again and press Allow when the browser asks.'
  }
  return 'Tap anywhere to allow camera, mic & location.'
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
    if (caps?.fillLightMode?.includes?.('flash')) {
      await track.applyConstraints({
        advanced: [{ fillLightMode: enabled ? 'flash' : 'off' }],
      })
      return true
    }
  } catch (error) {
    try {
      await track.applyConstraints({ torch: enabled })
      return true
    } catch {
      console.warn('[Camera] torch failed:', error)
    }
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

function IntroLoadingScreen({
  handoff,
  startupAccess,
  startupAccessHint,
  onAssetsReady,
  onAutoRequestAccess,
  onGrantAccess,
}) {
  const [loadProgress, setLoadProgress] = useState(0)
  const assetsReadyRef = useRef(false)
  const autoRequestedRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    loadAxeraiExperienceAssets({
      onProgress: (pct) => {
        if (!cancelled) setLoadProgress(pct)
      },
    })
      .then(() => {
        if (cancelled || assetsReadyRef.current) return
        assetsReadyRef.current = true
        setLoadProgress(100)
        onAssetsReady?.()
      })
      .catch((error) => {
        console.error('[Axerai] asset preload failed', error)
        if (cancelled || assetsReadyRef.current) return
        assetsReadyRef.current = true
        setLoadProgress(100)
        onAssetsReady?.()
      })

    return () => {
      cancelled = true
    }
  }, [onAssetsReady])

  useEffect(() => {
    if (loadProgress < 80 || autoRequestedRef.current) return
    autoRequestedRef.current = true
    onAutoRequestAccess?.()
  }, [loadProgress, onAutoRequestAccess])

  const needsManualAccess =
    startupAccess === 'prompt' ||
    startupAccess === 'denied' ||
    startupAccess === 'blocked'

  return (
    <div
      className={`intro-loading${handoff ? ' intro-loading--handoff' : ''}${loadProgress >= 100 ? ' intro-loading--complete' : ''}${needsManualAccess ? ' intro-loading--access' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Loading Richera experience"
      onTouchStart={() => unlockMobileSpeechAudio({ force: true, speechPing: true })}
      onClick={() => unlockMobileSpeechAudio({ force: true, speechPing: true })}
    >
      <div className="intro-loading__stage">
        <img src={INTRO_LOADING_BG} alt="" className="intro-loading__bg" aria-hidden />
        <div className="intro-loading__shade" aria-hidden />
        <div className="intro-loading__content">
          <h1 className="intro-loading__brand">Richera</h1>
          <p className="intro-loading__credit">powered by axerai</p>
          <div className="intro-loading__bar" aria-hidden>
            <div className="intro-loading__bar-track">
              <div className="intro-loading__bar-fill" style={{ width: `${loadProgress}%` }} />
            </div>
          </div>
        </div>

        {needsManualAccess ? (
          <>
            {startupAccessHint ? (
              <p className="intro-access-hint" role="status">
                {startupAccessHint}
              </p>
            ) : null}
            <span className="intro-access-tap-ring" aria-hidden />
            <button
              type="button"
              className={`intro-access-tap${startupAccess === 'denied' || startupAccess === 'blocked' ? ' intro-access-tap--retry' : ''}`}
              aria-label="Allow camera, microphone, and location"
              disabled={startupAccess === 'granting'}
              onTouchStart={() => unlockMobileSpeechAudio({ force: true, speechPing: true })}
              onClick={onGrantAccess}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

function IntroShell({
  onExitStart,
  onExitComplete,
  readyToEnter,
  startupAccess,
  startupAccessHint,
  onAssetsReady,
  onAutoRequestAccess,
  onGrantAccess,
}) {
  const [handoff, setHandoff] = useState(false)

  useEffect(() => {
    // Choocha-style: first real gesture unlocks Safari speechSynthesis (empty speak).
    // Later touches only refresh AudioContext — repeating speak('') interrupts Myra.
    let speechPrimed = false
    const prime = () => {
      unlockMobileSpeechAudio({ force: true, speechPing: !speechPrimed })
      speechPrimed = true
    }
    document.addEventListener('touchstart', prime, { passive: true })
    document.addEventListener('click', prime, { passive: true })
    return () => {
      document.removeEventListener('touchstart', prime)
      document.removeEventListener('click', prime)
    }
  }, [])

  useEffect(() => {
    if (!readyToEnter || handoff) return
    setHandoff(true)
    onExitStart?.()
    window.setTimeout(() => onExitComplete?.(), 480)
  }, [readyToEnter, handoff, onExitStart, onExitComplete])

  return (
    <div className="intro-shell">
      <IntroLoadingScreen
        handoff={handoff}
        startupAccess={startupAccess}
        startupAccessHint={startupAccessHint}
        onAssetsReady={onAssetsReady}
        onAutoRequestAccess={onAutoRequestAccess}
        onGrantAccess={onGrantAccess}
      />
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

function MindARSession({
  previewStream,
  cameraProfile,
  onReleasePreview,
  onError,
  onSessionReady,
  onTargetVideoEnded,
  onCardTracked,
  playTargetVideo = true,
  showMyra,
  isTalking,
}) {
  const containerRef = useRef(null)
  const [anchorGroup, setAnchorGroup] = useState(null)
  const [targetVideoPlaying, setTargetVideoPlaying] = useState(false)
  const [myraSlotActive, setMyraSlotActive] = useState(false)
  const showMyraRef = useRef(showMyra)
  const playTargetVideoRef = useRef(playTargetVideo)
  const mindarVideoRef = useRef(null)

  useEffect(() => {
    showMyraRef.current = showMyra
    if (showMyra) setMyraSlotActive(true)
  }, [showMyra])
  const videoPhaseActiveRef = useRef(true)
  const cardTrackHandlerRef = useRef(onCardTracked)
  const onTargetVideoEndedRef = useRef(onTargetVideoEnded)
  const onReleasePreviewRef = useRef(onReleasePreview)
  const onErrorRef = useRef(onError)
  const onSessionReadyRef = useRef(onSessionReady)

  useEffect(() => {
    cardTrackHandlerRef.current = onCardTracked
  }, [onCardTracked])

  useEffect(() => {
    onTargetVideoEndedRef.current = onTargetVideoEnded
  }, [onTargetVideoEnded])

  useEffect(() => {
    onReleasePreviewRef.current = onReleasePreview
  }, [onReleasePreview])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    onSessionReadyRef.current = onSessionReady
  }, [onSessionReady])

  const getMindarVideo = useCallback(() => {
    const video = mindarVideoRef.current
    if (video && video.videoWidth > 0) return video
    const host = containerRef.current
    const fallback = host?.querySelector('video')
    if (fallback && fallback.videoWidth > 0) return fallback
    return null
  }, [])

  const notifyCardTracked = useCallback((phase) => {
    cardTrackHandlerRef.current?.(phase, getMindarVideo)
  }, [getMindarVideo])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let active = true
    let mindarThree = null
    let disposeTargetVideo = null
    let keepCameraAlive = Boolean(previewStream?.active)
    const sessionGen = { id: 0 }
    sessionGen.id = Math.random()
    const enableTargetVideo = playTargetVideoRef.current

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

        const attachCardTrackHandler = () => {
          const previous = anchor.onTargetFound
          anchor.onTargetFound = () => {
            previous?.()
            if (!active || sessionGen.id !== mySession) return
            const phase = videoPhaseActiveRef.current ? 'video' : 'card'
            notifyCardTracked(phase)
          }
        }

        if (enableTargetVideo) {
          videoPhaseActiveRef.current = true
          disposeTargetVideo = mountTargetAnchorVideo({
            anchor,
            anchorGroup: anchor.group,
            onCardTracked: () => {
              if (!active || sessionGen.id !== mySession) return
              setMyraSlotActive(true)
              setTargetVideoPlaying(true)
              notifyCardTracked('video')
            },
            onEnded: () => {
              if (!active || sessionGen.id !== mySession) return
              videoPhaseActiveRef.current = false
              setMyraSlotActive(true)
              setTargetVideoPlaying(false)
              // After card video, always show Myra (verify pass/fail does not matter).
              const wrapper = anchor.group?.userData?.wrapper
              if (wrapper) wrapper.visible = true
              // Keep dispose for unmount only — finish() already fades + cleans the mesh.
              disposeTargetVideo = null
              attachCardTrackHandler()
              onTargetVideoEndedRef.current?.()
            },
          })
        } else {
          videoPhaseActiveRef.current = false
          attachCardTrackHandler()
        }

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
          onReleasePreviewRef.current?.()
          await mindarThree.start()
          mindarThree.resize()
          const mindarVideo = container.querySelector('video')
          if (mindarVideo) await waitForVideoFrames(mindarVideo)
          keepCameraAlive = false
        }

        if (!active || sessionGen.id !== mySession) return

        const mindarVideo = mindarThree.video || container.querySelector('video')
        mindarVideoRef.current = mindarVideo
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

        if (sessionGen.id === mySession) {
          onSessionReadyRef.current?.()
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
        onErrorRef.current?.(
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
      setTargetVideoPlaying(false)
      setMyraSlotActive(false)
      disposeTargetVideo?.()
      disposeTargetVideo = null
      setAnchorGroup(null)
      mindarVideoRef.current = null
      softTeardownMindAR(mindarThree, keepCameraAlive)
      if (container) container.replaceChildren()
    }
    // Only remount when the camera stream/profile changes — not when chat/welcome callbacks update.
  }, [previewStream, cameraProfile, notifyCardTracked])

  return (
    <div
      className="absolute inset-0 z-10 w-full h-full overflow-hidden"
      style={{ width: '100%', height: '100%' }}
    >
      <div
        ref={containerRef}
        className="mindar-host absolute inset-0 h-full w-full overflow-hidden"
      />

      {anchorGroup && (myraSlotActive || showMyra || targetVideoPlaying) ? (
        <MyraModel
          key={MYRA_MODEL_PATH}
          anchorGroup={anchorGroup}
          isTalking={isTalking}
          revealed={!targetVideoPlaying && (showMyra || myraSlotActive)}
        />
      ) : null}
    </div>
  )
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

async function recognizeProductFromFrame(sourceCanvas) {
  const imageDataUrl = sourceCanvas.toDataURL('image/jpeg', 0.85)
  const result = await verifyRicheraProduct(imageDataUrl)

  if (result.usage) {
    void recordGeminiUsage({
      callType: 'verify',
      model: result.model,
      promptTokens: result.usage.promptTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      verificationCode: result.verificationCode ?? 'R',
    })
  }

  if (result.verified) {
    console.info('[Scan] 3-layer verify: REAL →', result.verificationCode)
  } else {
    console.warn('[Scan] 3-layer verify fail:', result.failReason)
  }
  return result
}

function verifyFailSituation(failReason) {
  if (failReason === VERIFY_FAIL_REASON.PHOTO_SPOOF) {
    return MYRA_ERROR_SITUATIONS.SCAN_PHOTO_SPOOF
  }
  if (failReason === VERIFY_FAIL_REASON.BAD_FRAME) {
    return MYRA_ERROR_SITUATIONS.SCAN_BAD_FRAME
  }
  return MYRA_ERROR_SITUATIONS.SCAN_CARD_NOT_FOUND
}

async function persistHistoryEntry(role, text) {
  if (!isLedgerConfigured()) return
  let body =
    role === 'myra' ? prepareMyraLedgerText(text) : String(text ?? '').trim()
  if (!body) return

  if (role === 'myra' && isOfflineMyraFallback(body)) {
    return
  }

  await appendLedgerMessage(role, body)
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
  return 500 * attempt
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
  const welcomeInFlightRef = useRef(false)
  const welcomeDelayTimerRef = useRef(null)
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
  const verifyGenerationRef = useRef(0)
  const verifyFailCountRef = useRef(0)
  const scanSnapInFlightRef = useRef(false)
  const isVerifiedRef = useRef(false)
  const targetVideoDoneRef = useRef(false)
  const endExperienceRef = useRef(null)
  const restartingScanRef = useRef(false)
  const micStreamRef = useRef(null)
  const startupPermissionsDoneRef = useRef(false)
  const assetsReadyRef = useRef(false)
  const autoAccessAttemptedRef = useRef(false)
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
  const torchOnRef = useRef(false)
  const viewportTapRef = useRef(0)
  const sendMyraUserMessageRef = useRef(() => {})
  const startLiveMicModeRef = useRef(async () => false)

  const [introVisible, setIntroVisible] = useState(true)
  const [mainRevealed, setMainRevealed] = useState(false)
  const [startupAccess, setStartupAccess] = useState('loading')
  const [startupAccessHint, setStartupAccessHint] = useState(null)
  const [introReadyToEnter, setIntroReadyToEnter] = useState(false)
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [cameraFacing, setCameraFacing] = useState('environment')
  const [cameraInitReady, setCameraInitReady] = useState(false)
  const [cameraError, setCameraError] = useState(null)
  const [isVerified, setIsVerified] = useState(false)
  const [showMindAR, setShowMindAR] = useState(false)
  const [arError, setArError] = useState(null)
  const [videoReady, setVideoReady] = useState(false)
  const [isAiThinking, setIsAiThinking] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [isMyraTalking, setisMyraTalking] = useState(false)
  const [mindarReady, setMindarReady] = useState(false)
  const [showScanGuide, setShowScanGuide] = useState(false)
  const [experienceViewMode, setExperienceViewMode] = useState('ar')
  const [targetVideoDone, setTargetVideoDone] = useState(false)
  const [arPreviewStream, setArPreviewStream] = useState(null)
  const [arCameraProfile, setArCameraProfile] = useState(null)
  const [jarvisUiReady, setJarvisUiReady] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [userImagePreview, setUserImagePreview] = useState(null)
  const [composeMode, setComposeMode] = useState(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [voiceLevels, setVoiceLevels] = useState(() => Array(12).fill(0.15))
  const [needsAudioTap, setNeedsAudioTap] = useState(false)
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

  const loadDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((device) => device.kind === 'videoinput')
  }, [])

  const grantStartupAccess = useCallback(async () => {
    requestGeolocationInBackground()
    // Never block camera on audio unlock — iOS/Android play() can hang.
    void ensureMobileAudioUnlocked({ force: true })
    unlockMobileSpeechAudio({ force: true, speechPing: true })

    const stream = await acquireStartupStream()
    stripAudioTracksFromStream(stream)
    streamRef.current = stream

    const videoInputs = await loadDevices()
    const backId = pickBackCameraId(videoInputs)
    if (backId) {
      setSelectedDeviceId(backId)
      setCameraFacing('environment')
    } else {
      setSelectedDeviceId('')
      setCameraFacing('user')
    }

    startupPermissionsDoneRef.current = true
    setCameraError(null)
    setCameraInitReady(true)
    return true
  }, [loadDevices])

  const beginIntroExit = useCallback(() => {
    setIntroReadyToEnter(true)
  }, [])

  const maybeEnterExperience = useCallback(() => {
    if (!assetsReadyRef.current || !startupPermissionsDoneRef.current) return
    setStartupAccess('ready')
    beginIntroExit()
  }, [beginIntroExit])

  const requestStartupPermissions = useCallback(
    async ({ fromUserGesture = false } = {}) => {
      if (startupPermissionsDoneRef.current) {
        maybeEnterExperience()
        return true
      }

      setStartupAccess('granting')
      setStartupAccessHint(null)
      try {
        await grantStartupAccess()
        setStartupAccess('ready')
        setStartupAccessHint(null)
        maybeEnterExperience()
        return true
      } catch (error) {
        const states = await inspectPermissionStates()
        const blocked = states.camera === 'denied' || states.microphone === 'denied'
        if (blocked) {
          setStartupAccess('blocked')
        } else if (fromUserGesture) {
          setStartupAccess('denied')
        } else {
          setStartupAccess('prompt')
        }
        setStartupAccessHint(permissionAccessHint(states, fromUserGesture))
        if (fromUserGesture || blocked) {
          console.warn('[Axerai] Startup permissions failed:', error)
        } else {
          console.debug('[Axerai] Auto permission needs tap — browser requires user gesture.')
        }
        return false
      }
    },
    [grantStartupAccess, maybeEnterExperience],
  )

  const handleAutoRequestAccess = useCallback(async () => {
    if (autoAccessAttemptedRef.current || startupPermissionsDoneRef.current) return
    autoAccessAttemptedRef.current = true

    if (await permissionsLookGranted()) {
      await requestStartupPermissions({ fromUserGesture: false })
      return
    }

    await requestStartupPermissions({ fromUserGesture: false })
  }, [requestStartupPermissions])

  const handleAssetsReady = useCallback(async () => {
    if (assetsReadyRef.current) return
    assetsReadyRef.current = true

    void fetchLiveContext()
      .then((ctx) => {
        liveContextRef.current = ctx
      })
      .catch((error) => {
        console.warn('[Axerai] Live context prefetch failed:', error)
      })

    if (startupPermissionsDoneRef.current) {
      maybeEnterExperience()
      return
    }

    if (!autoAccessAttemptedRef.current) {
      await handleAutoRequestAccess()
    }

    maybeEnterExperience()
  }, [handleAutoRequestAccess, maybeEnterExperience])

  const handleGrantAccess = useCallback(async () => {
    await requestStartupPermissions({ fromUserGesture: true })
  }, [requestStartupPermissions])

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

  const pauseLiveMicCapture = useCallback(() => {
    liveMicStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = false
    })
  }, [])

  const resumeLiveMicCapture = useCallback(() => {
    liveMicStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = true
    })
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
    setTorchOn(false)
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
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stopSpeechLipSync()
      aiSpeakingRef.current = false
      setisMyraTalking(false)
      setIsAiThinking(false)
      onDone?.()
    }

    let spoke = false
    const speak = () => {
      if (spoke) return
      spoke = true

      const synth = window.speechSynthesis
      if (!synth) {
        finish()
        return
      }

      try {
        synth.resume?.()
      } catch {
        // ignore
      }

      const utterance = new SpeechSynthesisUtterance(fullResponse)
      applyMyraVoice(utterance, myraVoiceRef)
      utterance.rate = 1.06
      utterance.pitch = 1
      utterance.onstart = () => {
        startSpeechLipSync()
        onAudioStart?.()
      }
      utterance.onend = finish
      utterance.onerror = finish
      synth.speak(utterance)
    }

    unlockMobileSpeechAudio({ force: true })

    const voices = window.speechSynthesis?.getVoices() ?? []
    if (voices.length === 0 && window.speechSynthesis) {
      window.speechSynthesis.addEventListener('voiceschanged', speak, { once: true })
      window.setTimeout(speak, 280)
      return
    }
    speak()
  }, [])

  const speakMyraReply = useCallback(async (fullResponse, onDone) => {
    const speechText = prepareMyraSpeechText(fullResponse)
    if (!speechText) {
      onDone?.()
      return
    }

    window.speechSynthesis.cancel()
    stopElevenLabsSpeech()
    pauseLiveMicCapture()
    // Do not await unlock here — it can steal the gesture window. Choocha speaks browser TTS directly.
    void ensureMobileAudioUnlocked({ force: true })
    aiSpeakingRef.current = true

    let speechFinished = false
    let safetyTimer = null

    const finish = () => {
      if (speechFinished) return
      speechFinished = true
      if (safetyTimer) {
        clearTimeout(safetyTimer)
        safetyTimer = null
      }
      stopSpeechLipSync()
      aiSpeakingRef.current = false
      setisMyraTalking(false)
      setIsAiThinking(false)
      onDone?.()
    }

    safetyTimer = window.setTimeout(() => {
      console.warn('[Myra] TTS safety timeout — continuing flow')
      finish()
    }, MYRA_TTS_SAFETY_MS)

    const startTalkingAnimation = () => {
      startSpeechLipSync()
      setisMyraTalking(true)
      setIsAiThinking(false)
    }

    if (isElevenLabsConfigured()) {
      try {
        // iPhone: first lines wait for Tap for sound (autoplay dies after Gemini delay).
        if (isAppleMobileBrowser()) {
          setJarvisUiReady(true)
        }
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

    // iPhone: try Safari voice immediately (Choocha). No Tap button unless auto-speak fails
    // and the user also never touches the screen for a few seconds.
    if (isAppleMobileBrowser()) {
      setJarvisUiReady(true)
      await speakBrowserTtsAuto(speechText, {
        onStart: startTalkingAnimation,
        onEnd: finish,
        voice: myraVoiceRef.current,
        lang: myraVoiceRef.current?.lang || 'hi-IN',
        rate: 1.06,
        pitch: 1,
      })
      return
    }

    speakWithBrowserTts(speechText, finish, startTalkingAnimation)
  }, [pauseLiveMicCapture, speakWithBrowserTts])

  /** Scripted error lines — Myra speaks unless situation is in MYRA_ERROR_SILENT. */
  const speakMyraErrorLine = useCallback(
    (situation, onDone) => {
      if (!shouldSpeakMyraError(situation)) {
        console.info('[Myra] offline silent:', situation, '—', getMyraErrorTriggerNote(situation))
        setIsAiThinking(false)
        onDone?.()
        return
      }
      const line = pickMyraErrorLine(situation)
      console.info('[Myra] offline:', situation, '—', getMyraErrorTriggerNote(situation))
      setIsAiThinking(true)
      speakMyraReply(line, onDone)
    },
    [speakMyraReply],
  )

function mapGeminiCallType(reason) {
  const text = String(reason ?? '').toLowerCase()
  if (text.includes('welcome') || text.includes('boot') || text.includes('resume')) {
    return 'welcome'
  }
  return 'chat'
}

  const askGemini = useCallback(async (userPrompt, options = {}) => {
    const { imageDataUrl = null, models = MYRA_CHAT_LITE_CHAIN, tier = 'lite', reason = '' } = options
    const imagePart =
      GEMINI_VISION_ENABLED && imageDataUrl ? parseDataUrl(imageDataUrl) : null

    const generationConfig = myraGenerationConfig(tier)

    console.info(
      `[Gemini] Myra chat tier=${tier} reason=${reason || 'default'} chain=${models.join(' → ')}`,
    )

    if (USE_API_PROXY) {
      const payload = await askGeminiViaProxy({
        userPrompt,
        systemInstruction: MYRA_SYSTEM_PROMPT,
        models,
        imagePart,
        generationConfig,
      })

      void recordGeminiUsage({
        callType: mapGeminiCallType(reason),
        model: payload.model,
        promptTokens: payload.usage.promptTokens,
        outputTokens: payload.usage.outputTokens,
        totalTokens: payload.usage.totalTokens,
      })

      return payload.text
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
      throw new Error('Gemini not configured — local: VITE_GEMINI_API_KEY | Netlify: GEMINI_API_KEY on server')
    }

    let lastError = null

    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const modelName = models[modelIndex]
      const isFallback = modelIndex > 0

      for (let attempt = 1; attempt <= GEMINI_RETRIES_PER_MODEL; attempt += 1) {
        try {
          const model = client.getGenerativeModel({
            model: modelName,
            systemInstruction: MYRA_SYSTEM_PROMPT,
            generationConfig,
          })

          let fullResponse = ''
          let usage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 }

          const result = await model.generateContent({ contents: [{ role: 'user', parts }] })
          fullResponse = result.response.text()
          usage = usageFromResponse(result.response)

          void recordGeminiUsage({
            callType: mapGeminiCallType(reason),
            model: modelName,
            promptTokens: usage.promptTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          })

          if (isFallback || attempt > 1) {
            console.log(`[Gemini] OK — ${modelName}${attempt > 1 ? ` (retry ${attempt})` : ''}`)
          } else {
            console.log(`[Gemini] OK — ${modelName}`)
          }

          return fullResponse
        } catch (error) {
          lastError = error
          const msg = error?.message ?? String(error)
          const retryable = isGeminiRetryableError(error)
          const canRetry = retryable && attempt < GEMINI_RETRIES_PER_MODEL

          if (canRetry) {
            console.info(
              `[Gemini] ${modelName} busy (${msg.slice(0, 80)}…) — retry ${attempt + 1}/${GEMINI_RETRIES_PER_MODEL}`,
            )
          } else if (isFallback || modelIndex < models.length - 1) {
            console.info(`[Gemini] ${modelName} unavailable — trying next model`)
          } else {
            console.warn(
              `[Gemini] ${modelName} attempt ${attempt}/${GEMINI_RETRIES_PER_MODEL} failed:`,
              msg,
            )
          }

          if (isGeminiFatalError(error)) throw error

          if (isGeminiModelUnavailable(error)) break

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
    pauseLiveMicCapture()
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
  }, [pauseLiveMicCapture])

  const resumeMicAfterGemini = useCallback(async () => {
    if (!jarvisActiveRef.current) return
    jarvisBusyRef.current = false
    setIsAiThinking(false)
    if (composeModeRef.current !== 'liveMic') {
      setIsListening(false)
      return
    }

    if (aiSpeakingRef.current) return

    resumeLiveMicCapture()
    unlockMobileSpeechAudio({ force: true })
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
  }, [resumeLiveMicCapture])

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
      if (!isGeminiConfigured()) {
        speakMyraErrorLine(MYRA_ERROR_SITUATIONS.CHAT_CONNECTION_WEAK, resumeMicAfterGemini)
        return
      }
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

        const turnCount = getMyraChatTurnCount()
        const route = resolveMyraChatModels({ userText: trimmed, userTurnCount: turnCount })

        const fullResponse = await askGemini(prompt, {
          imageDataUrl: image,
          models: route.models,
          tier: route.tier,
          reason: route.reason,
        })
        incrementMyraChatTurn()
        const cleanResponse = prepareMyraSpeechText(fullResponse)

        await persistHistoryEntry('myra', fullResponse)
        console.log('[Jarvis] Myra says:', cleanResponse)
        deliverMyraGeminiResponse(fullResponse, resumeMicAfterGemini)
      } catch (error) {
        console.error('[Jarvis] Gemini AI error:', error)
        speakMyraErrorLine(
          classifyGeminiError(error, MYRA_ERROR_PHASE.CHAT),
          resumeMicAfterGemini,
        )
      }
    },
    [
      askGemini,
      pauseMicForGemini,
      speakMyraErrorLine,
      resumeMicAfterGemini,
      deliverMyraGeminiResponse,
      clearJarvisSpeechTimer,
    ],
  )

  const handleSendCompose = useCallback(() => {
    if (isAiThinking || isMyraTalking) return
    unlockMobileSpeechAudio({ force: true })
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
      speakMyraErrorLine(MYRA_ERROR_SITUATIONS.PHOTO_FAIL)
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
        '[Jarvis] Gemini missing — local: VITE_GEMINI_API_KEY | Netlify: GEMINI_API_KEY (Functions scope).',
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
    if (
      !text ||
      composeModeRef.current !== 'liveMic' ||
      jarvisBusyRef.current ||
      aiSpeakingRef.current
    ) {
      clearLiveMicSilenceTimer()
      return
    }

    // Send when transcript text is unchanged for LIVE_MIC_SILENCE_MS.
    // Background noise must NOT delay send (voice energy is visual-only).
    const quietFor = Date.now() - liveMicLastSpeechAtRef.current
    if (quietFor < LIVE_MIC_SILENCE_MS) {
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
  }, [clearLiveMicSilenceTimer, rescheduleLiveMicSend])

  useEffect(() => {
    flushLiveMicUtteranceRef.current = flushLiveMicUtterance
  }, [flushLiveMicUtterance])

  const scheduleLiveMicSend = useCallback(() => {
    rescheduleLiveMicSend()
  }, [rescheduleLiveMicSend])

  /** Heart visual only — never hold getUserMedia on Android (steals mic from SpeechRecognition). */
  const startProceduralLiveMicLevels = useCallback(() => {
    if (liveMicRafRef.current) {
      cancelAnimationFrame(liveMicRafRef.current)
      liveMicRafRef.current = null
    }
    let phase = 0
    const tick = () => {
      if (composeModeRef.current !== 'liveMic') return
      phase += 0.18
      const base = 0.18 + (Math.sin(phase) * 0.5 + 0.5) * 0.35
      setVoiceLevels(Array.from({ length: 12 }, (_, index) => Math.min(1, base + (index % 3) * 0.04)))
      liveMicRafRef.current = requestAnimationFrame(tick)
    }
    tick()
  }, [])

  const startLiveMicAnalyser = useCallback(async () => {
    // Android Chrome: getUserMedia + webkitSpeechRecognition cannot share the mic.
    // Keyboard/PTT works because it does not keep an analyser stream open.
    if (isAndroidBrowser()) {
      startProceduralLiveMicLevels()
      return
    }

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

        // Voice energy drives the heart visual only — never resets the send timer.
        if (avg > LIVE_MIC_VOICE_ENERGY) {
          liveMicLastVoiceAtRef.current = Date.now()
        }

        liveMicRafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch (error) {
      console.warn('[Jarvis] Live mic analyser failed:', error)
      startProceduralLiveMicLevels()
    }
  }, [startProceduralLiveMicLevels])

  const startLiveMicMode = useCallback(async ({ softRestart = false } = {}) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      console.error('[Jarvis] Speech Recognition is not supported in this browser')
      return false
    }

    const micReady = await ensureMicPermission()
    if (!micReady) return false

    const android = isAndroidBrowser()

    if (!softRestart) {
      stopLiveMicMode()
      stopMicStream()
      try {
        jarvisRecognitionRef.current?.abort()
      } catch {
        // ignore
      }
      jarvisRecognitionRef.current = null
      // Android: never keep getUserMedia open for the heart — frees mic for STT.
      if (android) {
        stopMicStream()
        startProceduralLiveMicLevels()
      } else {
        await startLiveMicAnalyser()
      }
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

      if (android) {
        stopMicStream()
        startProceduralLiveMicLevels()
      } else {
        const streamAlive = liveMicStreamRef.current?.active
        const analyserAlive = Boolean(liveMicAnalyserRef.current)
        if (!streamAlive || !analyserAlive) {
          await startLiveMicAnalyser()
        } else if (liveMicAudioCtxRef.current?.state === 'suspended') {
          await liveMicAudioCtxRef.current.resume().catch(() => {})
        }
      }
    }

    const recognition = new SpeechRecognition()
    liveMicRecognitionRef.current = recognition
    // Android Chrome: continuous:true is flaky; one-shot + restart is more reliable.
    recognition.continuous = !android
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

      const previous = liveMicDisplayRef.current
      liveMicFinalRef.current = committed.trim()
      liveMicDisplayRef.current = display
      liveMicPendingInterimRef.current = hasInterim
      // Only restart the send clock when transcript text actually changes.
      if (display !== previous) {
        liveMicLastSpeechAtRef.current = Date.now()
      }
      setLiveTranscript(display)
      setIsListening(true)
      scheduleLiveMicSend()
    }

    recognition.onerror = (errorEvent) => {
      const err = errorEvent.error
      // no-speech / aborted: let onend restart quietly (do not softRestart — clears text + beeps).
      if (err === 'aborted' || err === 'no-speech') return
      if (err === 'not-allowed') {
        console.warn('[Jarvis] Live mic blocked:', err)
        return
      }
      console.warn('[Jarvis] Live mic error:', err)
      if (
        composeModeRef.current === 'liveMic' &&
        !jarvisBusyRef.current &&
        !aiSpeakingRef.current &&
        (err === 'network' || err === 'service-not-allowed' || err === 'bad-grammar')
      ) {
        window.setTimeout(() => {
          if (composeModeRef.current !== 'liveMic' || jarvisBusyRef.current || aiSpeakingRef.current) {
            return
          }
          startLiveMicModeRef.current({ softRestart: true })
        }, 600)
      }
    }

    recognition.onend = () => {
      if (
        composeModeRef.current !== 'liveMic' ||
        jarvisBusyRef.current ||
        aiSpeakingRef.current
      ) {
        return
      }
      if (liveMicDisplayRef.current.trim()) {
        scheduleLiveMicSend()
      }
      window.setTimeout(() => {
        if (
          composeModeRef.current !== 'liveMic' ||
          jarvisBusyRef.current ||
          aiSpeakingRef.current
        ) {
          return
        }
        // Same instance restart; if Android rejects it, recreate without wiping transcript.
        try {
          liveMicRecognitionRef.current?.start()
        } catch {
          if (!android) return
          try {
            const next = new SpeechRecognition()
            liveMicRecognitionRef.current = next
            next.continuous = false
            next.interimResults = true
            next.lang = SPEECH_RECO_LANG
            next.maxAlternatives = 1
            next.onresult = recognition.onresult
            next.onerror = recognition.onerror
            next.onend = recognition.onend
            next.start()
          } catch (restartError) {
            console.warn('[Jarvis] Android live mic restart failed:', restartError)
          }
        }
      }, android ? 180 : 280)
    }

    try {
      // Ensure no leftover getUserMedia holds the mic on Android before STT starts.
      if (android) {
        stopMicStream()
      }
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
    scheduleLiveMicSend,
    startLiveMicAnalyser,
    startProceduralLiveMicLevels,
    stopLiveMicMode,
    stopMicStream,
  ])

  const toggleComposeMode = useCallback(
    (mode) => {
      unlockMobileSpeechAudio({ force: true })
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
    speakMyraErrorLine(MYRA_ERROR_SITUATIONS.NO_SPEECH)
  }, [sendMyraUserMessage, speakMyraErrorLine])

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
      unlockMobileSpeechAudio({ force: true })

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
        speakMyraErrorLine(MYRA_ERROR_SITUATIONS.MIC_BLOCKED)
      }
    },
    [
      isAiThinking,
      isMyraTalking,
      prepareJarvisMode,
      speakMyraErrorLine,
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

  const clearWelcomeDelayTimer = useCallback(() => {
    if (welcomeDelayTimerRef.current) {
      clearTimeout(welcomeDelayTimerRef.current)
      welcomeDelayTimerRef.current = null
    }
  }, [])

  const speakMyraWelcome = useCallback(async () => {
    window.speechSynthesis.cancel()
    stopElevenLabsSpeech()
    unlockMobileSpeechAudio({ force: true })
    setIsAiThinking(true)

    const afterWelcomeSpeech = async () => {
      spokeForScanRef.current = true
      unlockMobileSpeechAudio({ force: true })
      const ready = await prepareJarvisMode()
      if (!ready) {
        console.warn('[Jarvis] Live mic unavailable — keyboard mode enabled')
        setComposeMode('keyboard')
        composeModeRef.current = 'keyboard'
        return
      }
      setComposeMode('liveMic')
      composeModeRef.current = 'liveMic'
      await startLiveMicMode()
    }

    const finishWelcome = async (text) => {
      markBootComplete()
      await persistHistoryEntry('myra', text)
      deliverMyraGeminiResponse(text, afterWelcomeSpeech)
    }

    const finishWelcomeError = (situation) => {
      markBootComplete()
      const line = pickMyraErrorLine(situation)
      deliverMyraGeminiResponse(line, afterWelcomeSpeech)
    }

    if (!isGeminiConfigured()) {
      finishWelcomeError(MYRA_ERROR_SITUATIONS.WELCOME_MAGIC_OFF)
      return
    }

    try {
      registerProductScan()
      // Always refresh at welcome — early prefetch often runs before GPS permission
      // and used to cache a wrong IP city (e.g. Patna while user is in Jalgaon).
      const liveContext = await fetchLiveContext()
      liveContextRef.current = liveContext

      const welcomeMode = getLedgerWelcomeMode()
      const isReturnScan =
        welcomeMode === 'SENDER_RETURN' || welcomeMode === 'RECEIVER_RETURN'

      const prompt = buildMyraUserPrompt({
        type: isReturnScan ? 'resume' : 'welcome',
        liveContext,
        memoryText: buildGeminiMemoryText(),
        sessionRole: getSessionRole(),
      })

      const welcomeRoute = resolveMyraChatModels({ forceFlash: true })

      const fullResponse = await askGemini(prompt, {
        models: welcomeRoute.models,
        tier: welcomeRoute.tier,
        reason: welcomeRoute.reason,
      })
      const cleanResponse = prepareMyraSpeechText(fullResponse)
      console.log(`[Jarvis] Myra ${isReturnScan ? 'resume' : 'welcome'}:`, cleanResponse)
      await finishWelcome(fullResponse)
    } catch (error) {
      console.error('[Jarvis] Welcome Gemini error:', error)
      setIsAiThinking(false)
      finishWelcomeError(classifyGeminiError(error, MYRA_ERROR_PHASE.WELCOME))
    }
  }, [askGemini, deliverMyraGeminiResponse, prepareJarvisMode, startLiveMicMode])

  const ensureMyraWelcome = useCallback(
    ({ delayMs = 0, reason = '' } = {}) => {
      if (spokeForScanRef.current || welcomeInFlightRef.current) return

      const run = () => {
        welcomeDelayTimerRef.current = null
        if (spokeForScanRef.current || welcomeInFlightRef.current) return
        welcomeInFlightRef.current = true
        console.info('[Jarvis] Myra welcome start:', reason || 'scan')
        void speakMyraWelcome().finally(() => {
          welcomeInFlightRef.current = false
        })
      }

      clearWelcomeDelayTimer()
      if (delayMs > 0) {
        welcomeDelayTimerRef.current = window.setTimeout(run, delayMs)
        return
      }
      run()
    },
    [clearWelcomeDelayTimer, speakMyraWelcome],
  )

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

  function stopAllCameraStreams() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    arStreamRef.current?.getTracks().forEach((track) => track.stop())
    arStreamRef.current = null
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setVideoReady(false)
    setTorchOn(false)
  }

  function clearMindARDelay() {
    if (mindarDelayRef.current) {
      clearTimeout(mindarDelayRef.current)
      mindarDelayRef.current = null
    }
  }

  function scheduleMindAR(force = false) {
    if (!force && experienceViewMode !== 'ar') return
    clearMindARDelay()
    const stream = streamRef.current
    if (!stream?.active) return

    stripAudioTracksFromStream(stream)

    mindarReadyRef.current = false
    setMindarReady(false)
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
    if (!isVerifiedRef.current) {
      setShowScanGuide(true)
    }
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
    // Always mark video done so Myra can appear even if verify failed / still running.
    setTargetVideoDone(true)
    targetVideoDoneRef.current = true
    if (!isVerifiedRef.current) return
    ensureMyraWelcome({ reason: 'target-video-ended' })
  }, [ensureMyraWelcome])

  const completeVerification = useCallback(
    async (verificationCode) => {
      if (isLedgerConfigured()) {
        const access = await prefetchLedgerMemory(verificationCode)
        if (access?.allowed === false) {
          // Card is real, but this phone is a 3rd device — reject with Myra dialogue.
          setShowScanGuide(true)
          speakMyraErrorLine(MYRA_ERROR_SITUATIONS.SCAN_PAIR_FULL)
          return
        }

        const ledgerScan = await startLedgerScan(verificationCode)
        if (ledgerScan?.rejected) {
          setShowScanGuide(true)
          speakMyraErrorLine(MYRA_ERROR_SITUATIONS.SCAN_PAIR_FULL)
          return
        }
        if (!ledgerScan) {
          speakMyraErrorLine(MYRA_ERROR_SITUATIONS.LEDGER_SAVE_FAIL)
        } else {
          console.info('[Ledger] session', getLedgerSessionInfo())
        }
      } else {
        console.warn('[Ledger] Keys missing — this scan will not be saved.')
      }

      resetMyraChatTurns()
      resetMyraErrorLineMemory()
      scanSnapshotRef.current = null

      setIsVerified(true)
      isVerifiedRef.current = true
      setShowScanGuide(false)
      setArError(null)

      // Start welcome ASAP after verify (overlap video) so Safari voice is closer to
      // the last user touch — Choocha works because speak follows scan tap quickly.
      ensureMyraWelcome({
        delayMs: targetVideoDoneRef.current ? 0 : 400,
        reason: targetVideoDoneRef.current ? 'verify-video-done' : 'verify-early',
      })
    },
    [ensureMyraWelcome, speakMyraErrorLine],
  )

  const runAnchorVerify = useCallback(
    async (phase, videoEl) => {
      if (isVerifiedRef.current) return
      if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return

      if (!isGeminiVerifyConfigured()) {
        speakMyraErrorLine(MYRA_ERROR_SITUATIONS.SCAN_MAGIC_ASLEEP)
        return
      }

      const gen = ++verifyGenerationRef.current
      scanSnapInFlightRef.current = true
      setShowScanGuide(false)
      // Best-effort (MindAR track is not always a user gesture). Real unlock is on camera tap.
      unlockMobileSpeechAudio({ force: true, speechPing: true })
      primeSafariSpeechSynthesis()

      const canvas = drawVideoFrameToCanvas(videoEl)
      scanSnapshotRef.current = null

      try {
        const { verified, verificationCode, failReason } = await recognizeProductFromFrame(canvas)
        if (gen !== verifyGenerationRef.current) return

        if (verified && verificationCode) {
          verifyFailCountRef.current = 0
          await completeVerification(verificationCode)
        } else {
          verifyFailCountRef.current += 1
          scanSnapshotRef.current = null
          setShowScanGuide(true)
          speakMyraErrorLine(verifyFailSituation(failReason))
        }
      } catch (err) {
        if (gen !== verifyGenerationRef.current) return
        console.warn('[Verify] anchor snap failed:', err)
        setShowScanGuide(true)
        speakMyraErrorLine(MYRA_ERROR_SITUATIONS.SCAN_GLITCH)
      } finally {
        if (gen === verifyGenerationRef.current) {
          scanSnapInFlightRef.current = false
        }
      }
    },
    [completeVerification, speakMyraErrorLine],
  )

  const handleCardTracked = useCallback(
    (phase, getVideo) => {
      const video = typeof getVideo === 'function' ? getVideo() : null
      if (!video) return
      void runAnchorVerify(phase, video)
    },
    [runAnchorVerify],
  )

  const endExperience = useCallback(async () => {
    restartingScanRef.current = true
    await finishLedgerScan()
    clearMindARDelay()
    setIsVerified(false)
    isVerifiedRef.current = false
    verifyGenerationRef.current += 1
    verifyFailCountRef.current = 0
    spokeForScanRef.current = false
    welcomeInFlightRef.current = false
    clearWelcomeDelayTimer()
    setTargetVideoDone(false)
    targetVideoDoneRef.current = false
    setMindarReady(false)
    mindarReadyRef.current = false
    setShowMindAR(false)
    setArPreviewStream(null)
    setArCameraProfile(null)
    setArError(null)
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
    setExperienceViewMode('ar')
    stopJarvisMode()
    stopAllCameraStreams()

    try {
      await grantStartupAccess()
      setCameraError(null)
      scheduleMindAR(true)
      setShowScanGuide(true)
    } catch (error) {
      setShowScanGuide(false)
      setCameraError(
        error instanceof Error ? error.message : 'Could not access camera',
      )
    } finally {
      restartingScanRef.current = false
    }
  }, [clearWelcomeDelayTimer, grantStartupAccess, stopJarvisMode])

  useEffect(() => {
    endExperienceRef.current = endExperience
  }, [endExperience])

  useEffect(() => {
    const onAudioNeedsTap = (event) => {
      const needs = Boolean(event?.detail?.needsTap)
      setNeedsAudioTap(needs)
      if (needs) setJarvisUiReady(true)
    }
    window.addEventListener('axerai-audio-needs-tap', onAudioNeedsTap)
    return () => window.removeEventListener('axerai-audio-needs-tap', onAudioNeedsTap)
  }, [])

  useEffect(() => {
    const saveLedgerOnPageHide = () => {
      if (!isLedgerScanActive()) return
      void finishLedgerScan({ fastExit: true })
    }
    window.addEventListener('pagehide', saveLedgerOnPageHide)
    return () => window.removeEventListener('pagehide', saveLedgerOnPageHide)
  }, [])

  useEffect(() => {
    if (introVisible || !cameraInitReady) return
    if (showMindAR || restartingScanRef.current) return
    scheduleMindAR()
  }, [introVisible, cameraInitReady, showMindAR])

  useEffect(() => {
    if (experienceViewMode === 'ar' && showMindAR && !isVerified && !scanSnapInFlightRef.current) {
      setShowScanGuide(true)
    } else if (isVerified) {
      setShowScanGuide(false)
    }
  }, [experienceViewMode, showMindAR, isVerified, mindarReady])

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

  const retryCamera = useCallback(() => {
    setCameraError(null)
    setCameraInitReady(false)
    startupPermissionsDoneRef.current = false
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void grantStartupAccess().catch((error) => {
      setCameraError(
        error instanceof Error ? error.message : 'Could not access camera',
      )
    })
  }, [grantStartupAccess])

  const restartCameraForAr = useCallback(async () => {
    stopAllCameraStreams()
    setArPreviewStream(null)
    setArCameraProfile(null)
    setShowMindAR(false)
    setMindarReady(false)
    mindarReadyRef.current = false

    try {
      const stream = await acquireCameraStream(selectedDeviceId, cameraFacing)

      streamRef.current = stream
      setCameraError(null)
      await attachCameraToVideo()
      scheduleMindAR(true)
    } catch (err) {
      setVideoReady(false)
      setCameraError(
        err instanceof Error ? err.message : 'Could not access camera',
      )
    }
  }, [attachCameraToVideo, cameraFacing, selectedDeviceId])

  const toggleExperienceViewMode = useCallback(() => {
    if (!isVerified) return

    if (experienceViewMode === 'ar') {
      clearMindARDelay()
      setShowMindAR(false)
      setMindarReady(false)
      mindarReadyRef.current = false
      setArPreviewStream(null)
      setArCameraProfile(null)
      setArError(null)
      stopAllCameraStreams()
      setExperienceViewMode('vr')
      return
    }

    setExperienceViewMode('ar')
    setArError(null)
    void restartCameraForAr()
  }, [experienceViewMode, isVerified, restartCameraForAr])

  const bindCameraVideo = useCallback(
    (node) => {
      videoRef.current = node
      if (node) attachCameraToVideo()
    },
    [attachCameraToVideo],
  )

  useEffect(() => {
    if (!introVisible) return undefined

    const handleDeviceChange = () => {
      void loadDevices()
    }
    navigator.mediaDevices?.addEventListener('devicechange', handleDeviceChange)
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [introVisible, loadDevices])

  useEffect(() => {
    if (introVisible || !cameraInitReady) return

    let cancelled = false

    async function startStream() {
      const activeId =
        streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId
      if (
        selectedDeviceId &&
        activeId === selectedDeviceId &&
        streamRef.current?.active
      ) {
        await attachCameraToVideo()
        return
      }

      streamRef.current?.getTracks().forEach((track) => track.stop())

      try {
        const stream = await acquireCameraStream(selectedDeviceId, cameraFacing)

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream
        setCameraError(null)
        const attached = await attachCameraToVideo()
        if (!attached && !cancelled) {
          window.setTimeout(() => {
            if (!cancelled) void attachCameraToVideo()
          }, 120)
        }
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
  }, [selectedDeviceId, cameraFacing, introVisible, attachCameraToVideo, cameraInitReady])

  useEffect(() => {
    if (isVerified) {
      const track = streamRef.current?.getVideoTracks()[0] ?? null
      applyTrackZoom(track, 1).catch(() => {})
    }
  }, [isVerified, videoReady, selectedDeviceId, cameraFacing])

  const flipCamera = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0] ?? null
    await applyTrackTorch(track, false).catch(() => {})
    setTorchOn(false)
    setSelectedDeviceId('')
    setCameraFacing((facing) => (facing === 'environment' ? 'user' : 'environment'))
  }, [])

  const getCameraTrack = useCallback(
    () => streamRef.current?.getVideoTracks()[0] ?? arStreamRef.current?.getVideoTracks()[0] ?? null,
    [],
  )

  const toggleTorch = useCallback(async () => {
    const track = getCameraTrack()
    if (!track) return
    const next = !torchOnRef.current
    const ok = await applyTrackTorch(track, next)
    if (ok) setTorchOn(next)
  }, [getCameraTrack])

  const handleViewportDoubleTap = useCallback(() => {
    const now = Date.now()
    if (now - viewportTapRef.current < 340) {
      viewportTapRef.current = 0
      flipCamera()
      return
    }
    viewportTapRef.current = now
  }, [flipCamera])

  useEffect(() => {
    torchOnRef.current = torchOn
  }, [torchOn])

  useEffect(() => {
    const track = getCameraTrack()
    if (!track) {
      setTorchSupported(false)
      return
    }
    const caps = track.getCapabilities?.()
    const supported = Boolean(caps?.torch || caps?.fillLightMode?.includes?.('flash'))
    setTorchSupported(supported)
    if (!supported) {
      setTorchOn(false)
      return
    }
    if (torchOnRef.current) {
      applyTrackTorch(track, true).catch(() => setTorchOn(false))
    }
  }, [videoReady, selectedDeviceId, cameraFacing, isVerified, getCameraTrack])

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
    if (!mainRevealed) return undefined

    const primeOnGesture = () => {
      unlockMobileSpeechAudio({ force: true })
    }

    document.addEventListener('touchstart', primeOnGesture, { passive: true })
    document.addEventListener('click', primeOnGesture, { passive: true })

    return () => {
      document.removeEventListener('touchstart', primeOnGesture)
      document.removeEventListener('click', primeOnGesture)
    }
  }, [mainRevealed])

  useEffect(() => {
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

  const liveMicDockButton = (
    <button
      type="button"
      onClick={() => toggleComposeMode('liveMic')}
      aria-label="Live microphone"
      aria-pressed={composeMode === 'liveMic'}
      className={`hud-icon-btn flex h-10 w-10 items-center justify-center rounded-full${composeMode === 'liveMic' ? ' hud-icon-btn--active' : ''}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3z" />
        <path strokeLinecap="round" d="M19 11v1a7 7 0 01-14 0v-1" />
        <path strokeLinecap="round" d="M12 19v3" />
        <path strokeLinecap="round" d="M8 21h8" />
      </svg>
    </button>
  )

  const arVrToggleButton = isVerified ? (
    <button
      type="button"
      onClick={toggleExperienceViewMode}
      aria-label={experienceViewMode === 'ar' ? 'Switch to VR mode' : 'Switch to AR mode'}
      className={`hud-icon-btn hud-arvr-toggle flex h-10 items-center justify-center rounded-full${experienceViewMode === 'vr' ? ' hud-arvr-toggle--vr' : ''}`}
    >
      {experienceViewMode === 'ar' ? 'VR' : 'AR'}
    </button>
  ) : null

  const flashButton = (
    <button
      type="button"
      onClick={toggleTorch}
      disabled={!torchSupported || cameraFacing === 'user'}
      aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'}
      aria-pressed={torchOn}
      className={`hud-icon-btn flex h-10 w-10 items-center justify-center rounded-full${torchOn ? ' hud-icon-btn--active' : ''}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L5 14h6l-1 8 8-12h-6l1-8z" />
      </svg>
    </button>
  )

  const cameraFlipButton = (
    <button
      type="button"
      onDoubleClick={flipCamera}
      aria-label="Double-click to flip camera"
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
        <IntroShell
          onExitStart={handleIntroExitStart}
          onExitComplete={handleIntroExitComplete}
          readyToEnter={introReadyToEnter}
          startupAccess={startupAccess}
          startupAccessHint={startupAccessHint}
          onAssetsReady={handleAssetsReady}
          onAutoRequestAccess={handleAutoRequestAccess}
          onGrantAccess={handleGrantAccess}
        />
      ) : null}

      <div className={`axerai-app relative flex h-[100dvh] h-[100svh] w-full flex-col overflow-hidden text-white${mainRevealed ? ' main-reveal--active' : ''}${introVisible ? ' axerai-app--during-intro' : ''}`}>
        <div className="axerai-bg pointer-events-none absolute inset-0" />
        <div className="axerai-grid pointer-events-none absolute inset-0" />
        <div className="axerai-orb axerai-orb--1 pointer-events-none absolute" aria-hidden />
        <div className="axerai-orb axerai-orb--2 pointer-events-none absolute" aria-hidden />
        <div className="axerai-scanlines pointer-events-none absolute inset-0" aria-hidden />

        <div className="relative z-10 flex h-full min-h-0 w-full flex-col">
          {cameraError ? (
            <div className="axerai-stage-error mx-4 mt-4 flex flex-col items-center gap-3 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-center text-sm text-red-200 backdrop-blur-md">
              <p>{cameraError}</p>
              <button
                type="button"
                onClick={retryCamera}
                className="rounded-full border border-red-300/35 bg-red-950/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-red-100"
              >
                Retry camera
              </button>
            </div>
          ) : null}

          <div className="axerai-stage-shell">
            <div className="main-reveal-item main-reveal-item--2 hud-viewport hud-viewport--stage relative h-full min-h-0 w-full flex-1">
              {experienceViewMode === 'ar' && !isVerified ? (
                <button
                  type="button"
                  className="hud-viewport-tap absolute inset-0 z-[3] cursor-default border-0 bg-transparent p-0"
                  aria-label="Double-tap to flip camera"
                  onClick={handleViewportDoubleTap}
                  onContextMenu={(event) => event.preventDefault()}
                />
              ) : null}
              {experienceViewMode === 'ar' && showMindAR && !mindarReady && (
                <video
                  ref={bindCameraVideo}
                  autoPlay
                  playsInline
                  muted
                  onLoadedData={() => setVideoReady(true)}
                  onEmptied={() => setVideoReady(false)}
                  className="absolute inset-0 z-[1] h-full w-full bg-black object-cover transition-transform duration-200"
                />
              )}
              {isVerified && experienceViewMode === 'vr' && (
                <MyraStaticSession
                  backgroundSrc={INTRO_LOADING_BG}
                  showMyra
                  isTalking={isMyraTalking}
                  playTargetVideo={!targetVideoDone}
                  onTargetVideoEnded={handleTargetVideoEnded}
                />
              )}
              {experienceViewMode === 'ar' && showMindAR && arPreviewStream && arCameraProfile && (
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
                    onCardTracked={handleCardTracked}
                    playTargetVideo
                    showMyra={mindarReady && (isVerified || targetVideoDone)}
                    isTalking={isMyraTalking}
                  />
                </div>
              )}

              {showScanGuide && experienceViewMode === 'ar' && showMindAR && !isVerified ? (
                <div className="hud-scan-guide pointer-events-none absolute inset-x-0 bottom-0 z-[5] flex justify-center pb-8">
                  <div className="hud-scan-guide__card" role="status">
                    <p className="hud-scan-guide__title">Center the RICHERA card</p>
                    <p className="hud-scan-guide__copy">Hold it steady in the middle — we&apos;ll scan automatically</p>
                  </div>
                </div>
              ) : null}

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
                {arVrToggleButton}
                {experienceViewMode === 'ar' ? cameraFlipButton : null}
                {experienceViewMode === 'ar' ? flashButton : null}
                {isVerified && jarvisUiReady
                  ? composeMode === 'keyboard'
                    ? liveMicDockButton
                    : keyboardButton
                  : null}
              </div>


              {arError && showMindAR && (
                <div className="absolute z-40 rounded-xl border border-red-400/30 bg-red-950/85 px-4 py-2 text-center text-xs text-red-200 backdrop-blur-md hud-inset-x hud-inset-top-below">
                  {arError}
                </div>
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

              {needsAudioTap ? (
                <button
                  type="button"
                  className="axerai-audio-tap"
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    // speak()/play() must start in this gesture — do not await anything first.
                    const played = playQueuedTtsFromUserGesture()
                    if (!played) {
                      unlockMobileSpeechAudio({ force: true, speechPing: true })
                      // Keep button visible until the queue actually starts (event will hide it).
                      return
                    }
                    setNeedsAudioTap(false)
                  }}
                >
                  Tap for sound
                </button>
              ) : null}

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
        </div>
      </div>
    </>
  )
}

export default App
