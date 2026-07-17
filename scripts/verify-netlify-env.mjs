const REQUIRED = ['VITE_GEMINI_API_KEY']

const RECOMMENDED = ['VITE_ELEVENLABS_API_KEY', 'VITE_ELEVENLABS_VOICE_ID']

const OPTIONAL = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']
const DASHBOARD_OPTIONAL = ['VITE_DASHBOARD_PASSWORD', 'VITE_DASHBOARD_PATH']

function has(key) {
  return Boolean(String(process.env[key] ?? '').trim())
}

if (process.env.NETLIFY !== 'true') {
  console.log('[verify-netlify-env] Skipping — local build')
  process.exit(0)
}

const missing = REQUIRED.filter((key) => !has(key))

if (missing.length) {
  console.error('\n[Axerai] Netlify build blocked — missing environment variables:\n')
  for (const key of missing) {
    console.error(`  • ${key}`)
  }
  console.error(
    '\nFix: Netlify → Environment variables → add VITE_GEMINI_API_KEY (Build scope), then Deploys → Trigger deploy.\n',
  )
  process.exit(1)
}

const missingRecommended = RECOMMENDED.filter((key) => !has(key))
if (missingRecommended.length) {
  console.warn('[verify-netlify-env] Optional — ElevenLabs keys missing; Myra will use browser TTS:')
  for (const key of missingRecommended) {
    console.warn(`  • ${key}`)
  }
}

const missingOptional = OPTIONAL.filter((key) => !has(key))
if (missingOptional.length) {
  console.warn('[verify-netlify-env] Optional — Supabase keys missing; ledger/dashboard off:')
  for (const key of missingOptional) {
    console.warn(`  • ${key}`)
  }
}

const missingDashboard = DASHBOARD_OPTIONAL.filter((key) => !has(key))
if (missingDashboard.length) {
  console.warn('[verify-netlify-env] Dashboard lock — set secret path + password on Netlify:')
  for (const key of missingDashboard) {
    console.warn(`  • ${key}`)
  }
}

console.log('[verify-netlify-env] Client API keys OK — production build can proceed.')
