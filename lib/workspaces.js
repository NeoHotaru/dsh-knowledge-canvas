/**
 * Which workspaces this installation can see, worked out from the session store on disk.
 *
 * The sessions service only answers for sessions that are resident in the current process, so the settings page listed
 * one workspace or three depending on what had been opened — the same request, a different answer. The store itself is
 * not like that: every workspace that ever ran a session has a directory under `<DSH_HOME>/sessions/`, named after its
 * path.
 *
 * That name is lossy, which is the only interesting part of this file: `D:\codex-work\anime-scene-builder` becomes
 * `--D-codex-work-anime-scene-builder--`, where a `-` is either a separator or a literal dash. Reconstructing it is a
 * small search, pruned by the filesystem: a branch that names a directory that is not there cannot be the real path.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** True for an existing directory. Anything else, including a permission error, is "no". */
function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Reconstruct a workspace path from a session-store directory name.
 *
 * Breadth-first with pruning rather than trying every split: at each dash the two readings are "a separator" and "a
 * dash in a name", and only the readings whose directory exists are worth following. On this machine that is three
 * names with a handful of dashes, so it finishes instantly.
 *
 * @returns the path, or null when no reading names a real directory.
 */
export function resolveSlug(slug, exists = isDir) {
  // `exists` is injectable so a test can describe a filesystem instead of borrowing this machine's, whose temp paths
  // carry dashes of their own and make the case ambiguous.
  const isDirHere = exists
  const cleaned = String(slug || '').replace(/^-+/, '').replace(/-+$/, '')
  if (!/^[A-Za-z]/.test(cleaned)) return null
  const drive = cleaned.slice(0, 1).toUpperCase() + ':'
  const rest = cleaned.slice(1)

  const walk = (current, index) => {
    if (index >= rest.length) return isDirHere(current) ? current : null
    const ch = rest[index]
    if (ch !== '-') return walk(current + ch, index + 1)
    // A dash here can be a separator: only worth following when what we have so far is a real directory.
    if (current !== drive && isDirHere(current)) {
      const deeper = walk(current + '\\', index + 1)
      if (deeper) return deeper
    } else if (current === drive && isDirHere(drive + '\\')) {
      const deeper = walk(drive + '\\', index + 1)
      if (deeper) return deeper
    }
    // Or it can be part of the name.
    return walk(current + '-', index + 1)
  }

  return walk(drive, 0)
}

/**
 * Every workspace with a knowledge base, according to the session store.
 *
 * `home` is the installation's own directory — the one holding `sessions/`. Returned as a list of absolute paths,
 * deduplicated, and including only directories that have a `.dsh-knowledge/` of their own: a workspace with no
 * knowledge base has no business appearing on a page about knowledge bases.
 */
export function workspacesWithKnowledge(home) {
  if (!home) return []
  const root = join(home, 'sessions')
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const found = []
  for (const name of names) {
    if (!name.startsWith('-')) continue
    const path = resolveSlug(name)
    if (!path || found.includes(path)) continue
    if (!isDir(join(path, '.dsh-knowledge'))) continue
    found.push(path)
  }
  return found.sort((left, right) => left.localeCompare(right))
}
