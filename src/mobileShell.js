/** Block pinch/double-tap zoom and prefer portrait on the AR app (not admin dashboard). */
export function initAxeraiMobileShell() {
  const blockMultiTouch = (event) => {
    if (event.touches?.length > 1) event.preventDefault()
  }

  document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('gesturechange', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('gestureend', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('touchmove', blockMultiTouch, { passive: false })

  const tryLockPortrait = () => {
    const orientation = screen.orientation
    if (!orientation?.lock) return
    orientation.lock('portrait-primary').catch(() => {})
  }

  tryLockPortrait()
  document.addEventListener('pointerdown', tryLockPortrait, { once: true, passive: true })
}
