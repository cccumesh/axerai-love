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
