/** Normalize Gemini usageMetadata from API / proxy responses. */
export function normalizeGeminiUsage(raw) {
  const promptTokens = Number(raw?.promptTokenCount ?? raw?.promptTokens ?? raw?.prompt ?? 0) || 0
  const outputTokens =
    Number(raw?.candidatesTokenCount ?? raw?.outputTokens ?? raw?.output ?? 0) || 0
  const totalTokens =
    Number(raw?.totalTokenCount ?? raw?.totalTokens ?? raw?.total ?? 0) ||
    promptTokens + outputTokens

  return {
    promptTokens,
    outputTokens,
    totalTokens,
  }
}

export function usageFromResponse(response) {
  return normalizeGeminiUsage(response?.usageMetadata)
}
