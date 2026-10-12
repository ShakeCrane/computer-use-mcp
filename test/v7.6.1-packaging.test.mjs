import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('7.6.1: the package ships dist as a directory, so a new module cannot be left out of the tarball', () => {
  assert.ok(pkg.files.includes('dist/'), 'files must contain "dist/"')
  assert.ok(!pkg.files.some(entry => /^dist\/.+\.(js|d\.ts)$/.test(entry)), 'no dist module is enumerated by hand any more')
  for (const required of ['libexec', 'skills', 'README.md', 'AGENTS.md', 'SECURITY.md', 'LICENSE', 'mcp-server.toml']) {
    assert.ok(pkg.files.includes(required), `files must contain ${required}`)
  }
})

test('7.6.1: every runtime import inside dist resolves to a file that ships', () => {
  // fileURLToPath, not .pathname: on Windows the pathname of a file URL starts with a slash before the drive letter.
  const root = fileURLToPath(new URL('../dist/', import.meta.url))
  const walk = dir => readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : []
  })
  const missing = []
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from\s+'(\.[^']+)'|import\(\s*'(\.[^']+)'\s*\)|new URL\('(\.[^']+)',\s*import\.meta\.url\)/g)) {
      const target = match[1] ?? match[2] ?? match[3]
      const resolved = join(file, '..', target)
      try { statSync(resolved) } catch { missing.push(`${file.slice(root.length).replaceAll('\\', '/')} -> ${target}`) }
    }
  }
  assert.deepEqual(missing, [])
})
