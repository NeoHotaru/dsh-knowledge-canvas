/**
 * Which session an agent belongs to, as a string, or an empty string.
 *
 * Two questions live here and were being answered by one expression, which is what broke every IM session.
 *
 * Identity: any non-empty string. A QQ session's id is `im:qq_…:dm:…:…` — colons included — and the regex
 * that used to guard this rejected it outright, so per-session switches silently did nothing on every IM
 * session from the day the regex was written. The probe found it in one line:
 *
 *     session id: typeof=string value="im:qq_…" usable="" agent.id="im:qq_…"
 *
 * Path safety: colons cannot appear in a Windows file name. That constraint belongs where the file name is
 * built, not here — see sessionFileStem, which encodes rather than rejects.
 *
 * An empty string still means "no session", and every caller still reads that as "use the workspace
 * default", so an unrecognised shape degrades to the old behaviour.
 */
export function sessionIdOf(subject) {
  // Either an agent or a tool's exec, which carries the agent one level down. Passing the wrong one used to
  // return an empty string in silence, and the only symptom was a byline that never appeared.
  const agent = subject && subject.agent ? subject.agent : subject
  const candidates = [
    agent && agent.session && agent.session.header && agent.session.header.id,
    agent && agent.session && agent.session.id,
    agent && agent.session && agent.session.header && agent.session.header.sessionId,
    // A second source, and the one the probe showed is populated for an IM session even when the header is
    // not readable yet. Fallbacks are only useful if they are tried.
    agent && agent.id,
    agent && agent.sessionId,
  ]
  for (const value of candidates) {
    // Identity, so the only requirement is that it is a non-empty string. The length cap stays: it is a
    // sanity bound on a value that becomes a cache key and a file name, not a character whitelist.
    if (typeof value === 'string' && value.length > 0 && value.length <= 200) return value
  }
  return ''
}

/**
 * A session id as something that can be a file name.
 *
 * Colons, slashes, backslashes and the rest are legal in an id and illegal in a path, so they are
 * percent-encoded rather than refused: refusing meant an IM session could not have its own selection at all.
 * Everything a normal session id contains — letters, digits, dot, dash, underscore — passes through
 * untouched, so existing files keep their names.
 */
export function sessionFileStem(sessionId) {
  const id = String(sessionId || '')
  if (!id) throw new Error('a session file needs a session id')
  const safe = id.replace(/[^A-Za-z0-9._-]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
  // The encoded form is all safe characters, so this is a bound rather than a filter.
  if (safe.length > 400) throw new Error('session id is too long to name a file')
  return safe
}
