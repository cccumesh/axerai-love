/** Block pinch/double-tap zoom and ask the OS for portrait (phones only). */

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
  // One call only — dual lock() can reject and confuse some Android browsers.
  const lock = orientation.lock.bind(orientation)
  Promise.resolve(lock('portrait-primary')).catch(() => {
    Promise.resolve(lock('portrait')).catch(() => {})
  })
}

export function initAxeraiMobileShell() {
  // Never fake-rotate #root — that breaks MindAR / getUserMedia preview sizing.
  document.documentElement.classList.remove('axerai-phone-landscape')
  document.documentElement.style.removeProperty('--axerai-lock-rotate')

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

  // Lock only after a real gesture — required on most browsers.
  document.addEventListener('pointerdown', tryLockPortrait, { passive: true })
  window.addEventListener('orientationchange', () => {
    window.setTimeout(tryLockPortrait, 50)
  })
  screen.orientation?.addEventListener?.('change', tryLockPortrait)
}
