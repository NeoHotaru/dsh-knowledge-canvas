// What npm will actually ship, checked before anyone publishes.
//
// The failure this exists for: `files[]` decides the tarball, GitHub shows the repository, and the two are not the same tree. The
// Chinese README and the changelog were linked from README.md and were not in `files[]` — invisible in the repo, missing on npm, for
// three releases. So: ask the packer, then compare against what the docs promise.
//
// A check that cannot fail is not a check, so this one exits non-zero and names what is missing.

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const failures = []

const reported = (ok, what, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (ok || !detail ? '' : '  <- ' + detail))
  if (!ok) failures.push(what)
}

const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: here, encoding: 'utf-8' }))[0]
const shipped = new Set(packed.files.map((entry) => entry.path))
const manifest = JSON.parse(await readFile(join(here, 'package.json'), 'utf-8'))

// 1. Everything `files[]` names by hand must be in the tarball.
const named = manifest.files.filter((entry) => !entry.endsWith('/') && !entry.includes('*'))
const lost = named.filter((name) => !shipped.has(name))
reported(lost.length === 0, 'every file the package names is packed', lost.join(', '))

// 2. Every local markdown link in the README has to survive the trip, or npm shows a dead link.
const readme = await readFile(join(here, 'README.md'), 'utf-8')
const linked = [...readme.matchAll(/\]\(([^)#:]+\.md)\)/g)].map((match) => match[1])
const dangling = linked.filter((name) => !shipped.has(name))
reported(dangling.length === 0, 'README links point at files that ship', dangling.join(', '))

// 3. The entry points a plugin cannot live without.
for (const required of ['index.js', 'client.js', 'package.json', 'lib/seed.js']) {
  reported(shipped.has(required), required + ' is packed')
}

// 4. An empty or tiny tarball means the glob or the entry points broke.
reported(packed.files.length >= 30, 'the tarball has the whole plugin', String(packed.files.length) + ' files')

if (failures.length > 0) {
  console.log('\n' + failures.length + ' problem(s): the package does not match the tree.')
  process.exit(1)
}
console.log('\nnpm would ship ' + packed.files.length + ' files, and they match the tree.')
