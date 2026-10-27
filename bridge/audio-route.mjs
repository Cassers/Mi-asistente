/** An existing credential must never be forwarded to a project-supplied endpoint. */
export function audioEndpoint({ providerID, modelID, model }) {
  const sdk = model.api?.npm
  const base = model.api?.url?.replace(/\/$/, '')
  if (providerID === 'opencode-go' || providerID === 'opencode') {
    const prefix = providerID === 'opencode-go' ? 'https://opencode.ai/inference/go/' : 'https://opencode.ai/inference/'
    if (sdk === '@ai-sdk/openai' && base === prefix + 'openai/v1') return { url: base + '/responses', kind: 'responses' }
    if (sdk === '@ai-sdk/openai-compatible' && base === prefix + 'openai/v1') return { url: base + '/chat/completions', kind: 'chat' }
    if (sdk === '@ai-sdk/google' && base === prefix + 'google/v1beta') return { url: base + '/models/' + encodeURIComponent(model.api.id || modelID) + ':generateContent', kind: 'google' }
  }
  if (providerID === 'google' && sdk === '@ai-sdk/google' && (!base || base === 'https://generativelanguage.googleapis.com/v1beta')) {
    return { url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model.api.id || modelID) + ':generateContent', kind: 'google' }
  }
  throw new Error('La conexión no permite la prueba directa de audio.')
}
