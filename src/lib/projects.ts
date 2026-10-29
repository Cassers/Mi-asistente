import { useSyncExternalStore } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { timedFetch } from './timings'

export type Application = 'opencode' | 'codex' | 'claude' | 'antigravity'
export type ApplicationInfo = { id: Application; name: string; available: boolean; reason?: string }
export type Project = { id: string; name: string; directory: string; application: Application; serverURL: string }
export type OpenProjectInput = { directory: string; application?: Application; serverURL?: string; username?: string; password?: string }
type State = { applications?: ApplicationInfo[]; projects: Project[]; selected: Project | null; loading: boolean; error: string; available: boolean; defaultServerURL: string }
const KEY = 'assistant.project.selection'
let state: State = { projects: [], selected: null, loading: false, error: '', available: true, defaultServerURL: '' }
const listeners = new Set<() => void>()
let initialized = false
let generation = 0
let selectionRevision = 0
let pending: Promise<void> | undefined
let opening: Promise<Project> | undefined
const snapshot = () => state
const publish = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
export const selectedProject = () => state.selected
export const projectMode = () => state.available
export function subscribeProjects(fn: () => void) {
  listeners.add(fn)
  if (!initialized) void refreshProjects()
  return () => { listeners.delete(fn) }
}
export const useProjects = () => useSyncExternalStore(subscribeProjects, snapshot, snapshot)

function savedID() {
  try { return localStorage.getItem(KEY) || '' } catch { return '' }
}
function persist(id: string) {
  try { localStorage.setItem(KEY, id) } catch { /* Selection works without storage. */ }
}
function project(value: unknown): Project {
  const p = value as Partial<Project> | null
  if (!p || !p.id || !p.name || !p.directory || typeof p.id !== 'string' || typeof p.name !== 'string' ||
    typeof p.directory !== 'string' || !['opencode', 'codex', 'claude', 'antigravity'].includes(p.application || '') || typeof p.serverURL !== 'string') {
    throw new Error('La respuesta del proyecto no es válida.')
  }
  // Explicit allowlist: credentials from a response never enter the store.
  return { id: p.id, name: p.name, directory: p.directory, application: p.application as Application, serverURL: p.serverURL }
}
async function responseData(res: Response) {
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'No se pudo completar la solicitud de proyectos.')
  return data
}

export function refreshProjects(): Promise<void> {
  if (opening) return opening.then(() => {}, () => {})
  if (pending) return pending
  initialized = true
  const request = ++generation
  const revision = selectionRevision
  publish({ loading: true, error: '' })
  const task = (async () => {
    try {
      const res = await timedFetch('project.list', `${BRIDGE_HTTP_URL}/projects`, { headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10000) })
      if (request !== generation) return
      if (res.status === 404) {
        publish({ projects: [], selected: null, loading: false, error: '', available: false })
        return
      }
      const data = await responseData(res)
      if (!Array.isArray(data?.projects) || typeof data.defaultServerURL !== 'string') throw new Error('La lista de proyectos no es válida.')
      const projects = data.projects.map(project) as Project[]
      if (request !== generation) return
      const id = state.selected?.id || savedID()
      let selected = projects.find(p => p.id === id) || null
      // Selection made after this read began takes precedence over its snapshot.
      if (revision !== selectionRevision && state.selected) {
        selected = state.selected
        if (!projects.some(p => p.id === selected!.id)) projects.unshift(selected)
      }
      const applications = Array.isArray(data.applications) ? data.applications.filter((app: ApplicationInfo) => ['claude','antigravity'].includes(app?.id) && typeof app.available === 'boolean') : []
      publish({ projects, selected, applications, defaultServerURL: data.defaultServerURL, available: true, loading: false, error: '' })
    } catch (error) {
      if (request === generation) publish({ loading: false, error: error instanceof Error ? error.message : 'No se pudieron cargar los proyectos.' })
    }
  })()
  pending = task
  void task.finally(() => { if (pending === task) pending = undefined })
  return task
}

export function selectProject(id: string) {
  const selected = state.projects.find(p => p.id === id)
  if (!selected) return
  selectionRevision++
  persist(id)
  publish({ selected, error: '' })
}

/** Reuse a registered application/endpoint before opening another native connection. */
export async function switchApplication(application: Application): Promise<Project> {
  const selected = state.selected
  if (!selected) throw new Error('Abre una carpeta antes de elegir la aplicación.')
  if (!['opencode', 'codex', 'claude', 'antigravity'].includes(application)) throw new Error('Aplicación no compatible.')
  if (selected.application === application) return selected
  const existing = state.projects.find(project => project.application === application && project.directory === selected.directory)
  if (existing) { selectProject(existing.id); return existing }
  return openProject({ directory: selected.directory, application, ...(application === 'opencode' ? { serverURL: state.defaultServerURL } : {}) })
}

export function openProject(input: OpenProjectInput): Promise<Project> {
  if (opening) return opening
  initialized = true
  ++generation
  pending = undefined
  const revision = selectionRevision
  publish({ loading: true, error: '' })
  const task = (async () => {
    try {
      const directory = input.directory.trim()
      if (!directory) throw new Error('Escribe la ruta del proyecto.')
      const body: OpenProjectInput = { directory }
      if (input.application !== undefined) {
        if (!['opencode', 'codex', 'claude', 'antigravity'].includes(input.application)) throw new Error('Aplicación no compatible.')
        body.application = input.application
      }
      if ((!input.application || input.application === 'opencode') && input.serverURL?.trim()) body.serverURL = input.serverURL.trim()
      if ((!input.application || input.application === 'opencode') && input.username?.trim()) body.username = input.username.trim()
      if ((!input.application || input.application === 'opencode') && input.password) body.password = input.password
      const res = await timedFetch('project.open', `${BRIDGE_HTTP_URL}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
      const opened = project((await responseData(res))?.project)
      const projects = [opened, ...state.projects.filter(p => p.id !== opened.id)]
      if (revision === selectionRevision) {
        selectionRevision++
        persist(opened.id)
        publish({ projects, selected: opened, loading: false, error: '', available: true })
      } else publish({ projects, loading: false, error: '', available: true })
      return opened
    } catch (error) {
      let message = error instanceof Error ? error.message : 'No se pudo abrir el proyecto.'
      if ((!input.application || input.application === 'opencode') && input.password) message = message.split(input.password).join('[oculta]')
      publish({ loading: false, error: message })
      throw new Error(message)
    }
  })()
  opening = task
  void task.then(() => { if (opening === task) opening = undefined }, () => { if (opening === task) opening = undefined })
  return task
}

export function projectURL(path: string) {
  if (!state.selected) return path
  const hashAt = path.indexOf('#')
  const base = hashAt < 0 ? path : path.slice(0, hashAt)
  const hash = hashAt < 0 ? '' : path.slice(hashAt)
  return `${base}${base.includes('?') ? '&' : '?'}project=${encodeURIComponent(state.selected.id)}${hash}`
}
