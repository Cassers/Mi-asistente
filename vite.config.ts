import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const bridgePort = Number(env.JARVIS_BRIDGE_PORT || 8787)
  if (!Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535) {
    throw new Error('JARVIS_BRIDGE_PORT inválido')
  }
  return {
  plugins: [react(), {
    name: 'local-bridge-csp',
    transformIndexHtml(html) {
      // Keep explicit loopback origins, including alternate instance ports.
      return html.replaceAll('http://localhost:8787', `http://localhost:${bridgePort}`)
        .replaceAll('http://127.0.0.1:8787', `http://127.0.0.1:${bridgePort}`)
    },
  }],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    host: '127.0.0.1',
    strictPort: true,
    port: Number(env.PORT) || 5173,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
  }
})
