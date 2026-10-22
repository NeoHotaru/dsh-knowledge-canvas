import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** This bundle has exactly one Cordis insert row. Its resolver name must exist in a clean install. */
export function validateBundleContract(pkg, patch) {
  const names = [...patch.matchAll(/^\s+name:\s*['"]?([^\s'"#]+)['"]?\s*(?:#.*)?$/gm)].map((m) => m[1])
  const problems = []
  if (names.length !== 1 || names[0] !== pkg.name) {
    problems.push(`cordis.patch.yml must reference the published package ${pkg.name}, got ${names.join(', ') || '(none)'}`)
  }
  if (pkg.dsh?.client?.immediately === true) {
    problems.push('this injected client must not use immediately:true (duplicate factory registration; issue #7)')
  }
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('bundle patch must be ./cordis.patch.yml')
  const inject = pkg.dsh?.client?.inject
  for (const dep of ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar']) {
    if (!Array.isArray(inject) || !inject.includes(dep)) problems.push(`missing client dependency ${dep}`)
  }
  return problems
}

export function readBundleContract(directory) {
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  const patch = readFileSync(resolve(directory, 'cordis.patch.yml'), 'utf8')
  return { pkg, patch, problems: validateBundleContract(pkg, patch) }
}
