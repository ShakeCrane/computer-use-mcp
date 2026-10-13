// Pack the same artifacts that will be attested and staged, on any host OS.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePlatformPackages } from './prepare-platform-packages.mjs'
import { npmCommand } from './npm-command.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function packPlatformPackages(directory = root) {
  const packages = preparePlatformPackages(directory, { requireBinaries: true })
  const destination = path.join(directory, 'release', 'platform')
  fs.mkdirSync(destination, { recursive: true })
  const packed = []
  for (const { target, dir, pkg, binary } of packages) {
    const { command, args } = npmCommand(['pack', '--ignore-scripts', '--json', '--pack-destination', destination])
    const output = execFileSync(command, args, { cwd: dir, encoding: 'utf8' })
    const [entry] = JSON.parse(output)
    const files = entry.files.map(file => file.path).sort()
    if (entry.name !== pkg.name || entry.version !== pkg.version ||
        JSON.stringify(files) !== JSON.stringify(['LICENSE', binary, 'package.json'].sort()) ||
        !entry.files.some(file => file.path === binary && file.size > 0)) {
      throw new Error(`Invalid packed native package for ${target}`)
    }
    packed.push({ target, name: entry.name, version: entry.version, filename: entry.filename, integrity: entry.integrity })
  }
  fs.writeFileSync(path.join(destination, 'packages.json'), JSON.stringify(packed, null, 2) + '\n')
  return packed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const pkg of packPlatformPackages()) console.log(`${pkg.name}@${pkg.version}: ${pkg.filename}`)
}
