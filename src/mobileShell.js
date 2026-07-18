/** Block pinch/double-tap zoom, text selection, and keep the AR app in portrait. */

function isPhoneShell() {
  const ua = navigator.userAgent || ''
  const mobileUa = /Android|iPhone|iPod|Mobile/i.test(ua)
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches
  const touchPhone = navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) <= 920
  return Boolean(mobileUa || (coarse && touchPhone))
}

function tryLockPortrait() {
  if (!isPhoneShell()) return
  const orientation = screen.orientation
  if (!orientation?.lock) return
  orientation.lock('portrait-primary').catch(() => {})
  orientation.lock?.('portrait').catch(() => {})
}

/**
 * If the OS still rotates (common on iPhone Safari), keep the app visually portrait
 * by counter-rotating the root — no message overlay.
 */
function syncForcedPortrait() {
  const root = document.documentElement
  if (!isPhoneShell()) {
    root.classList.remove('axerai-phone-landscape')
    return
  }

  tryLockPortrait()

  const type = screen.orientation?.type ?? ''
  const angle = Number(screen.orientation?.angle ?? window.orientation ?? 0)
  const landscape = type.startsWith('landscape') || Math.abs(angle) === 90 || Math.abs(angle) === 270
  root.classList.toggle('axerai-phone-landscape', landscape)

  // Match OS rotate direction so the UI stays upright (portrait) with no message.
  let rotate = '90deg'
  if (angle === 90 || type === 'landscape-primary') rotate = '-90deg'
  if (angle === 270 || angle === -90 || type === 'landscape-secondary') rotate = '90deg'
  root.style.setProperty('--axerai-lock-rotate', rotate)
}

export function initAxeraiMobileShell() {
  const blockMultiTouch = (event) => {
    if (event.touches?.length > 1) event.preventDefault()
  }

  document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('gesturechange', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('gestureend', (event) => event.preventDefault(), { passive: false })
  document.addEventListener('touchmove', blockMultiTouch, { passive: false })

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

  tryLockPortrait()
  syncForcedPortrait()

  document.addEventListener('pointerdown', tryLockPortrait, { passive: true })
  window.addEventListener('orientationchange', () => {
    tryLockPortrait()
    window.setTimeout(syncForcedPortrait, 50)
    window.setTimeout(syncForcedPortrait, 300)
  })
  screen.orientation?.addEventListener?.('change', () => {
    tryLockPortrait()
    syncForcedPortrait()
  })
  window.addEventListener('resize', syncForcedPortrait)
}
