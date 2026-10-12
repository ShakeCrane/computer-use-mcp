#!/usr/bin/env node
// Live integration test on a macOS desktop (7.6.1): the real native module, the desktop status card, a real app
// driven through the server, the card's buttons pressed as a person would press them (raw native clicks, not tool
// calls), and the card's absence from the agent's own screenshots. Run it on a Mac you are not using for the next
// minute; it opens Calculator, computes 1 + 2, and quits it. Nothing is written outside the temp directory.
//
//   npm run build:ts && node scripts/integration-status-card.mjs
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

process.env.COMPUTER_USE_STATUS_CARD = 'true'
const { createComputerUseServer } = await import('../dist/server.js')
const { connectInProcess } = await import('../dist/client.js')
const { loadNative } = await import('../dist/native.js')
const { createMacosHelper } = await import('../dist/session/macos-helper.js')

const CALC = 'com.apple.calculator'
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }
const text = r => r.content.find(c => c.type === 'text')?.text ?? ''
const parse = r => { try { return JSON.parse(text(r)) } catch { return { raw: text(r) } } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const native = loadNative()
const personClicks = (point) => { native.mouseMove(point.x, point.y); native.mouseClick(point.x, point.y, 'left', 1) }
const centre = rect => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) })

const server = createComputerUseServer({ profile: 'full' })
const client = await connectInProcess(server)
/**
 * The user-active guard refuses to take focus within 4 s of the person's own typing or mouse movement, which is
 * right, and which means this test waits for the person's hands to leave the keyboard. A call that is refused with
 * user_active is retried once a second for up to a minute.
 */
async function whenIdle(name, args) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await client.callTool(name, args)
    if (!(result.isError && parse(result).error === 'user_active')) return result
    if (attempt === 0) console.log(`      (waiting for you to stop typing or moving the mouse before ${name})`)
    await sleep(1000)
  }
  return client.callTool(name, args)
}
const scratch = mkdtempSync(join(tmpdir(), 'cu-integration-'))
let cardDir
try {
  // 1. The install and permissions.
  const doctor = parse(await client.callTool('doctor', { include_remediation: false }))
  check('doctor passes', doctor.ok === true, JSON.stringify(doctor.summary))
  const guard = doctor.checks.find(c => c.id === 'user_active_guard')
  check('user-active guard clock available', guard?.status === 'pass', guard?.summary?.slice(0, 80))

  // 2. Drive a real app through the server: open Calculator and compute 1 + 2 by accessibility.
  const opened = parse(await whenIdle('activate_app', { bundle_id: CALC }))
  if (!opened.activated) {
    const launched = await whenIdle('open_application', { bundle_id: CALC })
    if (launched.isError) console.log('      open_application:', text(launched).slice(0, 160))
  }
  const appeared = parse(await client.callTool('wait_for_window', { target_app: CALC, timeout_ms: 15000 }))
  if (!appeared.found) console.log('      wait_for_window:', JSON.stringify(appeared).slice(0, 200))
  check('Calculator window appears', appeared.found === true, `window ${appeared.window?.windowId} (${appeared.window?.kind})`)
  const windowId = appeared.window?.windowId
  await client.callTool('set_target', { app: CALC })
  await sleep(600)

  // 3. The card launched on the first desktop action, and says what happened.
  let status
  for (let i = 0; i < 40 && !(status?.card?.launched || status?.card?.error); i++) { status = parse(await client.callTool('control_status', {})); await sleep(250) }
  check('status card launched', status?.card?.launched === true, JSON.stringify(status?.card))
  cardDir = status?.card?.directory
  let card
  for (let i = 0; i < 20 && !card; i++) { try { card = JSON.parse(readFileSync(join(cardDir, 'card.json'), 'utf8')) } catch { await sleep(200) } }
  check('card published its geometry', Boolean(card?.buttons?.pause), card ? `frame ${JSON.stringify(card.frame)}` : 'no card.json')
  const frame = JSON.parse(readFileSync(join(cardDir, 'state.json'), 'utf8'))
  check('card frame names the app', frame.recent.some(a => a.app === CALC) || frame.action?.app === CALC, (frame.recent[0] ?? frame.action)?.label)

  const buttons = parse(await client.callTool('find_element', { window_id: windowId, role: 'AXButton', max_results: 100 }))
  const labels = (Array.isArray(buttons) ? buttons : []).map(b => b.label).filter(Boolean)
  check('Calculator exposes buttons by accessibility', labels.length > 10, `${labels.length} buttons, e.g. ${labels.slice(0, 6).join(', ')}`)
  const pick = re => labels.find(l => re.test(l))
  const keys = [pick(/^1$/), pick(/^(\+|add)$/i), pick(/^2$/), pick(/^(=|equals?)$/i)]
  check('the four keys are found', keys.every(Boolean), keys.join(' '))
  for (const label of keys) {
    const pressed = await whenIdle('press_button', { window_id: windowId, label })
    if (pressed.isError) check(`press ${label}`, false, text(pressed).slice(0, 120))
  }
  await sleep(700)
  // The result, two ways: the accessibility value of the display, and the OCR of the window.
  const statics = parse(await client.callTool('find_element', { window_id: windowId, role: 'AXStaticText', max_results: 50 }))
  // Calculator's accessibility values carry bidi marks (U+200E) around each glyph; strip them before matching.
  const plain = v => String(v ?? '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()
  const axValues = (Array.isArray(statics) ? statics : []).map(e => plain(e.value ?? e.label)).filter(Boolean)
  const ocr = parse(await client.callTool('read_window_text', { target_app: CALC }))
  const seen = (ocr.lines ?? []).map(l => l.text.trim())
  const reads3 = axValues.some(v => /^3$/.test(v)) || seen.some(t => /^(=\s*)?3$/.test(t))
  check('the display reads 3 (accessibility or OCR)', reads3, `ax: ${axValues.slice(0, 6).join(' | ')} ; ocr: ${seen.slice(-5).join(' | ')}`)

  // 4. Pause from the card: a person's click on its Pause button.
  personClicks(centre(card.buttons.pause))
  await sleep(600)
  status = parse(await client.callTool('control_status', {}))
  check('Pause button pauses the agent', status.state === 'paused' && status.reason === 'person', `state ${status.state} (${status.reason})`)
  const refused = parse(await client.callTool('press_button', { window_id: windowId, label: keys[2] }))
  check('a mutation is refused while paused', refused.error === 'paused_by_user', refused.error)
  const stillReads = parse(await client.callTool('read_window_text', { target_app: CALC }))
  check('reads keep working while paused', Array.isArray(stillReads.lines), `${stillReads.lines?.length ?? 0} lines`)

  // 5. Resume from the card.
  personClicks(centre(card.buttons.pause))
  await sleep(600)
  status = parse(await client.callTool('control_status', {}))
  check('Resume button resumes the agent', status.state === 'running', `state ${status.state}`)
  const again = await whenIdle('press_button', { window_id: windowId, label: pick(/^(c|ac|clear|all clear)$/i) ?? keys[0] })
  check('a mutation works after resume', !again.isError, text(again).slice(0, 60))

  // 6. The card is not in the agent's screenshots.
  const shot = await client.callTool('screenshot', { full_screen: true, quality: 0 })
  const image = shot.content.find(c => c.type === 'image')
  const path = join(scratch, 'screen.png')
  writeFileSync(path, Buffer.from(image.data, 'base64'))
  const helper = createMacosHelper()
  const screenText = (await helper.ocr({ imagePath: path })).lines.map(l => l.text)
  const cardWords = screenText.filter(t => /Agent is using this Mac|Agent paused|Agent stopped/i.test(t))
  check('screenshot OCR works', screenText.length > 0, `${screenText.length} lines`)
  check('the card is absent from the screenshot', cardWords.length === 0, cardWords.join(' | ') || 'no card text found')
  check('screenshot ignored the session target (full_screen)', /screen \d+x\d+/.test(text(shot)) && !/window \d+ at/.test(text(shot)), text(shot).split('\n')[0])

  // 7. Quit Calculator through the server, then Stop from the card.
  const quit = await whenIdle('key', { text: 'command+q', target_app: CALC })
  check('Calculator quit through the server', !quit.isError, text(quit).slice(0, 60))
  const gone = parse(await client.callTool('wait_for_window', { target_app: CALC, gone: true, timeout_ms: 8000 }))
  check('Calculator window gone', gone.gone === true)
  personClicks(centre(card.buttons.stop))
  await sleep(600)
  status = parse(await client.callTool('control_status', {}))
  check('Stop button stops the agent', status.state === 'stopped', `state ${status.state}`)
  check('Stop tripped the native emergency-stop latch', status.emergencyStop?.latched === true)
  const stopped = parse(await client.callTool('key', { text: 'escape', target_app: 'com.apple.finder' }))
  check('every mutation is refused after Stop', stopped.error === 'stopped_by_user', stopped.error)
  const readAfter = parse(await client.callTool('list_windows', {}))
  check('reads still work after Stop', Array.isArray(readAfter.windows))
} catch (error) {
  check('no unexpected error', false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await client.close()
  await sleep(800)
  const stillRunning = (() => { try { return execSync('pgrep -fl macos-status-card', { encoding: 'utf8' }).trim() } catch { return '' } })()
  check('no card process left after close', stillRunning === '', stillRunning)
  check('card directory removed', !cardDir || !existsSync(cardDir), cardDir ?? '')
  try { execSync(`osascript -e 'tell application id "${CALC}" to quit'`, { stdio: 'ignore' }) } catch { /* already gone */ }
  rmSync(scratch, { recursive: true, force: true })
}
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
