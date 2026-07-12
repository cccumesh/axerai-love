const REQUIRED = ['GEMINI_API_KEY']

const RECOMMENDED = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']

const OPTIONAL = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

if (process.env.NETLIFY !== 'true') {
  console.log('[verify-netlify-env] Skipping — local build')
  process.exit(0)
}

const missing = REQUIRED.filter((key) => !String(process.env[key] ?? '').trim())

if (missing.length) {
  console.error('\n[Axerai] Netlify build blocked — missing server environment variables:\n')
  for (const key of missing) {
    console.error(`  • ${key}`)
  }
  console.error(
    '\nFix: Netlify dashboard → Environment variables → add GEMINI_API_KEY (no VITE_ prefix), then Deploys → Trigger deploy.\n',
  )
  process.exit(1)
}

const missingRecommended = RECOMMENDED.filter((key) => !String(process.env[key] ?? '').trim())
if (missingRecommended.length) {
  console.warn('[verify-netlify-env] Optional — ElevenLabs server keys missing; Myra will use browser TTS:')
  for (const key of missingRecommended) {
    console.warn(`  • ${key}`)
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
