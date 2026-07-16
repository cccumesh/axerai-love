/**
 * Dev helper — simulates Netlify gemini.mjs (server-side, no browser Referer).
 * Run: npm run test:gemini-proxy
 *
 * If this fails but npm run dev works → key has HTTP referrer restriction; use unrestricted GEMINI_API_KEY on Netlify.
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

function loadDotEnv() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!(key in process.env)) process.env[key] = value
  }
}

function sanitizeApiKey(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, '')
}

loadDotEnv()

const apiKey = sanitizeApiKey(process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY)
const model = 'gemini-3.1-flash-lite'

if (!apiKey) {
  console.error('No GEMINI_API_KEY or VITE_GEMINI_API_KEY in .env')
  process.exit(1)
}

console.log(`[test-gemini-proxy] Server-style call (like Netlify) → ${model}`)

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
    generationConfig: { temperature: 0 },
  }),
})

const body = await response.text()
if (!response.ok) {
  console.error(`\nFAILED HTTP ${response.status}`)
  console.error(body.slice(0, 400))
  if (body.toLowerCase().includes('api key')) {
    console.error(
      '\nLikely fix: Google AI Studio → your API key → Application restrictions → None\n' +
        'Then set GEMINI_API_KEY on Netlify (unrestricted) and redeploy.\n' +
        'Browser localhost works with referrer-restricted keys; Netlify server calls do not.',
    )
  }
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(body)
} catch {
  console.error('Invalid JSON from Gemini')
  process.exit(1)
}

const text = (payload.candidates ?? [])
  .flatMap((c) => c.content?.parts ?? [])
  .map((p) => p.text ?? '')
  .join('')
  .trim()

console.log(`\nSUCCESS — Gemini replied: ${text.slice(0, 80)}`)
console.log('If this passes but Netlify fails, check Netlify env GEMINI_API_KEY matches and redeploy.')
