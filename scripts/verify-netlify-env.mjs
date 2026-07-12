const REQUIRED_ANY = [
  ['GEMINI_API_KEY', 'VITE_GEMINI_API_KEY'],
]

const RECOMMENDED_ANY = [
  ['ELEVENLABS_API_KEY', 'VITE_ELEVENLABS_API_KEY'],
  ['ELEVENLABS_VOICE_ID', 'VITE_ELEVENLABS_VOICE_ID'],
]

const OPTIONAL = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

function hasAny(keys) {
  return keys.some((key) => String(process.env[key] ?? '').trim())
}

if (process.env.NETLIFY !== 'true') {
  console.log('[verify-netlify-env] Skipping — local build')
  process.exit(0)
}

const missing = REQUIRED_ANY.filter((group) => !hasAny(group))

if (missing.length) {
  console.error('\n[Axerai] Netlify build blocked — missing environment variables:\n')
  for (const group of missing) {
    console.error(`  • ${group.join(' or ')}`)
  }
  console.error(
    '\nFix: Netlify dashboard → Environment variables → add GEMINI_API_KEY (or VITE_GEMINI_API_KEY), then Deploys → Trigger deploy.\n',
  )
  process.exit(1)
}

if (hasAny(['VITE_GEMINI_API_KEY']) && !hasAny(['GEMINI_API_KEY'])) {
  console.warn('[verify-netlify-env] Tip: rename VITE_GEMINI_API_KEY → GEMINI_API_KEY so keys stay off the public bundle.')
}

const missingRecommended = RECOMMENDED_ANY.filter((group) => !hasAny(group))
if (missingRecommended.length) {
  console.warn('[verify-netlify-env] Optional — ElevenLabs keys missing; Myra will use browser TTS:')
  for (const group of missingRecommended) {
    console.warn(`  • ${group.join(' or ')}`)
  }
}

const missingOptional = OPTIONAL.filter((key) => !String(process.env[key] ?? '').trim())
if (missingOptional.length) {
  console.warn('[verify-netlify-env] Optional — Supabase keys missing; ledger/dashboard off:')
  for (const key of missingOptional) {
    console.warn(`  • ${key}`)
  }
}

console.log('[verify-netlify-env] Server API keys OK — production build can proceed.')
