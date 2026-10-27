import { ModelPicker } from './ModelPicker'
import { AssistantSettings } from './AssistantSettings'
import { useSpeechRate, setSpeechRate, resetSpeechRate } from '../lib/speech-settings'
import { permissionModeSnapshot, subscribePermissionMode, setPermissionMode, type PermissionMode } from '../lib/bridge'
import { useModels, chooseModel, refreshModels } from '../lib/models'
import { useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '../store'
import { usingBridge } from '../lib/brain'
import { chooseConversation, conversationSnapshot, deleteConversation, refreshConversations, subscribeConversation } from '../lib/bridge'
import { ConversationCard } from './ConversationCard'
import { ProjectPicker } from './ProjectPicker'
import { switchApplication, useProjects, type Application } from '../lib/projects'
import { TimingsPanel } from './TimingsPanel'

export function ConversationsPanel({ onStop }: { onStop?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const projects = useProjects()
  const models = useModels()
  const policy = useSyncExternalStore(subscribePermissionMode, permissionModeSnapshot)
  const rate = useSpeechRate()
  const [policyError, setPolicyError] = useState('')
  const mode = (next: PermissionMode) => {
    try { setPermissionMode(next, next === 'total'); setPolicyError('') }
    catch (err) { setPolicyError(String(err)) }
  }
  const { chat, error: bridgeError } = useSyncExternalStore(subscribeConversation, conversationSnapshot)
  const [localError, setError] = useState('')
  const [changing, setChanging] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const error = localError || bridgeError
  const phase = useStore((s) => s.phase)
  const responseBusy = chat?.busy === true || ['thinking', 'tooling', 'speaking', 'waking'].includes(phase)
  const locked = changing || Boolean(deletingId && deletingId === chat?.id && !error) || phase === 'boot' || (!projects.available && responseBusy)
  if (!usingBridge) return null
  // Legacy Claude bridges do not advertise persistent chats. Show recovery only
  // when OpenCode has announced a chat or an explicit conversation error.
  if (!chat && !error && !projects.available) return null
  const changeApplication = async (application: Application) => {
    const selected = projects.selected
    if (!selected || application === selected.application || changing) return
    setChanging(true); setError('')
    try { await switchApplication(application) }
    catch (err) { setError(String(err)) }
    finally { setChanging(false) }
  }
  const applicationName = projects.selected?.application === 'codex' ? 'Codex' : 'OpenCode'
  const choose = async (id: string) => {
    setChanging(true); setError(''); setDeletingId(null)
    try { await chooseConversation(id) }
    catch (err) { setError(String(err)) }
    finally { setChanging(false) }
  }
  return <>
    <button type="button" className="surface-button settings-trigger" ref={trigger}
      aria-haspopup="dialog" aria-expanded={open} aria-controls="assistant-settings-drawer"
      onClick={() => { dialog.current?.showModal(); setOpen(true) }}>Configuración</button>
    {/* Native modal owns focus trapping, background inertness and Escape.
        Keep children mounted so closing settings preserves subscriptions/state. */}
    <dialog id="assistant-settings-drawer" className="settings-drawer" ref={dialog}
      aria-labelledby="assistant-settings-title"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => { event.preventDefault(); dialog.current?.close() }}
      onClose={() => { setOpen(false); trigger.current?.focus() }}
      onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close() }}>
      <div className="settings-drawer__content">
        <header className="settings-drawer__header">
          <h2 id="assistant-settings-title">Configuración</h2>
          <button type="button" className="surface-button" autoFocus onClick={() => dialog.current?.close()}
            aria-label="Cerrar configuración">Cerrar</button>
        </header>
        <div className="project-workspace">
          <TimingsPanel />
          {projects.available && <ProjectPicker disabled={changing || phase === 'boot'} />}
          {(chat || error) && (
            <ConversationCard removeLabel={projects.selected?.application === 'codex' ? 'Archivar' : 'Eliminar'} id={chat?.id || ''} entries={chat?.entries || []} locked={locked} error={error} observeBusy={projects.available} deleteLocked={responseBusy}
              onStop={projects.available && responseBusy ? onStop : undefined}
              status={changing ? 'Abriendo conversación…' : deletingId && !error ? 'Eliminando conversación…'
                : responseBusy ? `${applicationName} está trabajando · puedes cambiar de conversación sin detenerlo` : chat ? `Historial nativo de ${applicationName}` : 'Sin conexión · puedes crear un chat nuevo'}
              onChoose={(id) => void choose(id)} onRefresh={refreshConversations} onDelete={() => {
                if (!window.confirm(projects.selected?.application === 'codex' ? '¿Archivar esta conversación de Codex? Se conservará en el historial nativo archivado.' : '¿Borrar definitivamente esta conversación de OpenCode? Las grabaciones locales y las memorias ME/ no se borran. Esto no retira datos ya enviados al proveedor.')) return
                try { setDeletingId(chat?.id || null); deleteConversation() } catch (err) { setError(String(err)); setDeletingId(null) }
              }}>
              <ModelPicker {...models} application={projects.selected?.application} onApplication={app => { void changeApplication(app) }} locked={locked || responseBusy} onChoose={chooseModel} onRefresh={() => void refreshModels(true)} />
              <AssistantSettings {...policy} application={projects.selected?.application} rate={rate} error={policyError || policy.error} onMode={mode} onRate={setSpeechRate} onResetRate={resetSpeechRate} />
            </ConversationCard>
          )}
        </div>
      </div>
    </dialog>
  </>
}
