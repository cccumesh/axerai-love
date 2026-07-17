import {
  PlaneGeometry,
  MeshBasicMaterial,
  Mesh,
  VideoTexture,
  DoubleSide,
  LinearFilter,
} from 'three'
import { primeMobileAudio } from './elevenLabsTts.js'

export const TARGET_VIDEO_PATH = '/videos/target.mp4'
const TARGET_PLANE_WIDTH = 1
const PLAY_RETRY_MS = 180
const WATCHDOG_FALLBACK_MS = 16000

let targetVideoPreloadPromise = null

function isAppleMobileBrowser() {
  const ua = navigator.userAgent
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

function configureInlineVideo(video) {
  video.muted = true
  video.defaultMuted = true
  video.playsInline = true
  video.setAttribute('playsinline', '')
  video.setAttribute('webkit-playsinline', '')
  video.setAttribute('x-webkit-airplay', 'deny')
  video.preload = 'auto'
  video.loop = false
}

export function preloadTargetVideo() {
  if (targetVideoPreloadPromise) return targetVideoPreloadPromise

  targetVideoPreloadPromise = new Promise((resolve, reject) => {
    const video = document.createElement('video')
    configureInlineVideo(video)
    video.src = TARGET_VIDEO_PATH

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      console.info('[TargetVideo] preloaded — ready for anchor')
      resolve()
    }

    video.addEventListener('canplaythrough', finish, { once: true })
    video.addEventListener('loadeddata', finish, { once: true })
    video.addEventListener('error', () => {
      if (settled) return
      settled = true
      targetVideoPreloadPromise = null
      reject(new Error('Target video preload failed'))
    }, { once: true })
    video.load()
  })

  return targetVideoPreloadPromise
}

export function mountTargetAnchorVideo({ anchor, anchorGroup, onEnded, onCardTracked }) {
  let disposed = false
  let finished = false
  let pendingTargetFound = false
  let playAttempted = false
  let playInFlight = false
  let retryTimer = null
  let watchdogTimer = null
  let cardTrackedNotified = false

  const video = document.createElement('video')
  configureInlineVideo(video)
  video.src = TARGET_VIDEO_PATH

  const texture = new VideoTexture(video)
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  let geometry = new PlaneGeometry(TARGET_PLANE_WIDTH, TARGET_PLANE_WIDTH)
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
  })
  const mesh = new Mesh(geometry, material)
  mesh.position.set(0, 0, 0.02)
  mesh.renderOrder = 2
  mesh.userData.isTargetVideo = true
  anchorGroup.add(mesh)

  const clearRetryTimer = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  const cleanupMesh = () => {
    anchorGroup.remove(mesh)
    texture.dispose()
    material.dispose()
    geometry.dispose()
  }

  const finish = () => {
    if (finished || disposed) return
    finished = true
    clearRetryTimer()
    clearWatchdog()
    if (playAttempted || pendingTargetFound) onEnded?.()
    cleanupMesh()
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  const startWatchdog = () => {
    clearWatchdog()
    const durationMs =
      Number.isFinite(video.duration) && video.duration > 0
        ? Math.ceil(video.duration * 1000) + 3000
        : WATCHDOG_FALLBACK_MS
    watchdogTimer = window.setTimeout(() => {
      console.warn('[TargetVideo] watchdog — advancing to Myra')
      finish()
    }, durationMs)
  }

  const resizePlane = () => {
    if (!video.videoWidth || !video.videoHeight) return
    const aspect = video.videoWidth / video.videoHeight
    const height = TARGET_PLANE_WIDTH / aspect
    const next = new PlaneGeometry(TARGET_PLANE_WIDTH, height)
    mesh.geometry.dispose()
    mesh.geometry = next
    geometry = next
  }

  const notifyCardTrackedOnce = () => {
    if (cardTrackedNotified) return
    cardTrackedNotified = true
    onCardTracked?.()
  }

  const scheduleRetry = () => {
    if (disposed || finished || playInFlight) return
    clearRetryTimer()
    retryTimer = window.setTimeout(() => {
      retryTimer = null
      void tryPlay()
    }, PLAY_RETRY_MS)
  }

  const tryPlay = async () => {
    if (disposed || finished || playInFlight) return

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      pendingTargetFound = true
      scheduleRetry()
      return
    }

    if (!video.paused && video.currentTime > 0.04 && !video.ended) {
      return
    }

    playInFlight = true
    playAttempted = true
    pendingTargetFound = false
    clearRetryTimer()

    primeMobileAudio()
    video.currentTime = 0
    video.muted = true

    try {
      await video.play()

      if (video.paused) {
        throw new Error('Target video paused immediately after play()')
      }

      notifyCardTrackedOnce()
      startWatchdog()

      // Safari/iOS: unmute often pauses inline video — keep muted so playback continues.
      if (!isAppleMobileBrowser()) {
        video.muted = false
        video.volume = 1
        if (video.paused) {
          video.muted = true
          await video.play()
        }
      }
    } catch (error) {
      console.warn('[TargetVideo] play failed — retrying', error)
      playInFlight = false
      if (pendingTargetFound || cardTrackedNotified) {
        scheduleRetry()
        return
      }
      scheduleRetry()
    } finally {
      playInFlight = false
    }
  }

  const onTargetFound = () => {
    if (disposed || finished) return
    pendingTargetFound = true
    notifyCardTrackedOnce()
    startWatchdog()
    void tryPlay()
  }

  const onTargetLost = () => {
    pendingTargetFound = false
    clearRetryTimer()
  }

  const previousTargetFound = anchor.onTargetFound
  const previousTargetLost = anchor.onTargetLost

  anchor.onTargetFound = () => {
    previousTargetFound?.()
    onTargetFound()
  }

  anchor.onTargetLost = () => {
    previousTargetLost?.()
    onTargetLost()
  }

  const handleReady = () => {
    resizePlane()
    if (pendingTargetFound) void tryPlay()
  }

  const handleStalled = () => {
    if (disposed || finished || !pendingTargetFound) return
    scheduleRetry()
  }

  video.addEventListener('loadedmetadata', resizePlane)
  video.addEventListener('loadeddata', handleReady)
  video.addEventListener('canplay', handleReady)
  video.addEventListener('canplaythrough', handleReady)
  video.addEventListener('stalled', handleStalled)
  video.addEventListener('waiting', handleStalled)
  video.addEventListener('ended', finish)
  video.addEventListener('error', () => {
    console.warn('[TargetVideo] load error')
    finish()
  })

  video.load()

  return () => {
    disposed = true
    clearRetryTimer()
    clearWatchdog()
    anchor.onTargetFound = previousTargetFound ?? null
    anchor.onTargetLost = previousTargetLost ?? null
    if (!finished) cleanupMesh()
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}
