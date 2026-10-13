import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { TARGETS } from '../scripts/prepare-platform-packages.mjs'
import { stagePlatformPackages } from '../scripts/stage-platform-packages.mjs'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'computer-use-native-staging-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const version = '9.0.0-test.1'
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version }))
  const destination = path.join(directory, 'release', 'platform')
  fs.mkdirSync(destination, { recursive: true })
  const packages = TARGETS.map(target => {
    const content = Buffer.from(target)
    const filename = `zavora-ai-computer-use-mcp-${target}-${version}.tgz`
    fs.writeFileSync(path.join(destination, filename), content)
    return { target, version, filename, name: `@zavora-ai/computer-use-mcp-${target}`,
      integrity: 'sha512-' + createHash('sha512').update(content).digest('base64') }
  })
  fs.writeFileSync(path.join(destination, 'packages.json'), JSON.stringify(packages))
  return { directory, destination, packages }
}
const error = (code, summary = code) => ({ status: 1, stdout: JSON.stringify({ error: { code, summary } }), stderr: '' })

test('all six native packages are preflighted and staged with provenance from exact tarballs', t => {
  const { directory, packages } = fixture(t)
  const calls = []
  stagePlatformPackages(directory, args => {
    calls.push(args)
    return args[0] === 'view' ? error('E404') : { status: 0, stdout: '{}', stderr: '' }
  })
  assert.equal(calls.length, 12)
  assert.ok(calls.slice(0, 6).every(args => args[0] === 'view'))
  for (const [index, args] of calls.slice(6).entries()) {
    assert.equal(args[0], 'stage')
    assert.equal(args[1], 'publish')
    assert.equal(args[2], path.join(directory, 'release', 'platform', packages[index].filename))
    assert.ok(args.includes('--provenance'))
    assert.ok(args.includes('--ignore-scripts'))
  }
})

test('published native versions skip only when the packed integrity matches', t => {
  const { directory, packages } = fixture(t)
  let index = 0
  stagePlatformPackages(directory, args => {
    assert.equal(args[0], 'view')
    return { status: 0, stdout: JSON.stringify(packages[index++].integrity), stderr: '' }
  })
  assert.equal(index, 6)
})

test('a conflicting published binary or registry authentication failure prevents any staging', t => {
  const { directory, packages } = fixture(t)
  for (const fail of [() => ({ status: 0, stdout: JSON.stringify('wrong-integrity'), stderr: '' }), () => error('E401')]) {
    let index = 0
    assert.throws(() => stagePlatformPackages(directory, args => {
      assert.equal(args[0], 'view', 'no writes before the complete preflight succeeds')
      if (index++ === 2) return fail()
      return error('E404')
    }), /differs from this build|Cannot check/)
  }
  assert.equal(packages.length, 6)
})

test('local corruption, duplicate targets and version skew prevent staging', t => {
  const { directory, destination, packages } = fixture(t)
  fs.writeFileSync(path.join(destination, packages[0].filename), 'corrupted')
  assert.throws(() => stagePlatformPackages(directory, () => { throw new Error('registry must not be consulted') }), /Tarball integrity mismatch/)
  const metadata = path.join(destination, 'packages.json')
  fs.writeFileSync(metadata, JSON.stringify([...packages.slice(0, 5), packages[0]]))
  assert.throws(() => stagePlatformPackages(directory), /six distinct/)
  fs.writeFileSync(metadata, JSON.stringify(packages.map(pkg => ({ ...pkg, version: 'wrong' }))))
  assert.throws(() => stagePlatformPackages(directory), /Invalid native release metadata/)
})

test('every staging conflict fails closed and stops the remaining native publishes', t => {
  const { directory, packages } = fixture(t)
  for (const summary of ['Cannot stage previously published version', 'already staged', 'other conflict']) {
    for (const conflictAt of [0, 2]) {
      const staged = []
      assert.throws(() => stagePlatformPackages(directory, args => {
        if (args[0] === 'view') return error('E404')
        staged.push(args[2])
        return staged.length === conflictAt + 1 ? error('E409', summary) : { status: 0, stdout: '{}', stderr: '' }
      }), thrown => {
        assert.match(thrown.message, /Cannot stage .*E409/)
        assert.ok(thrown.message.includes(`${packages[conflictAt].name}@${packages[conflictAt].version}`))
        assert.ok(thrown.message.includes(packages[conflictAt].filename))
        assert.ok(thrown.message.includes(packages[conflictAt].integrity))
        assert.match(thrown.message, /Commit: .*\nArtifact: .*\nIntegrity: /)
        return true
      })
      assert.deepEqual(staged, packages.slice(0, conflictAt + 1).map(pkg => path.join(directory, 'release', 'platform', pkg.filename)))
    }
  }
})

test('an unverified staging conflict exits nonzero with the commit and artifact context', t => {
  const { directory, packages } = fixture(t)
  const commit = 'a'.repeat(40)
  const script = `
    import { stagePlatformPackages } from ${JSON.stringify(new URL('../scripts/stage-platform-packages.mjs', import.meta.url).href)};
    stagePlatformPackages(${JSON.stringify(directory)}, args => ({
      status: 1, stderr: '', stdout: JSON.stringify({error: {code: args[0] === 'view' ? 'E404' : 'E409', summary: 'already staged'}}),
    }));
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, GITHUB_SHA: commit },
  })
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes(`Commit: ${commit}`))
  assert.ok(result.stderr.includes(`${packages[0].name}@${packages[0].version}`))
  assert.ok(result.stderr.includes(packages[0].filename))
  assert.ok(result.stderr.includes(packages[0].integrity))
})

test('other staging failures also propagate', t => {
  const { directory } = fixture(t)
  assert.throws(() => stagePlatformPackages(directory, args => args[0] === 'view' ? error('E404') : error('E403', 'publish denied')), /Cannot stage/)
})
