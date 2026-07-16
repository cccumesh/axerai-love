import { PlaneGeometry, MeshBasicMaterial, Mesh, VideoTexture, DoubleSide } from 'three'

export const TARGET_VIDEO_PATH = '/videos/target.mp4'
const TARGET_PLANE_WIDTH = 1

let targetVideoPreloadPromise = null

export function preloadTargetVideo() {
  if (targetVideoPreloadPromise) return targetVideoPreloadPromise

  targetVideoPreloadPromise = new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.src = TARGET_VIDEO_PATH

    const finish = () => {
      console.info('[TargetVideo] preloaded — ready for anchor')
      resolve()
    }

    video.addEventListener('canplaythrough', finish, { once: true })
    video.addEventListener('error', () => {
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
  let playing = false
  let everPlayed = false

  const video = document.createElement('video')
  video.src = TARGET_VIDEO_PATH
  video.muted = true
  video.defaultMuted = true
  video.playsInline = true
  video.setAttribute('playsinline', '')
  video.setAttribute('webkit-playsinline', '')
  video.preload = 'auto'
  video.loop = false

  const texture = new VideoTexture(video)
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

  const cleanupMesh = () => {
    anchorGroup.remove(mesh)
    texture.dispose()
    material.dispose()
    geometry.dispose()
  }

  const finish = () => {
    if (finished || disposed) return
    finished = true
    if (everPlayed) onEnded?.()
    cleanupMesh()
    video.pause()
    video.removeAttribute('src')
    video.load()
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

  const tryPlay = async () => {
    if (disposed || finished || playing) return
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return

    playing = true
    everPlayed = true
    video.currentTime = 0
    video.muted = true

    try {
      await video.play()
      video.muted = false
      video.volume = 1
      await video.play().catch(() => {})
    } catch (error) {
      playing = false
      console.warn('[TargetVideo] play failed — skipping to Myra', error)
      finish()
    }
  }

  const onTargetFound = () => {
    if (disposed || finished) return
    onCardTracked?.('video')
    void tryPlay()
  }

  const previousTargetFound = anchor.onTargetFound
  const previousTargetLost = anchor.onTargetLost

  anchor.onTargetFound = () => {
    previousTargetFound?.()
    onTargetFound()
  }

  anchor.onTargetLost = () => {
    previousTargetLost?.()
  }

  video.addEventListener('loadedmetadata', resizePlane)
  video.addEventListener('ended', finish)
  video.addEventListener('error', () => {
    console.warn('[TargetVideo] load error')
    if (everPlayed) finish()
  })

  video.load()

  return () => {
    disposed = true
    anchor.onTargetFound = previousTargetFound ?? null
    anchor.onTargetLost = previousTargetLost ?? null
    if (!finished) cleanupMesh()
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}
