/** Block pinch/double-tap zoom, text selection, and prefer portrait on the AR app. */
export function initAxeraiMobileShell() {
  const blockMultiTouch = (event) => {
    if (event.touches?.length > 1) event.preventDefault()
  }

  document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('gesturechange', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('gestureend', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('touchmove', blockMultiTouch, { passive: false })

  // Safari double-tap zoom — ignore quick second touchend on non-input UI.
  let lastTouchEndAt = 0
  document.addEventListener(
    'touchend',
    (event) => {
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) {
        return
      }
      const now = Date.now()
      if (now - lastTouchEndAt <= 320) {
        event.preventDefault()
      }
      lastTouchEndAt = now
    },
    { passive: false },
  )

  document.addEventListener('selectstart', (event) => {
    const target = event.target
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) {
      return
    }
    event.preventDefault()
  })

  document.addEventListener('dblclick', (event) => event.preventDefault(), { passive: false })

  const tryLockPortrait = () => {
    const orientation = screen.orientation
    if (!orientation?.lock) return
    orientation.lock('portrait-primary').catch(() => {})
  }

  tryLockPortrait()
  document.addEventListener('pointerdown', tryLockPortrait, { once: true, passive: true })

  /** Device orientation (not viewport) — keyboard must not trigger landscape UI. */
  const syncDeviceLandscape = () => {
    const type = screen.orientation?.type ?? ''
    const angle = typeof window.orientation === 'number' ? Math.abs(window.orientation) : 0
    const landscape = type.startsWith('landscape') || angle === 90
    document.documentElement.classList.toggle('axerai-device-landscape', landscape)
  }

  const syncKeyboardOpen = () => {
    const active = document.activeElement
    const typing =
      active instanceof HTMLElement &&
      active.matches('input, textarea, select, [contenteditable="true"]')
    document.documentElement.classList.toggle('axerai-keyboard-open', typing)
  }

  syncDeviceLandscape()
  syncKeyboardOpen()
  window.addEventListener('orientationchange', syncDeviceLandscape)
  screen.orientation?.addEventListener?.('change', syncDeviceLandscape)
  document.addEventListener('focusin', syncKeyboardOpen)
  document.addEventListener('focusout', () => {
    window.setTimeout(syncKeyboardOpen, 80)
  })
}
