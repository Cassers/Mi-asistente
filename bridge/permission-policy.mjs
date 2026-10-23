import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const FILES = new Set(['AGENTS.md', 'ME/CONFIG.json', 'ME/IDENTITY.md', 'ME/USER.md',
  'ME/MEMORIES/GENERAL.md', 'ME/MEMORIES/SPECIFIC.md', 'ME/MEMORIES/BOOTSTRAP.md'])

/** Exact, existing configuration files only; never wildcard or symlink grants. */
export async function limitedReadAllowed(request, workspace) {
  if (!workspace || request.permission !== 'read' || !Array.isArray(request.patterns) || !request.patterns.length) return false
  try {
    const root = await realpath(workspace)
    for (const pattern of request.patterns) {
      if (typeof pattern !== 'string' || /[\0*?{}]/.test(pattern) || pattern.includes('[') || pattern.includes(']') || pattern.split(/[\\/]/).includes('..')) return false
      const path = resolve(workspace, pattern)
      const local = relative(resolve(workspace), path)
      if (isAbsolute(local) || !FILES.has(local.split(sep).join('/'))) return false
      if (!(await lstat(path)).isFile() || await realpath(path) !== resolve(root, local)) return false
    }
    return true
  } catch { return false }
}
