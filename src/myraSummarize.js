import { usageFromResponse } from './geminiUsage.js'
import { SUMMARY_MODEL_CHAIN } from './geminiModels.js'

const GEMINI_API_KEY = String(import.meta.env.VITE_GEMINI_API_KEY ?? '').trim()

/** Dedicated system prompt — ONLY for exit summary call. NOT Myra personality. */
export const MYRA_SESSION_SUMMARY_SYSTEM = `You are the Axerai Soul Ledger Archivist — NOT Myra.

Compress ONE ended scan into memory for future sessions.

INPUT: labelled chat log (sender:/receiver:/myra: lines) from ONE scan only.
OUTPUT: exactly 3 sections below. Plain text. No markdown. No emojis.

REQUIRED FORMAT (exact headers, this order):

THREAD: Sender | Receiver

USER SAID:
- Copy every sender: or receiver: line from the log WORD FOR WORD.
- One line per message. Keep the speaker prefix (sender: or receiver:).
- Do NOT shorten, paraphrase, or fix spelling. Verbatim only.

MYRA SAID:
- One condensed line per myra: reply from the log, in order.
- Shorten Myra's rambling — keep the emotional beat only.
- CRITICAL: If a Myra line ends with a question, that question MUST appear verbatim at the end of that condensed line.
- CRITICAL: The LAST Myra line in the log — its closing question (if any) must be copied VERBATIM, never shortened or dropped.
- Do not invent Myra lines not in the log.

BRAND PRODUCT PRAISE:
- yes ONLY if user praised the physical product: RICHERA card, bracelet, box, packaging, gift design.
- NOT girlfriend/boyfriend praise, NOT Myra praise, NOT generic love.
- If yes: BRAND PRODUCT PRAISE: yes | "exact user words from log"
- If none: BRAND PRODUCT PRAISE: none

SCOPE: This scan's log only. Do not merge other scans. Do not add EMOTIONS, FACTS, or OPEN THREADS sections.`

let geminiClient = null

async function getGeminiClient() {
  if (!GEMINI_API_KEY) return null
  if (!geminiClient) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    geminiClient = new GoogleGenerativeAI(GEMINI_API_KEY)
  }
  return geminiClient
}

function isSummarizeConfigured() {
  return Boolean(GEMINI_API_KEY)
}

function buildRoleContext(roleKey) {
  if (roleKey === 'receiver') {
    return {
      threadLabel: 'Receiver',
      humanLabel: 'receiver',
      whoLine: 'Receiver thread — only receiver: and myra: lines in this log.',
    }
  }
  return {
    threadLabel: 'Sender',
    humanLabel: 'sender',
    whoLine: 'Sender thread — only sender: and myra: lines in this log.',
  }
}

/** Pull trailing question sentence from a Myra line for summary preservation. */
export function extractMyraClosingQuestion(text) {
  const t = String(text ?? '').trim()
  if (!t.includes('?')) return ''

  const sentences = t.split(/(?<=[.?!])\s+/)
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i].trim()
    if (sentence.includes('?')) return sentence
  }
  return ''
}

/** Local fallback condense — short body + preserved closing question. */
export function condenseMyraLineForSummary(text, { isLast = false } = {}) {
  const t = String(text ?? '').trim()
  if (!t) return ''

  const closingQuestion = extractMyraClosingQuestion(t)
  if (isLast && closingQuestion) return closingQuestion.length <= 220 ? `${t.slice(0, 120).trim()}... ${closingQuestion}` : closingQuestion

  if (t.length <= 140) return t

  const body = t.slice(0, 110).trim().replace(/[.,…]+$/, '')
  if (closingQuestion) return `${body}... ${closingQuestion}`
  return `${body}...`
}

async function requestSummary(userPrompt) {
  const client = await getGeminiClient()
  if (!client) return null

  let lastError = null
  for (const modelName of SUMMARY_MODEL_CHAIN) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction: MYRA_SESSION_SUMMARY_SYSTEM,
        generationConfig: { temperature: 0.2, topP: 0.85, maxOutputTokens: 768 },
      })
      const result = await model.generateContent(userPrompt)
      const text = result.response.text()?.trim()
      if (text) {
        return {
          text,
          model: modelName,
          usage: usageFromResponse(result.response),
        }
      }
    } catch (error) {
      lastError = error
    }
  }

  if (lastError) throw lastError
  return null
}

function countDialogueSpeakers(dialogue) {
  const log = String(dialogue ?? '')
  const myraCount = (log.match(/^myra:/gim) ?? []).length
  const userCount = (log.match(/^(sender|receiver):/gim) ?? []).length
  return { myraCount, userCount }
}

/** Exit call — one scan → one summary block appended to session_summaries. */
export async function summarizeSessionDialogue({ dialogue, roleKey = 'sender', scanNumber = 1 }) {
  const log = String(dialogue ?? '').trim()
  if (!log) return null
  if (!isSummarizeConfigured()) {
    console.warn('[Ledger] Summary skipped — Gemini not configured')
    return null
  }

  const ctx = buildRoleContext(roleKey)
  const { myraCount, userCount } = countDialogueSpeakers(log)

  const userPrompt = `Write session ${scanNumber} summary.

${ctx.whoLine}

THIS SCAN CHAT LOG ONLY:
${log}

THREAD: ${ctx.threadLabel}
USER SAID: copy every ${ctx.humanLabel}: line verbatim — same words, same spelling.
MYRA SAID: one short line per myra: reply; keep each line's closing question verbatim; last Myra question is mandatory verbatim.
End with BRAND PRODUCT PRAISE (product only, not GF/BF).
${userCount > 0 ? `${userCount} user line(s) in log.` : 'No user lines.'}
${myraCount > 0 ? `${myraCount} myra line(s) in log.` : 'No myra lines.'}`

  const summaryResult = await requestSummary(userPrompt)
  if (!summaryResult?.text) return null

  return {
    text: summaryResult.text.trim(),
    model: summaryResult.model,
    usage: summaryResult.usage,
  }
}

/** Parse Gemini BRAND PRODUCT PRAISE block — used by ledger + dashboard. */
export function parseBrandProductPraise(summaryText) {
  const text = String(summaryText ?? '').trim()
  if (!text) return { detected: false, quote: '' }

  if (/BRAND PRODUCT PRAISE:\s*none\b/i.test(text)) {
    return { detected: false, quote: '' }
  }

  const pipeMatch = text.match(/BRAND PRODUCT PRAISE:\s*yes\s*\|\s*"(.*)"/is)
  if (pipeMatch?.[1]?.trim()) {
    return { detected: true, quote: pipeMatch[1].trim().slice(0, 220) }
  }

  const looseMatch = text.match(/BRAND PRODUCT PRAISE:\s*yes\s*[-—:]\s*"?([^"\n]+)"?/i)
  if (looseMatch?.[1]?.trim()) {
    return { detected: true, quote: looseMatch[1].trim().slice(0, 220) }
  }

  return { detected: false, quote: '' }
}
