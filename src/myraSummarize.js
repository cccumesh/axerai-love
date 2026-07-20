import { askGeminiViaProxy, USE_API_PROXY } from './apiProxy.js'
import { usageFromResponse } from './geminiUsage.js'
import { SUMMARY_MODEL_CHAIN } from './geminiModels.js'

const GEMINI_API_KEY = String(import.meta.env.VITE_GEMINI_API_KEY ?? '').trim()

/**
 * Dedicated system prompt — ONLY for exit summary call. NOT Myra personality.
 * Story memory for return scans; Myra still speaks one-beat/hooks in chat (separate prompt).
 */
export const MYRA_SESSION_SUMMARY_SYSTEM = `You are the Axerai Soul Ledger Archivist — NOT Myra.

Compress ONE ended scan into a short STORY memory for future sessions.

INPUT: labelled chat log (sender:/receiver:/myra: lines) from ONE scan only.
OUTPUT: plain text. No markdown. No emojis. No bullet transcript dump.

REQUIRED FORMAT (exact headers, this order):

THREAD: Sender | Receiver

STORY:
Write 4–8 short sentences as a narrative of what happened this scan.
Style example: "Sender Chetan. Gift for his sister Nayna on her birthday. Chetan said Nayna is very sweet and loves Naruto. Myra asked what else she likes..."
Rules:
- ONLY facts clearly present in the log. Do NOT invent names, relationships, gifts, occasions, or preferences.
- Prefer user (sender:/receiver:) facts as the spine of the story.
- Mention Myra only lightly (e.g. what she asked next) — do not paste full Myra monologues.
- If the user only said hello / almost nothing: write a thin honest story (e.g. "Sender just arrived; name not shared yet.").
- Keep it readable for a future Myra session — memory, not a chat replay.
- Do NOT dump every line. Do NOT add EMOTIONS / FACTS / OPEN THREADS sections.

OPEN HOOK:
- One short line: the last unresolved question Myra asked (verbatim if present), OR "none".

BRAND PRODUCT PRAISE:
- yes ONLY if user praised the physical product: RICHERA card, bracelet, box, packaging, gift design.
- NOT girlfriend/boyfriend praise, NOT Myra praise, NOT generic love.
- If yes: BRAND PRODUCT PRAISE: yes | "exact user words from log"
- If none: BRAND PRODUCT PRAISE: none

SCOPE: This scan's log only. Do not merge other scans.`

let geminiClient = null

async function getGeminiClient() {
  if (USE_API_PROXY || !GEMINI_API_KEY) return null
  if (!geminiClient) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    geminiClient = new GoogleGenerativeAI(GEMINI_API_KEY)
  }
  return geminiClient
}

function isSummarizeConfigured() {
  return USE_API_PROXY || Boolean(GEMINI_API_KEY)
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
  if (isLast && closingQuestion) {
    return closingQuestion.length <= 220
      ? `${t.slice(0, 120).trim()}... ${closingQuestion}`
      : closingQuestion
  }

  if (t.length <= 140) return t

  const body = t.slice(0, 110).trim().replace(/[.,…]+$/, '')
  if (closingQuestion) return `${body}... ${closingQuestion}`
  return `${body}...`
}

/**
 * Local fallback story when Gemini summary is unavailable.
 * Built only from log facts — no invention.
 */
export function buildLocalStorySummary({
  roleKey = 'sender',
  userLines = [],
  myraLines = [],
} = {}) {
  const threadLabel = roleKey === 'receiver' ? 'Receiver' : 'Sender'
  const who = roleKey === 'receiver' ? 'Receiver' : 'Sender'
  const facts = userLines.map((line) => String(line ?? '').trim()).filter(Boolean)
  const lastMyra = myraLines.length ? String(myraLines[myraLines.length - 1] ?? '').trim() : ''
  const openHook = extractMyraClosingQuestion(lastMyra) || 'none'

  let story
  if (!facts.length) {
    story = `${who} opened a scan but shared almost nothing yet. Name and gift details unknown.`
  } else if (facts.length === 1) {
    story = `${who} said: "${facts[0]}". Conversation just started.`
  } else {
    const head = facts.slice(0, 4).map((f) => `"${f}"`).join('; ')
    const more = facts.length > 4 ? ` Plus ${facts.length - 4} more user note(s).` : ''
    story = `${who} shared these beats this scan: ${head}.${more}`
    if (openHook !== 'none') {
      story += ` Myra's last open ask was about continuing from there.`
    }
  }

  return [
    `THREAD: ${threadLabel}`,
    '',
    'STORY:',
    story,
    '',
    'OPEN HOOK:',
    openHook,
    '',
    'BRAND PRODUCT PRAISE:',
    'none',
  ].join('\n')
}

async function requestSummary(userPrompt) {
  if (USE_API_PROXY) {
    const payload = await askGeminiViaProxy({
      userPrompt,
      systemInstruction: MYRA_SESSION_SUMMARY_SYSTEM,
      models: SUMMARY_MODEL_CHAIN,
      generationConfig: { temperature: 0.25, topP: 0.85, maxOutputTokens: 900 },
    })
    return {
      text: payload.text,
      model: payload.model,
      usage: payload.usage,
    }
  }

  const client = await getGeminiClient()
  if (!client) return null

  let lastError = null
  for (const modelName of SUMMARY_MODEL_CHAIN) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction: MYRA_SESSION_SUMMARY_SYSTEM,
        generationConfig: { temperature: 0.25, topP: 0.85, maxOutputTokens: 900 },
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

  const userPrompt = `Write session ${scanNumber} STORY summary.

${ctx.whoLine}

THIS SCAN CHAT LOG ONLY:
${log}

Output THREAD: ${ctx.threadLabel}
Then STORY (4–8 sentences, only real log facts — like "Chetan bought this for sister Nayna's birthday; she likes Naruto...").
Then OPEN HOOK (last Myra question verbatim, or none).
Then BRAND PRODUCT PRAISE (product only, not GF/BF).
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

/** Pull STORY body from a summary block (story format or legacy). */
export function extractStoryFromSummary(summaryText) {
  const text = String(summaryText ?? '').trim()
  if (!text) return ''

  const storyMatch = text.match(
    /STORY:\s*\n([\s\S]*?)(?=\n\s*OPEN HOOK:|\n\s*BRAND PRODUCT PRAISE:|\n\s*USER SAID:|\n\s*MYRA SAID:|$)/i,
  )
  if (storyMatch?.[1]?.trim()) return storyMatch[1].trim()

  // Legacy transcript-style summaries — keep as-is for old rows.
  return text
    .replace(/\n\s*BRAND PRODUCT PRAISE:[\s\S]*$/i, '')
    .trim()
}
