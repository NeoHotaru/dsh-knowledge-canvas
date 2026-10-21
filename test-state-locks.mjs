import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNodeInject, writeNodeInject } from './lib/state.js'

const cwd = await fs.mkdtemp(join(tmpdir(), 'kb-locks-'))
const rename = fs.rename
let calls = 0
try {
  await writeNodeInject(cwd,'base','n1','index')
  fs.rename = async (...args) => {
    calls++
    if (calls <= 2) throw Object.assign(new Error('temporary lock'),{code:'EPERM'})
    return rename(...args)
  }
  syncBuiltinESMExports()
  await writeNodeInject(cwd,'base','n1','full')
  assert.equal(calls,3)
  assert.equal((await readNodeInject(cwd)).base.n1,'full')
  calls = 0
  fs.rename = async () => { calls++; throw Object.assign(new Error('persistent lock'),{code:'EBUSY'}) }
  syncBuiltinESMExports()
  await assert.rejects(writeNodeInject(cwd,'base','n1','index'),{code:'EBUSY'})
  assert.equal(calls,6,'retry count is bounded')
  assert.equal((await readNodeInject(cwd)).base.n1,'full','old destination remains intact')
  assert.ok(!(await fs.readdir(join(cwd,'.dsh-knowledge','.settings'))).some(n=>n.endsWith('.tmp')))
  calls = 0
  fs.rename = async () => { calls++; throw Object.assign(new Error('disk error'),{code:'EIO'}) }
  syncBuiltinESMExports()
  await assert.rejects(writeNodeInject(cwd,'base','n1','index'),{code:'EIO'})
  assert.equal(calls,1,'unrelated errors are not retried')
  console.log('state locks: transient recovery, bounded persistent failure, intact destination and temporary cleanup passed')
} finally {
  fs.rename = rename
  syncBuiltinESMExports()
  await fs.rm(cwd,{recursive:true,force:true})
}
