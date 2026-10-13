import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = `${process.platform}-${process.arch}`
const binary = `computer-use-napi.${target}.node`
const verifier = new URL('../scripts/verify-local-native.mjs', import.meta.url).href

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'computer-use-local-native-'))
  const cleanup = fs.realpathSync(directory)
  assert.equal(path.dirname(cleanup).toLowerCase(), fs.realpathSync(tmpdir()).toLowerCase())
  t.after(() => fs.rmSync(cleanup, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'dist'))
  fs.copyFileSync(path.join(root, 'dist', 'native.js'), path.join(directory, 'dist', 'native.js'))
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  const optional = path.join(directory, 'node_modules', '@zavora-ai', `computer-use-mcp-${target}`)
  fs.mkdirSync(optional, { recursive: true })
  fs.writeFileSync(path.join(optional, 'package.json'), JSON.stringify({ name: `@zavora-ai/computer-use-mcp-${target}`, version: '0.0.0-test' }))
  // If validation accidentally loads this old package, native loading must fail.
  fs.writeFileSync(path.join(optional, binary), 'old optional binary sentinel')
  const current = path.join(directory, binary)
  fs.copyFileSync(path.join(root, binary), current)
  return { directory, current, optional: path.join(optional, binary) }
}

function verify(directory, override, expected = binary) {
  const env = { ...process.env }
  delete env.COMPUTER_USE_NATIVE_PATH
  if (override !== undefined) env.COMPUTER_USE_NATIVE_PATH = override
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { verifyLocalNative } from ${JSON.stringify(verifier)};
    await verifyLocalNative(${JSON.stringify(expected)}, ${JSON.stringify(directory)});
  `], { encoding: 'utf8', env })
}

test('a source build loads the current addon despite an installed older optional package', t => {
  const { directory, current, optional } = fixture(t)
  const selected = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { resolveAddonPath } from ${JSON.stringify(pathToFileURL(path.join(directory, 'dist', 'native.js')).href)};
    console.log(resolveAddonPath());
  `], { encoding: 'utf8', env: { ...process.env, COMPUTER_USE_NATIVE_PATH: '' } })
  assert.equal(selected.status, 0, selected.stderr)
  assert.equal(fs.realpathSync(selected.stdout.trim()), fs.realpathSync(optional))
  const result = verify(directory, current)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(fs.realpathSync(current)))
  assert.match(result.stdout, /integrity: sha512-.*; exports: \d+/)
})

test('source validation fails if an installed optional binary shadows the current artifact', t => {
  const { directory, optional } = fixture(t)
  for (const override of [undefined, optional]) {
    const result = verify(directory, override)
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must select the current build artifact/)
  }
})

test('missing and empty build artifacts fail rather than passing through optional fallback', t => {
  const { directory, current } = fixture(t)
  fs.unlinkSync(current)
  const missing = verify(directory, current)
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /ENOENT/)
  fs.writeFileSync(current, '')
  const empty = verify(directory, current)
  assert.notEqual(empty.status, 0)
  assert.match(empty.stderr, /must be a nonempty file/)
})

test('source validation rejects an artifact named for another Node architecture', t => {
  const { directory, current } = fixture(t)
  const other = `computer-use-napi.${process.platform}-${process.arch === 'x64' ? 'arm64' : 'x64'}.node`
  const result = verify(directory, current, other)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must match this Node platform\/architecture/)
})
