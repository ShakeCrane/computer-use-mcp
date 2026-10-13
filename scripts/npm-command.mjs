// Invoke npm without a shell, including on Windows where npm is a .cmd shim.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export function npmCommand(args) {
  let cli = process.env.npm_execpath
  if (!cli && process.platform === 'win32') {
    cli = (process.env.PATH ?? '').split(delimiter)
      .map(dir => join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
      .find(file => existsSync(file))
    if (!cli) throw new Error('Cannot locate npm-cli.js on PATH')
  }
  return cli ? { command: process.execPath, args: [cli, ...args] } : { command: 'npm', args }
}
