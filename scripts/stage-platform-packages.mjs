// Stage only the exact tested/attested tarballs, before staging the main package.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS } from './prepare-platform-packages.mjs'
import { npmCommand } from './npm-command.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
function runNpm(args) {
  const command = npmCommand(args)
  const result = spawnSync(command.command, command.args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}
function errorCode(result) {
  try { return JSON.parse(result.stdout).error?.code } catch { return undefined }
}

export function stagePlatformPackages(directory = root, npm = runNpm) {
  const version = readJson(join(directory, 'package.json')).version
  const packages = readJson(join(directory, 'release', 'platform', 'packages.json'))
  if (packages.length !== TARGETS.length || new Set(packages.map(pkg => pkg.target)).size !== TARGETS.length) {
    throw new Error('Release must contain all six distinct native packages')
  }
  // Complete local and registry preflight before staging any package.
  const pending = []
  for (const pkg of packages) {
    if (!TARGETS.includes(pkg.target) || pkg.version !== version ||
        pkg.name !== `@zavora-ai/computer-use-mcp-${pkg.target}` ||
        pkg.filename !== `zavora-ai-computer-use-mcp-${pkg.target}-${version}.tgz`) {
      throw new Error(`Invalid native release metadata: ${pkg.name}`)
    }
    const archive = join(directory, 'release', 'platform', pkg.filename)
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64')
    if (integrity !== pkg.integrity) throw new Error(`Tarball integrity mismatch: ${pkg.name}`)
    const spec = `${pkg.name}@${version}`
    const existing = npm(['view', spec, 'dist.integrity', '--json'])
    if (existing.status === 0) {
      if (JSON.parse(existing.stdout) !== integrity) throw new Error(`Published ${spec} differs from this build; bump the version`)
      console.log(`${spec} already published with identical integrity — skipping`)
    } else {
      if (errorCode(existing) !== 'E404') throw new Error(`Cannot check ${spec}: ${existing.stderr || existing.stdout}`)
      pending.push({ spec, archive })
    }
  }
  for (const { spec, archive } of pending) {
    const result = npm(['stage', 'publish', archive, '--access', 'public', '--provenance', '--ignore-scripts', '--json'])
    if (result.status !== 0) {
      if (errorCode(result) === 'E409' && /Cannot stage previously published version|already staged/i.test(result.stdout)) {
        console.warn(`${spec} already staged; review the pending tarball and release evidence before approving`)
        continue
      }
      throw new Error(`Cannot stage ${spec}: ${result.stderr || result.stdout}`)
    }
    console.log(result.stdout)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) stagePlatformPackages()
