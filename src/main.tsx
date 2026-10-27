import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { observeApplication } from './lib/timings'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
const stopObserving = observeApplication()
if (import.meta.hot) import.meta.hot.dispose(stopObserving)
