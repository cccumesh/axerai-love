export function isAppleMobileBrowser() {
  const ua = navigator.userAgent
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

export function isAndroidBrowser() {
  return /Android/i.test(navigator.userAgent || '')
}

/** Chrome / Edge / Firefox / Opera on iOS (all WebKit, not Safari UI). */
export function isIOSChromeLike() {
  if (!isAppleMobileBrowser()) return false
  return /CriOS|FxiOS|EdgiOS|OPiOS|OPT\//i.test(navigator.userAgent || '')
}

export function isIOSChrome() {
  return isAppleMobileBrowser() && /CriOS/i.test(navigator.userAgent || '')
}

export function isIOSSafari() {
  return isAppleMobileBrowser() && !isIOSChromeLike()
}
