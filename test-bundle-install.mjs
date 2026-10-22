import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, execFileSync } from 'node:child_process'
import { readBundleContract, validateBundleContract } from './scripts/bundle-contract.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const { pkg, patch, problems } = readBundleContract(root)
assert.deepEqual(problems, [])
// The exact two 0.4.1 defects must fail independently, before another release.
assert.match(validateBundleContract(pkg, patch.replace('name: dsh-knowledge-canvas', 'name: dsh-knowledge-tree')).join('\n'), /published package/)
const duplicate = structuredClone(pkg)
duplicate.dsh.client.immediately = true
assert.match(validateBundleContract(duplicate, patch).join('\n'), /duplicate factory/)

const temp = mkdtempSync(join(tmpdir(), 'knowledge-install-'))
try {
  const env = { ...process.env, npm_config_cache: join(temp, 'cache'), npm_config_update_notifier: 'false' }
  // npm 11 forwards its script allowlist through lifecycle env, then rejects that same env as a CLI
  // option in a nested project install. This fixture always ignores scripts; leave user config intact.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
  const packed = JSON.parse(execSync(`npm pack --json --pack-destination "${temp}"`, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]
  const fixture = join(temp, 'profile')
  mkdirSync(fixture)
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', dsh: { profile: { bundles: [pkg.name] } } }))
  execSync(`npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false "${join(temp, packed.filename)}"`, { cwd: fixture, env, stdio: 'pipe' })
  const installed = join(fixture, 'node_modules', pkg.name)
  assert.deepEqual(readBundleContract(installed).problems, [])
  const shipped = new Set(packed.files.map((f) => f.path))
  for (const needed of ['index.js', 'client.js', 'cordis.patch.yml', 'lib/routes.js', 'lib/store.js', 'lib/office.js', 'lib/seed.js']) assert.ok(shipped.has(needed), needed)
  for (const stale of ['lib/client.js', 'lib/index.js', 'lib/patch.js', 'routes.js', 'tools.js']) assert.ok(!shipped.has(stale), stale)
  // Resolve by the package name from an otherwise empty profile, not via a development-tree file import.
  const probe = `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const host = await import('dsh-knowledge-canvas');
assert.equal(typeof host.apply,'function');
assert.equal(host.name,'dsh-knowledge-tree');
const factories = new Map();
globalThis.window = {__ModuleLoader__:{load(spec){
 assert.ok(!factories.has(spec.id),'duplicate factory registration');factories.set(spec.id,spec);
}}};
await import('dsh-knowledge-canvas/client');
assert.equal(factories.size,1);
assert.equal(factories.get('dsh-knowledge-tree').id,host.name);
const profile=JSON.parse(readFileSync('package.json','utf8'));
assert.ok(profile.dsh.profile.bundles.includes('dsh-knowledge-canvas'));
console.log('packed host import and single client factory registration passed');`
  const probePath = join(fixture, 'probe.mjs')
  writeFileSync(probePath, probe)
  execFileSync(process.execPath, [probePath], { cwd: fixture, stdio: 'pipe' })
  console.log(`bundle install: both historical manifest regressions rejected; clean offline npm tarball install, published-name host/client imports, single factory and runtime file coverage passed (${packed.entryCount} files)`)
} finally {
  assert.equal(dirname(realpathSync(temp)), realpathSync(tmpdir()))
  assert.ok(basename(temp).startsWith('knowledge-install-'))
  rmSync(temp, { recursive: true, force: true })
}
