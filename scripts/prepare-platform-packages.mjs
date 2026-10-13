// The root version is the source of truth for the six native packages.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')

export function preparePlatformPackages(directory = root, { requireBinaries = false, syncOnly = false } = {}) {
  const rootPath = path.join(directory, 'package.json')
  const rootPkg = readJson(rootPath)
  // Validate the entire release before changing any files. A stale binary in
  // packages/ must never substitute for a missing artifact from this build.
  const packages = TARGETS.map(target => {
    const dir = path.join(directory, 'packages', `computer-use-mcp-${target}`)
    const manifest = path.join(dir, 'package.json')
    const pkg = readJson(manifest)
    const [os, cpu] = target.split('-')
    const binary = `computer-use-napi.${target}.node`
    const source = path.join(directory, binary)
    if (pkg.name !== `@zavora-ai/computer-use-mcp-${target}` ||
        JSON.stringify(pkg.os) !== JSON.stringify([os]) ||
        JSON.stringify(pkg.cpu) !== JSON.stringify([cpu]) ||
        JSON.stringify(pkg.files) !== JSON.stringify([binary])) {
      throw new Error(`Invalid platform package manifest: ${manifest}`)
    }
    if (requireBinaries && (!fs.existsSync(source) || fs.statSync(source).size === 0)) {
      throw new Error(`Missing native build artifact: ${source}`)
    }
    return { target, dir, manifest, pkg, binary, source }
  })

  rootPkg.optionalDependencies ??= {}
  for (const { pkg } of packages) rootPkg.optionalDependencies[pkg.name] = rootPkg.version
  writeJson(rootPath, rootPkg)
  // Before the first publication npm drops 404 optional packages from a newly
  // generated lockfile, then npm ci rejects that lockfile as incomplete. Record
  // the manifests' known metadata without inventing a registry integrity hash.
  const lockPath = path.join(directory, 'package-lock.json')
  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath)
    lock.version = rootPkg.version
    lock.packages[''].version = rootPkg.version
    lock.packages[''].optionalDependencies = { ...rootPkg.optionalDependencies }
    for (const { pkg } of packages) {
      const key = `node_modules/${pkg.name}`
      if (lock.packages[key]?.version !== rootPkg.version) {
        lock.packages[key] = {
          version: rootPkg.version,
          resolved: `https://registry.npmjs.org/${pkg.name}/-/` +
            `${pkg.name.split('/')[1]}-${rootPkg.version}.tgz`,
          license: pkg.license,
          optional: true,
          os: pkg.os,
          cpu: pkg.cpu,
        }
      }
    }
    writeJson(lockPath, lock)
  }
  for (const { dir, manifest, pkg, binary, source } of packages) {
    pkg.version = rootPkg.version
    pkg.repository = { ...rootPkg.repository, directory: path.relative(directory, dir).replaceAll('\\', '/') }
    pkg.publishConfig = { access: 'public' }
    writeJson(manifest, pkg)
    if (syncOnly) continue
    fs.copyFileSync(path.join(directory, 'LICENSE'), path.join(dir, 'LICENSE'))
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, binary))
    else fs.rmSync(path.join(dir, binary), { force: true })
  }
  return packages
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packages = preparePlatformPackages(root, {
    requireBinaries: process.argv.includes('--require-binaries'),
    syncOnly: process.argv.includes('--sync-only'),
  })
  console.log(`Prepared ${packages.length} platform manifests at the root version`)
}
