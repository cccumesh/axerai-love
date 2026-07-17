import { usageFromResponse } from './geminiUsage.js'
import { VERIFY_MODEL_CHAIN } from './geminiModels.js'

const GEMINI_API_KEY = String(import.meta.env.VITE_GEMINI_API_KEY ?? '').trim()
const VERIFY_RETRIES = 1

export const RICHERA_VERIFICATION_CODE = 'R'

/** 3-layer verify outcomes from Gemini. */
export const VERIFY_FAIL_REASON = {
  REAL: 'REAL',
  PHOTO_SPOOF: 'PHOTO_SPOOF',
  NO_RICHERA: 'NO_RICHERA',
  BAD_FRAME: 'BAD_FRAME',
  UNCERTAIN: 'UNCERTAIN',
}

const VERIFY_SYSTEM = `You are the Axerai 3-layer RICHERA card verifier. Analyze ONE live camera frame.

LAYER 1 — BRAND (RICHERA text):
PASS only if the complete word RICHERA is clearly visible and readable on the product card or packaging.
FAIL if RICHERA is absent, only partial text appears (Hera, Rich, Riche, era, or any fragment), text is too blurry to read, or you must guess or infer the brand.
Never guess. Partial text is never RICHERA.

LAYER 2 — LIVENESS (real card, not a photo trick):
PASS only if this looks like a REAL physical card or box held in front of the camera right now.
FAIL if: the card appears on a phone/tablet/laptop/monitor screen, a photo of a card on another device, a printed paper photo, a screenshot, a WhatsApp/image file on a screen, visible phone bezel around a card picture, monitor glare, moiré pattern from photographing a screen, or a flat digital display showing the card instead of the physical product.

LAYER 3 — FRAME (proper scan capture):
PASS if the card or packaging is reasonably visible and centered, not an extreme crop, not random background only, and lighting allows verification.
FAIL if the card is mostly missing, the wrong object is shown, only wall/ceiling/face fills the frame, or blur/darkness blocks reading.

OUTPUT FORMAT — reply with exactly these 4 lines and nothing else:
LAYER1: PASS or FAIL
LAYER2: PASS or FAIL
LAYER3: PASS or FAIL
RESULT: REAL or PHOTO_SPOOF or NO_RICHERA or BAD_FRAME or UNCERTAIN

RESULT rules:
- REAL = all three layers PASS
- PHOTO_SPOOF = LAYER2 FAIL (even if RICHERA text is visible on a photo or screen)
- NO_RICHERA = LAYER1 FAIL
- BAD_FRAME = LAYER1 PASS and LAYER3 FAIL
- UNCERTAIN = cannot decide safely
If multiple layers fail, use this priority: PHOTO_SPOOF > NO_RICHERA > BAD_FRAME > UNCERTAIN`

const VERIFY_USER_PROMPT =
  'Run all 3 verification layers on this frame. Reply with LAYER1, LAYER2, LAYER3, and RESULT only.'

let geminiClient = null

async function getGeminiClient() {
  if (!GEMINI_API_KEY) return null
  if (!geminiClient) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    geminiClient = new GoogleGenerativeAI(GEMINI_API_KEY)
  }
  return geminiClient
}

export function isGeminiVerifyConfigured() {
  return Boolean(GEMINI_API_KEY)
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

function compressImageForVerify(dataUrl, maxSize = 768) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
      const width = Math.max(1, Math.round(img.width * scale))
      const height = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

function normalizeFailReason(value) {
  const key = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')

  if (key === 'REAL') return VERIFY_FAIL_REASON.REAL
  if (key === 'PHOTO_SPOOF' || key === 'PHOTO' || key === 'SPOOF') {
    return VERIFY_FAIL_REASON.PHOTO_SPOOF
  }
  if (key === 'NO_RICHERA' || key === 'NORICHERA' || key === 'FALSE') {
    return VERIFY_FAIL_REASON.NO_RICHERA
  }
  if (key === 'BAD_FRAME' || key === 'BADFRAME' || key === 'FRAME') {
    return VERIFY_FAIL_REASON.BAD_FRAME
  }
  if (key === 'UNCERTAIN' || key === 'UNKNOWN') return VERIFY_FAIL_REASON.UNCERTAIN
  return null
}

export function parseVerifyResponse(text) {
  const raw = String(text ?? '').trim()
  const resultMatch = raw.match(/RESULT:\s*(REAL|PHOTO[_\s-]?SPOOF|NO[_\s-]?RICHERA|BAD[_\s-]?FRAME|UNCERTAIN)/i)
  const failReason = normalizeFailReason(resultMatch?.[1]) ?? VERIFY_FAIL_REASON.UNCERTAIN

  if (failReason === VERIFY_FAIL_REASON.REAL) {
    return { verified: true, failReason: VERIFY_FAIL_REASON.REAL }
  }

  return { verified: false, failReason }
}

async function askGeminiVerify(imagePart) {
  const generationConfig = { temperature: 0, topP: 0.8 }

  const client = await getGeminiClient()
  if (!client) {
    throw new Error('Gemini not configured — add VITE_GEMINI_API_KEY for verify')
  }

  let lastError = null

  for (const modelName of VERIFY_MODEL_CHAIN) {
    for (let attempt = 1; attempt <= VERIFY_RETRIES; attempt += 1) {
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          systemInstruction: VERIFY_SYSTEM,
          generationConfig,
        })

        const parts = [
          {
            inlineData: {
              mimeType: imagePart.mimeType,
              data: imagePart.data,
            },
          },
          { text: VERIFY_USER_PROMPT },
        ]

        const result = await model.generateContent({ contents: [{ role: 'user', parts }] })
        const text = result.response.text()
        return {
          parsed: parseVerifyResponse(text),
          model: modelName,
          usage: usageFromResponse(result.response),
        }
      } catch (error) {
        lastError = error
        console.warn(`[Verify] ${modelName} attempt ${attempt} failed`, error)
      }
    }
  }

  throw lastError ?? new Error('Gemini verify failed')
}

/** Backend gate: 3-layer verify — REAL passes, else failReason for Myra dialogue. */
export async function verifyRicheraProduct(imageDataUrl) {
  const compressed = await compressImageForVerify(imageDataUrl)
  const imagePart = parseDataUrl(compressed)
  if (!imagePart) {
    throw new Error('Scan frame could not be encoded')
  }

  const { parsed, model, usage } = await askGeminiVerify(imagePart)
  const { verified, failReason } = parsed

  return {
    verified,
    verificationCode: verified ? RICHERA_VERIFICATION_CODE : null,
    failReason: verified ? VERIFY_FAIL_REASON.REAL : failReason,
    usage,
    model,
  }
}
