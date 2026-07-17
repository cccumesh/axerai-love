const REQUIRED_SERVER = ['GEMINI_API_KEY']

const SECRET_VITE_KEYS = ['VITE_GEMINI_API_KEY', 'VITE_ELEVENLABS_API_KEY']

const RECOMMENDED_SERVER = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']

const OPTIONAL = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']
const DASHBOARD_OPTIONAL = ['VITE_DASHBOARD_PASSWORD', 'VITE_DASHBOARD_PATH']

function has(key) {
  return Boolean(String(process.env[key] ?? '').trim())
}

if (process.env.NETLIFY !== 'true') {
  console.log('[verify-netlify-env] Skipping — local build')
  process.exit(0)
}

const missingServer = REQUIRED_SERVER.filter((key) => !has(key))
if (missingServer.length) {
  console.error('\n[Axerai] Netlify build blocked — server env required for secure proxy:\n')
  for (const key of missingServer) {
    console.error(`  • ${key}  (scope: Functions + Runtime)`)
  }
  console.error(
    '\nLocal dev uses VITE_GEMINI_API_KEY in .env.\n' +
      'Netlify production uses GEMINI_API_KEY only — same value, server-side, not in browser bundle.\n',
  )
  process.exit(1)
}

const leaked = SECRET_VITE_KEYS.filter((key) => has(key))
if (leaked.length) {
  console.error('\n[Axerai] Netlify build blocked — secret keys would leak into browser bundle:\n')
  for (const key of leaked) {
    console.error(`  • Remove ${key} from Netlify`)
  }
  console.error(
    '\nMigrate: copy value to GEMINI_API_KEY / ELEVENLABS_API_KEY (no VITE_ prefix), delete VITE_ copies, redeploy.\n',
  )
  process.exit(1)
}

const missingRecommended = RECOMMENDED_SERVER.filter((key) => !has(key))
if (missingRecommended.length) {
  console.warn('[verify-netlify-env] Optional — ElevenLabs server keys missing; Myra will use browser TTS:')
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

console.log('[verify-netlify-env] Secure proxy env OK — GEMINI_API_KEY on server, no secret VITE_ keys in bundle.')
