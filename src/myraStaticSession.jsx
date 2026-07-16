import { useEffect, useRef, useState } from 'react'
import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Clock,
  Group,
} from 'three'
import { MyraModel, tickMyraMixer, MYRA_MODEL_PATH, IDLE_PLACEMENT } from './myraModel.js'
import { mountTargetAnchorVideo } from './myraTargetVideo.js'

/** VR-only — lower than AR so Myra sits on the art, not floating. */
const VR_MYRA_PLACEMENT = {
  ...IDLE_PLACEMENT,
  position: { ...IDLE_PLACEMENT.position, y: -0.80 },
}

/** VR mode — Myra on Richera loading art, no camera / MindAR. */
export function MyraStaticSession({
  backgroundSrc,
  showMyra,
  isTalking,
  playTargetVideo = true,
  onTargetVideoEnded,
}) {
  const canvasHostRef = useRef(null)
  const [anchorGroup, setAnchorGroup] = useState(null)

  useEffect(() => {
    const host = canvasHostRef.current
    if (!host) return

    let disposed = false
    let disposeVideo = null
    let rafId = 0

    const scene = new Scene()
    const camera = new PerspectiveCamera(42, 1, 0.1, 100)
    camera.position.set(0, 0.02, 2.35)
    camera.lookAt(0, -0.12, 0)

    const renderer = new WebGLRenderer({ alpha: true, antialias: true })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    host.appendChild(renderer.domElement)

    const root = new Group()
    scene.add(root)
    if (!disposed) setAnchorGroup(root)

    scene.add(new AmbientLight(0xffffff, 1.35))
    const key = new DirectionalLight(0xffffff, 2.4)
    key.position.set(4, 6, 5)
    scene.add(key)
    const fill = new DirectionalLight(0xffffff, 1.1)
    fill.position.set(-3, 2, 4)
    scene.add(fill)

    if (playTargetVideo) {
      const mockAnchor = { group: root, onTargetFound: null, onTargetLost: null }
      disposeVideo = mountTargetAnchorVideo({
        anchor: mockAnchor,
        anchorGroup: root,
        onEnded: () => {
          if (!disposed) onTargetVideoEnded?.()
        },
      })
      window.setTimeout(() => {
        if (!disposed) mockAnchor.onTargetFound?.()
      }, 120)
    }
    // playTargetVideo false = already played this scan (AR or VR) — skip replay

    const clock = new Clock()

    const resize = () => {
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    }

    const loop = () => {
      if (disposed) return
      const delta = clock.getDelta()
      tickMyraMixer(root, delta)
      renderer.render(scene, camera)
      rafId = requestAnimationFrame(loop)
    }

    resize()
    loop()
    window.addEventListener('resize', resize)

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      disposeVideo?.()
      setAnchorGroup(null)
      window.removeEventListener('resize', resize)
      renderer.dispose()
      host.replaceChildren()
    }
  }, [playTargetVideo, onTargetVideoEnded])

  return (
    <div className="myra-static-session absolute inset-0 z-[2] overflow-hidden">
      <img src={backgroundSrc} alt="" className="myra-static-session__bg" aria-hidden />
      <div className="myra-static-session__shade" aria-hidden />
      <div ref={canvasHostRef} className="myra-static-session__canvas absolute inset-0" />
      {anchorGroup && showMyra ? (
        <MyraModel
          key={`${MYRA_MODEL_PATH}-static`}
          anchorGroup={anchorGroup}
          isTalking={isTalking}
          placement={VR_MYRA_PLACEMENT}
        />
      ) : null}
    </div>
  )
}
