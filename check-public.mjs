// Things that must never appear in this repository, checked before it can be published.
//
// The repository is public and this is not a garden: a path from my own machine, an address, a node id from my own knowledge
// base — each of them means something to me and nothing to a reader. Two of these shipped (a local directory name used as the
// package name, and `o14` as an example id), so the rule now runs as a check instead of living in a commit message.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git'])

// Each rule says what it is for, because a check nobody understands gets deleted.
const RULES = [
  { name: 'local absolute path', pattern: /[A-Za-z]:\\(?:Users|DeepSeekHarness|Aconnada|work|codex-work)\\/,
    why: 'a path on one machine; readers have nothing at it' },
  { name: 'personal email', pattern: /[\w.+-]+@(?:gmail|qq|outlook|hotmail)\.com/,
    why: 'an address in a public file is an invitation for scrapers' },
  { name: 'working-notes marker', pattern: /\bHANDOFF\b|before-(?:agent|source)-fix/,
    why: 'my own working files do not belong in the published tree' },
  // Only prose: `o14` in a Markdown file is a node in *my* base, and a reader has no such base. Code and tests may use any id
  // they like — `n1` there is a fixture, not a reference to something private.
  { name: 'an id from a base the reader does not have', pattern: /\bo\d{1,3}\b/, prose: true,
    why: 'a node id from a knowledge base the reader does not have' },
]

const problems = []
for (const name of readdirSync(ROOT)) {
  if (SKIP_DIRS.has(name)) continue
  const path = join(ROOT, name)
  const stats = statSync(path)
  if (!stats.isFile()) continue
  if (!/\.(?:md|mjs|js|json|yml|yaml|txt)$/.test(name)) continue
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  for (const rule of RULES) {
    lines.forEach((line, index) => {
      if (rule.prose && !name.endsWith('.md')) return
      if (rule.pattern.test(line)) {
        problems.push(`${name}:${index + 1}  ${rule.name} — ${rule.why}\n    ${line.trim().slice(0, 100)}`)
      }
    })
  }
}

// The package name is not the local directory name, and getting this wrong publishes to somebody else's package.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (pkg.name !== 'dsh-knowledge-canvas') {
  problems.push('package.json: name is "' + pkg.name + '" — publishing under anything else sends it to a package that is not ours')
}

if (problems.length === 0) {
  console.log('  ok   nothing machine-specific or personal in the published files')
  process.exit(0)
}
console.log("  FAIL these do not belong in a public repository:")
for (const problem of problems) 
console.log('    ' + problem)
process.exit(1)
