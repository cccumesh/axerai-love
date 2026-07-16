/** Shared Gemini model routing — one API key, task-specific chains with retry/fallback. */

export const GEMINI_FLASH = 'gemini-2.5-flash'
export const GEMINI_FLASH_LITE = 'gemini-2.5-flash-lite'
export const GEMINI_FLASH_LITE_FALLBACK = 'gemini-3.1-flash-lite'

/** Myra chat: primary tier first, then fallbacks (never deprecated 2.0). */
export const MYRA_CHAT_FLASH_CHAIN = [
  GEMINI_FLASH,
  GEMINI_FLASH_LITE,
  GEMINI_FLASH_LITE_FALLBACK,
]

export const MYRA_CHAT_LITE_CHAIN = [
  GEMINI_FLASH_LITE,
  GEMINI_FLASH_LITE_FALLBACK,
  GEMINI_FLASH,
]

/** Verify + exit summary — always lite-first. */
export const VERIFY_MODEL_CHAIN = [GEMINI_FLASH_LITE, GEMINI_FLASH_LITE_FALLBACK]
export const SUMMARY_MODEL_CHAIN = [GEMINI_FLASH_LITE, GEMINI_FLASH_LITE_FALLBACK]

export const MYRA_FLASH_USER_TURNS = 6
export const MYRA_FLASH_LONG_MSG_WORDS = 150

export function countWords(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

/**
 * Myra chat model pick:
 * - First 6 user messages per session → Flash chain
 * - User message ≥ 150 words → Flash chain
 * - Welcome/boot → force Flash
 * - Else → Lite chain
 */
export function resolveMyraChatModels({
  userText = '',
  userTurnCount = 0,
  forceFlash = false,
} = {}) {
  const longMsg = countWords(userText) >= MYRA_FLASH_LONG_MSG_WORDS
  const earlySession = userTurnCount < MYRA_FLASH_USER_TURNS
  const useFlash = forceFlash || earlySession || longMsg

  let reason = 'lite-default'
  if (forceFlash) reason = 'welcome-or-boot'
  else if (longMsg) reason = 'long-user-msg'
  else if (earlySession) reason = `user-turn-${userTurnCount + 1}-of-${MYRA_FLASH_USER_TURNS}`

  return {
    models: useFlash ? MYRA_CHAT_FLASH_CHAIN : MYRA_CHAT_LITE_CHAIN,
    tier: useFlash ? 'flash' : 'lite',
    reason,
  }
}
