/**
 * The gate that has to pass before this package can be published.
 *
 * Every condition here is one that has actually gone wrong:
 *
 *   · the wrong directory was published, which is a 403 about a package that is not ours;
 *   · the README listed eight tools while the code had nine;
 *   · the seed changed but its version did not, so no existing workspace ever saw the new tutorial;
 *   · the manual was older than the seed it is generated from.
 *
 * Run by `prepublishOnly`, so npm refuses to publish while any of them is false. The point is that remembering is not part of
 * the process: a stale tree cannot be published.
 */
import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBundleContract } from './bundle-contract.mjs'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
problems.push(...readBundleContract(here).problems)

// 1. This must be the package that exists on npm.
if (pkg.name !== 'dsh-knowledge-canvas') {
  problems.push(`package name is "${pkg.name}", but the published package is dsh-knowledge-canvas`)
}

// 2. Every tool the code registers is named in the README.
const tools = readFileSync(join(here, 'lib', 'tools.js'), 'utf8')
const names = [...tools.matchAll(/name: '(knowledge_[a-z_]+)'/g)].map((match) => match[1])
const readme = readFileSync(join(here, 'README.zh.md'), 'utf8')
for (const name of new Set(names)) {
  if (!readme.includes(name)) problems.push(`README.zh.md never mentions ${name}`)
}

// 3. The manual is newer than the seed it is generated from — otherwise someone edited the tutorial and forgot to rebuild.
try {
  const seedTime = statSync(join(here, 'lib', 'seed.js')).mtimeMs
  const manualTime = statSync(join(here, 'MANUAL.md')).mtimeMs
  if (manualTime < seedTime) problems.push('lib/seed.js is newer than MANUAL.md — run node scripts/build-manual.mjs')
} catch {
  problems.push('MANUAL.md is missing')
}

// 4. The seed version went up when the tutorial changed. There is no way to ask npm what the last seed version was, so the
//    check is against the local record: a file that build-manual rewrites whenever the seed content changes.
try {
  const record = JSON.parse(readFileSync(join(here, 'scripts', '.seed-record.json'), 'utf8'))
  const version = Number(/SEED_VERSION = (\d+)/.exec(readFileSync(join(here, 'lib', 'seed.js'), 'utf8'))[1])
  const body = readFileSync(join(here, 'lib', 'seed.js'), 'utf8').length
  if (record.version !== undefined && (version < record.version || (version === record.version && body !== record.bytes))) {
    problems.push(`lib/seed.js changed but SEED_VERSION stayed ${version} — old workspaces only upgrade when the number rises`)
  }
} catch {
  // No record yet: the first publish after adding this file establishes it.
}

// 5. The version is not already on npm.
try {
  // npm is a shell command on Windows (npm.cmd). execFileSync cannot find it, and the failure was swallowed by the
  // catch below — this condition looked like it worked and never ran.
  const published = execSync(`npm view ${pkg.name}@${pkg.version} version --registry https://registry.npmjs.org`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  if (published === pkg.version) problems.push(`${pkg.name}@${pkg.version} is already published — bump the version`)
} catch {
  // Not found is the good case; a network failure must not block a publish that is otherwise fine.
}

// 6. The CHANGELOG has a section for this version, and it names every tool. Docs written after the publish are docs nobody
//    reads; a release note that does not exist yet is the signal that the work was not finished when the version was bumped.
const changelog = (() => {
  try {
    return readFileSync(join(here, 'CHANGELOG.md'), 'utf8')
  } catch {
    return ''
  }
})()
if (!changelog.includes('## ' + pkg.version)) {
  problems.push(`CHANGELOG.md has no section "## ${pkg.version}"`)
}
for (const name of new Set(names)) {
  if (!changelog.includes(name)) problems.push(`CHANGELOG.md never mentions ${name}`)
}


// 7. The English README names the tools too. Two READMEs that disagree are worse than one that is late.
try {
  const english = readFileSync(join(here, 'README.md'), 'utf8')
  for (const name of new Set(names)) {
    if (!english.includes(name)) problems.push(`README.md (English) never mentions ${name}`)
  }
} catch {
  problems.push('README.md (English) is missing')
}

// 8. What actually ships. A file that everything here reads locally can still be excluded from the tarball by files[], and the
//    failure only shows up on the machine of whoever installs it.
try {
  const packed = JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  const shipped = new Set((packed[0].files || []).map((entry) => entry.path))
  for (const needed of ['index.js', 'client.js', 'lib/office.js', 'lib/seed.js', 'MANUAL.md', 'CHANGELOG.md']) {
    if (!shipped.has(needed)) problems.push(`the package would not include ${needed} — check files[] in package.json`)
  }
} catch (error) {
  problems.push('npm pack --dry-run failed: ' + (error && error.message ? error.message : error))
}

if (problems.length > 0) {
  console.error('\n  publish refused:\n')
  for (const problem of problems) console.error('    - ' + problem)
  console.error('')
  process.exit(1)
}
console.log('  publish preconditions hold')
