import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

// Execute the actual main staging step with a disposable npm command, not a registry.
const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const step = workflow.split('      - name: Stage main package for maintainer approval\n')[1]
const script = step.split('        run: |\n')[1].split('\n        env:')[0]
  .split('\n').map(line => line.slice(10)).join('\n')

for (const status of [0, 1]) {
  test(`main staging ${status === 0 ? 'succeeds normally' : 'fails closed on E409'}`, { skip: process.platform !== 'linux' }, t => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'computer-use-main-stage-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const commands = path.join(directory, 'commands')
    fs.mkdirSync(commands)
    fs.mkdirSync(path.join(directory, 'release', 'root'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '9.0.0-test.1' }))
    fs.writeFileSync(path.join(directory, 'release', 'root', 'main.tgz'), 'tested main artifact')
    fs.writeFileSync(path.join(commands, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$PR44_STAGE_TRACE"
if [ "$1" = view ]; then exit 1; fi
if [ "$1" = stage ]; then
  if [ "$PR44_STAGE_STATUS" = 0 ]; then printf '{}\\n'; exit 0; fi
  printf '{"error":{"code":"E409","summary":"already staged"}}\\n'
  exit "$PR44_STAGE_STATUS"
fi
exit 2
`, { mode: 0o755 })
    const trace = path.join(directory, 'npm-calls.txt')
    const commit = 'b'.repeat(40)
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd: directory, encoding: 'utf8', env: { ...process.env,
        PATH: commands + path.delimiter + process.env.PATH,
        GITHUB_SHA: commit, PR44_STAGE_STATUS: String(status), PR44_STAGE_TRACE: trace,
      },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, status, result.stderr || result.stdout)
    const calls = fs.readFileSync(trace, 'utf8').trim().split('\n')
    assert.equal(calls.length, 2)
    assert.match(calls[1], /^stage publish .* --access public --provenance$/)
    if (status !== 0) {
      assert.ok(result.stdout.includes('@zavora-ai/computer-use-mcp@9.0.0-test.1'))
      assert.ok(result.stdout.includes(`commit=${commit}`))
      assert.match(result.stdout, /artifact=release\/root\/main.tgz integrity=sha512-/)
      assert.equal(result.stdout.includes('::warning::'), false)
    }
  })
}
