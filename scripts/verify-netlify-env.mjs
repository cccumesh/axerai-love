const REQUIRED = [
  'VITE_GEMINI_API_KEY',
  'VITE_ELEVENLABS_API_KEY',
  'VITE_ELEVENLABS_VOICE_ID',
]

if (process.env.NETLIFY !== 'true') {
  console.log('[verify-netlify-env] Skipping — local build')
  process.exit(0)
}

const missing = REQUIRED.filter((key) => !String(process.env[key] ?? '').trim())

if (missing.length) {
  console.error('\n[Axerai] Netlify build blocked — missing environment variables:\n')
  for (const key of missing) {
    console.error(`  • ${key}`)
  }
  console.error(
    '\nFix: Netlify dashboard → Site configuration → Environment variables → add the keys above, then Deploys → Trigger deploy → Deploy site.\n',
  )
  process.exit(1)
}

console.log('[verify-netlify-env] All VITE_* keys present for production build.')
