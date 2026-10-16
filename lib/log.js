/**
 * The host half's log.
 *
 * A host-side failure is invisible from the Web UI: a tool simply never appears, and nothing
 * distinguishes "this half never loaded" from "registration was rejected". One file answers
 * that after a single restart. It is also where prompt-assembly timing is recorded, because
 * that bug class only shows up on a Session's very first turn.
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the host half records what it did. */
export const LOG_PATH = join(process.env.DSH_HOME || tmpdir(), 'dsh-knowledge-tree-host.log')

/** Append one line. Never throws: a log that cannot be written must not take the plugin down. */
export function log(line) {
  const stamp = new Date().toISOString()
  try {
    appendFileSync(LOG_PATH, `${stamp}  ${line}\n`, 'utf8')
  } catch {
    // Ignored on purpose.
  }
}

/** One error as a single readable line, with enough stack to name the failing layer. */
export function describeError(error) {
  const message = (error && error.message) || String(error)
  const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 6).join(' | ') : ''
  return stack ? `${message}  [${stack}]` : message
}
