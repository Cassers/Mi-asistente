import { useVoiceInputMode } from '../lib/voice-input-mode'
import type { Application } from '../lib/projects'
import type { ModelOption } from '../lib/models'
import { SearchableModelSelect } from './SearchableModelSelect'

const labels: Record<string, string> = { none: 'Sin razonamiento', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' }
type Props = { models: ModelOption[]; model: string; variant: string; locked: boolean; loading: boolean; error: string;
  application?: Application; onApplication?: (application: Application) => void;
  onChoose: (model: string, variant?: string) => void; onRefresh: () => void }

export function ModelPicker({ models, model, variant, locked, loading, error, onChoose, onRefresh, application = 'opencode', onApplication }: Props) {
  const applicationName = application === 'codex' ? 'Codex' : 'OpenCode'
  const voiceInput = useVoiceInputMode(application)
  const selected = models.find(m => m.id === model)
  const directHelp = 'Audio directo: cada pausa envía tu voz al modelo elegido, sin transcribirla antes. Si el modelo o formato no es compatible, se muestra un error; no se sustituye por dictado.'
  return <details className="model-picker">
    <summary><span>Aplicación, modelo y pensamiento</span><small>{applicationName} · {selected?.name || (loading ? 'Cargando modelos…' : 'Catálogo no disponible')} · {labels[variant] || variant || 'Automático'}</small></summary>
    <div className="model-picker__body">
      <label htmlFor="assistant-application">Aplicación</label>
      <select id="assistant-application" value={application} disabled={locked || !onApplication} onChange={event => onApplication?.(event.target.value as Application)} aria-describedby="application-description">
        <option value="opencode">OpenCode</option><option value="codex">Codex</option>
      </select>
      <p id="application-description">Conexión local de {applicationName}. Cambiar de aplicación abre esta carpeta con sus propias conversaciones y configuración.</p>
      <span className="surface-eyebrow">PROVEEDORES CONECTADOS</span>
      <label htmlFor="assistant-model">Modelo</label>
      <SearchableModelSelect models={models} model={model} disabled={locked || loading || !models.length}
        onChoose={id => onChoose(id)} onRefresh={onRefresh} />
      {selected && <p className={!selected.free ? 'model-picker__warning' : ''}>{selected.free ? 'Modelo gratuito según el catálogo actual.' : `Puede consumir saldo o la cuota de tu suscripción. Se usa tu cuenta configurada en ${applicationName}; no hay cambio automático de modelo.`}</p>}
      <label htmlFor="assistant-thinking">Nivel de pensamiento</label>
      <select id="assistant-thinking" value={variant} disabled={locked || loading || !selected?.variants.length} onChange={e => onChoose(model, e.target.value)}>
        <option value="">Automático (predeterminado)</option>
        {selected?.variants.map(v => <option key={v} value={v}>{labels[v] || v}</option>)}
      </select>
      <p>{selected?.id === 'native/default' ? `Se conserva la configuración, modelo y razonamiento que resuelva ${applicationName} para esta conversación.` : selected && !selected.variants.length ? `${applicationName} no expone niveles ajustables para este modelo.` : 'Más pensamiento puede aumentar el tiempo de respuesta. Se aplica a tu próxima pregunta.'}</p>
      {selected && <p className={!selected.image ? 'model-picker__warning' : ''}>{selected.id === 'native/default' ? 'La captura depende de la visión disponible en el modelo nativo del proyecto.' : selected.image ? 'Recibe la captura actual al hablar.' : 'Solo texto: no recibirá la captura automática de tu monitor.'}{selected.audio ? ' Admite entrada de audio según el catálogo.' : ''}</p>}
      {selected?.audioReason && <p className="model-picker__warning">{selected.audioReason}</p>}
      <p>{application === 'codex' ? 'Codex usa solo el dictado del navegador. Audio directo deshabilitado; se envía únicamente texto. El texto escrito funciona con cualquier ajuste de voz.' : voiceInput === 'direct'
        ? directHelp
        : 'Solo transcripción: se envía el texto del dictado del navegador, sin adjuntar el audio. Puedes cambiarlo en «Voz y permisos».'}</p>
      {error && <p className="surface-error" role="alert">{error}</p>}
      <button type="button" className="surface-button" disabled={locked || loading} onClick={onRefresh}>Actualizar modelos</button>
    </div>
  </details>
}
