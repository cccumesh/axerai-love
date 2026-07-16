/** Shared Gemini model routing — one API key, task-specific chains with retry/fallback. */

/** Models that work reliably on new AI Studio keys (AQ.*). */
export const GEMINI_CHAT_PRIMARY = 'gemini-3.1-flash-lite'
export const GEMINI_CHAT_FALLBACK = 'gemini-flash-lite-latest'

const CHAT_MODEL_CHAIN = [GEMINI_CHAT_PRIMARY, GEMINI_CHAT_FALLBACK]

/**
 * Flash vs lite tier uses the same models on free keys — flash tier gets
 * richer generationConfig in App.jsx (higher temperature).
 */
export const MYRA_CHAT_FLASH_CHAIN = CHAT_MODEL_CHAIN
export const MYRA_CHAT_LITE_CHAIN = CHAT_MODEL_CHAIN

export const VERIFY_MODEL_CHAIN = CHAT_MODEL_CHAIN
export const SUMMARY_MODEL_CHAIN = CHAT_MODEL_CHAIN

export const MYRA_FLASH_USER_TURNS = 6
export const MYRA_FLASH_LONG_MSG_WORDS = 150

export const MYRA_FLASH_GENERATION = { temperature: 0.95, topP: 0.95, topK: 40 }
export const MYRA_LITE_GENERATION = { temperature: 0.85, topP: 0.88, topK: 32 }

export function countWords(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

export function myraGenerationConfig(tier = 'lite') {
  return tier === 'flash' ? MYRA_FLASH_GENERATION : MYRA_LITE_GENERATION
}

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
