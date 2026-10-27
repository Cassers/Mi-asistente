import { storeAudioParts, restoreAudioParts, audioFetch, PURPOSE_HEADER } from './native-audio-wire.mjs'

/** Instance-scoped adapter. OpenCode still owns context, tools, auth and SSE. */
export default async function MiAsistenteAudio() {
  const registry = new Map()
  return {
    config: async config => {
      config.provider ||= {}
      for (const id of ['opencode', 'opencode-go', 'google']) {
        config.provider[id] ||= {}
        config.provider[id].options ||= {}
        const options = config.provider[id].options
        options.fetch = audioFetch(options.fetch || fetch, registry)
      }
    },
    'chat.message': async (_input, output) => { storeAudioParts(output.parts, registry) },
    'experimental.chat.messages.transform': async (_input, output) => { restoreAudioParts(output.messages, registry) },
    'chat.headers': async (input, output) => {
      output.headers[PURPOSE_HEADER] = ['title', 'compaction', 'summary'].includes(input.agent?.name) ? 'auxiliary' : 'conversation'
    },
    dispose: async () => { registry.clear() },
  }
}
