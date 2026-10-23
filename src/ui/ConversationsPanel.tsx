import { ModelPicker } from './ModelPicker'
import { AssistantSettings } from './AssistantSettings'
import { useSpeechRate, setSpeechRate, resetSpeechRate } from '../lib/speech-settings'
import { permissionModeSnapshot, subscribePermissionMode, setPermissionMode, type PermissionMode } from '../lib/bridge'
import { useModels, chooseModel, refreshModels } from '../lib/models'
import { useState, useSyncExternalStore } from 'react'
import { useStore } from '../store'
import { usingBridge } from '../lib/brain'
import { chooseConversation, conversationSnapshot, deleteConversation, refreshConversations, subscribeConversation } from '../lib/bridge'
import { ConversationCard } from './ConversationCard'

export function ConversationsPanel() {
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
  const locked = changing || Boolean(deletingId && deletingId === chat?.id && !error) || ['thinking', 'tooling', 'speaking', 'waking', 'boot'].includes(phase)
  if (!usingBridge) return null
  // Legacy Claude bridges do not advertise persistent chats. Show recovery only
  // when OpenCode has announced a chat or an explicit conversation error.
  if (!chat && !error) return null
  const choose = async (id: string) => {
    setChanging(true); setError(''); setDeletingId(null)
    try { await chooseConversation(id) }
    catch (err) { setError(String(err)) }
    finally { setChanging(false) }
  }
  return (
    <ConversationCard id={chat?.id || ''} entries={chat?.entries || []} locked={locked} error={error}
      status={changing ? 'Abriendo conversación…' : deletingId && !error ? 'Eliminando conversación…'
        : locked ? 'Respuesta en curso · espera para cambiar de chat' : chat ? 'Historial guardado en este equipo' : 'Sin conexión · puedes crear un chat nuevo'}
      onChoose={(id) => void choose(id)} onRefresh={refreshConversations} onDelete={() => {
        if (!window.confirm('¿Borrar definitivamente esta conversación de OpenCode? Las grabaciones locales y las memorias ME/ no se borran. Esto no retira datos ya enviados al proveedor.')) return
        try { setDeletingId(chat?.id || null); deleteConversation() } catch (err) { setError(String(err)); setDeletingId(null) }
      }}>
      <ModelPicker {...models} locked={locked} onChoose={chooseModel} onRefresh={() => void refreshModels(true)} />
      <AssistantSettings {...policy} rate={rate} error={policyError || policy.error} onMode={mode} onRate={setSpeechRate} onResetRate={resetSpeechRate} />
    </ConversationCard>
  )
}
