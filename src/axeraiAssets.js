import { preloadMyraModels } from './myraModel.js'
import { preloadTargetVideo } from './myraTargetVideo.js'

export const MINDAR_TARGET_PATH = '/targets.mind'
export const INTRO_LOADING_BG_PATH = '/images/richera-loading.png'
const MIN_SPLASH_MS = 1200

function preloadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve()
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
    img.src = src
  })
}

function preloadMindARTarget() {
  return fetch(MINDAR_TARGET_PATH).then((response) => {
    if (!response.ok) throw new Error(`MindAR target failed (${response.status})`)
    return response.arrayBuffer()
  })
}

/** Block intro until persona FBX, target video, AR .mind, and splash art are ready. */
export async function loadAxeraiExperienceAssets({ onProgress } = {}) {
  const startedAt = performance.now()
  const steps = [
    { weight: 5, run: () => preloadMyraModels() },
    { weight: 2, run: () => preloadTargetVideo() },
    { weight: 1, run: () => preloadMindARTarget() },
    { weight: 1, run: () => preloadImage(INTRO_LOADING_BG_PATH) },
  ]
  const totalWeight = steps.reduce((sum, step) => sum + step.weight, 0)
  let doneWeight = 0

  const report = () => {
    const pct = Math.min(99, Math.round((doneWeight / totalWeight) * 100))
    onProgress?.(pct)
  }

  report()

  for (const step of steps) {
    await step.run()
    doneWeight += step.weight
    report()
  }

  const elapsed = performance.now() - startedAt
  if (elapsed < MIN_SPLASH_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_SPLASH_MS - elapsed))
  }

  onProgress?.(100)
}
