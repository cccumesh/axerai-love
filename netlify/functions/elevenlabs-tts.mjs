const MODEL_ID = 'eleven_multilingual_v2'

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const apiKey = String(process.env.ELEVENLABS_API_KEY ?? '').trim()
  const defaultVoiceId = String(process.env.ELEVENLABS_VOICE_ID ?? '').trim()

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ELEVENLABS_API_KEY missing on server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const text = String(body?.text ?? '').trim()
  const voiceId = String(body?.voiceId ?? defaultVoiceId).trim()

  if (!text) {
    return new Response(JSON.stringify({ error: 'text is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!voiceId) {
    return new Response(JSON.stringify({ error: 'ELEVENLABS_VOICE_ID missing on server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const params = new URLSearchParams({ output_format: 'mp3_44100_128' })
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?${params}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text, model_id: MODEL_ID }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return new Response(
      JSON.stringify({ error: `ElevenLabs ${response.status}: ${detail.slice(0, 240)}` }),
      { status: response.status, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const audio = await response.arrayBuffer()
  return new Response(audio, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
  })
}
