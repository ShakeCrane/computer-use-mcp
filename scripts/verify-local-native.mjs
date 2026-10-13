// Source-build validation only; the published native resolver remains unchanged.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function verifyLocalNative(binary = `computer-use-napi.${process.platform}-${process.arch}.node`, directory = root) {
  const expected = resolve(directory, binary)
  assert.equal(basename(expected), `computer-use-napi.${process.platform}-${process.arch}.node`, 'Build artifact must match this Node platform/architecture')
  const stat = statSync(expected)
  assert.ok(stat.isFile() && stat.size > 0, `Current build artifact must be a nonempty file: ${expected}`)
  const { resolveAddonPath, loadNative } = await import(pathToFileURL(join(directory, 'dist', 'native.js')).href)
  assert.equal(realpathSync(resolveAddonPath()), realpathSync(expected), 'Native resolver must select the current build artifact; set COMPUTER_USE_NATIVE_PATH before starting this process')
  const addon = loadNative()
  assert.equal(typeof addon.getDisplaySize, 'function', 'Current build addon must load its native exports')
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(expected)).digest('base64')
  console.log(`Current build native loaded: ${realpathSync(expected)}; integrity: ${integrity}; exports: ${Object.keys(addon).length}`)
  return expected
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyLocalNative(process.argv[2]).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
