import assert from 'node:assert/strict'
import test from 'node:test'
import { createSession } from '../dist/session.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { sanitizeAccessibilityResult, handleAccessibilityTool } from '../dist/session/accessibility-handlers.js'
import { createLegacyPolicyRuntime } from '../dist/session/legacy-policy.js'
import { nearestArgumentName } from '../dist/registry/registry.js'
import { buildInstructions, listedTools } from '../dist/instructions.js'
import { TargetStateController } from '../dist/session/target-state.js'

const text = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
const parse = r => JSON.parse(r.content.find(c => c.type === 'text')?.text ?? 'null')

const win = { windowId: 1, pid: 100, bundleId: 'com.example.app', title: 'Doc', bounds: { x: 100, y: 100, width: 800, height: 600 }, isOnScreen: true, isFocused: true, layer: 0 }
function fakeNative(overrides = {}) {
  const calls = []
  return {
    calls,
    getDisplaySize: () => ({ width: 2560, height: 1440, pixelWidth: 5120, pixelHeight: 2880, scaleFactor: 2 }),
    listDisplays: () => [{ x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 2, isMain: true }],
    getWindow: id => (id === 1 ? win : null),
    listWindows: () => [win],
    getFrontmostApp: () => ({ bundleId: 'com.example.app', displayName: 'App', pid: 100 }),
    listRunningApps: () => [{ bundleId: 'com.example.app', displayName: 'App', pid: 100, isHidden: false }],
    takeScreenshot: (...a) => { calls.push(['takeScreenshot', a]); return { base64: 'AAAA', width: 1024, height: 576, mimeType: 'image/jpeg', hash: `h${calls.length}`, unchanged: false } },
    activateApp: () => ({ activated: true }), activateWindow: () => ({ activated: true }),
    hideApp: () => true, unhideApp: (id) => { calls.push(['unhideApp', id]); return true },
    prepareDisplay: () => ({ hiddenBundleIds: ['com.apple.Safari', 'com.apple.Music'] }),
    mouseMove: (...a) => calls.push(['mouseMove', a]), mouseClick: (...a) => calls.push(['mouseClick', a]),
    mouseButton: (...a) => calls.push(['mouseButton', a]), mouseScroll: (...a) => calls.push(['mouseScroll', a]),
    keyPress: (...a) => calls.push(['keyPress', a]), typeText: (...a) => calls.push(['typeText', a]),
    cursorPosition: () => ({ x: 1, y: 1 }), getUserIdleTimeMs: () => 60_000,
    performAction: () => ({ performed: true }), setElementValue: () => ({ set: true }),
    findElement: () => [], getUiTree: () => ({ role: 'AXWindow', children: [{ role: 'AXButton', label: 'OK', children: [] }] }),
    getMenuBar: () => [], pressMenuItem: () => ({ pressed: false }),
    isNativeEmergencyStopActive: () => false,
    ...overrides,
  }
}
const session = (native, extra = {}) => createSession({ native, macosHelper: null, profile: 'desktop', ...extra })

test('F1: screenshot full_screen: true captures the screen even when a session target is set', async () => {
  const native = fakeNative()
  const s = session(native)
  await s.dispatch('set_target', { window_id: 1 })
  native.calls.length = 0
  await s.dispatch('screenshot', {})
  assert.equal(native.calls.find(c => c[0] === 'takeScreenshot')[1][4], 1, 'without the flag the target window is captured')
  native.calls.length = 0
  await s.dispatch('screenshot', { full_screen: true })
  const shot = native.calls.find(c => c[0] === 'takeScreenshot')
  assert.equal(shot[1][4], undefined, 'full_screen wins over the session target')
  assert.equal(shot[1][1], undefined, 'and over target_app')
  native.calls.length = 0
  await s.dispatch('screenshot', { full_screen: true, target_window_id: 1 })
  assert.equal(native.calls.find(c => c[0] === 'takeScreenshot')[1][4], undefined, 'and over an explicit target_window_id')
  s.close()
})

test('F3: unhide_app is listed in the default profile, and apps hidden by prepare_display are restored on close', async () => {
  assert.ok(listedTools('darwin', 'desktop').includes('unhide_app'))
  assert.ok(listedTools('win32', 'core').includes('unhide_app'))
  const native = fakeNative()
  const s = session(native)
  const r = await s.dispatch('click', { coordinate: [10, 10], target_app: 'com.other.app', focus_strategy: 'prepare_display', force: true })
  assert.match(text(r), /hiddenBundleIds/)
  // The agent restores one itself; the session restores the rest when it closes.
  const un = await s.dispatch('unhide_app', { bundle_id: 'com.apple.Safari' })
  assert.equal(un.isError, undefined)
  native.calls.length = 0
  s.close()
  assert.deepEqual(native.calls.filter(c => c[0] === 'unhideApp').map(c => c[1]), ['com.apple.Music'])
})

test('F5: sensitive-label redaction matches whole words only', () => {
  const kept = ['Shipping address', 'Compass', 'Pinned tabs', 'Opinion', 'Spinner', 'bypass', 'Passport number', 'Spin count']
  const blanked = ['Password', 'PIN', 'PIN code', 'One-time code', 'CVV', 'Passcode', 'Secret key', 'Enter your pass']
  for (const label of kept) assert.equal(sanitizeAccessibilityResult({ role: 'AXTextField', label, value: 'v' }).value, 'v', `kept: ${label}`)
  for (const label of blanked) assert.equal(sanitizeAccessibilityResult({ role: 'AXTextField', label, value: 'v' }).value, null, `blanked: ${label}`)
  assert.equal(sanitizeAccessibilityResult({ role: 'AXSecureTextField', label: 'Anything', value: 'v' }).value, null, 'secure roles still blank')
  const policy = createLegacyPolicyRuntime({ activeProfile: 'desktop', nativeInjected: true, isWindows: false, hasElicitation: false, targetApp: () => undefined, env: {} })
  assert.deepEqual(policy.redactAuditValue('args', { shipping_address: '1 Main St', pin: '1234', approval_token: 'x', opinion: 'fine' }),
    { shipping_address: '1 Main St', pin: { redacted: true }, approval_token: { redacted: true }, opinion: 'fine' })
})

test('F2: an unknown argument is refused by name with the nearest declared one; compat keys still work', async () => {
  assert.equal(nearestArgumentName('taget_app', ['coordinate', 'target_app', 'target_window_id']), 'target_app')
  assert.equal(nearestArgumentName('zzzzzz', ['coordinate']), undefined)
  const native = fakeNative()
  const server = createComputerUseServer({ native, macosHelper: null, profile: 'full', disableSessionLock: true })
  const client = await connectInProcess(server)
  try {
    const typo = await client.callTool('click', { coordinate: [10, 10], taget_app: 'com.example.app' })
    assert.equal(typo.isError, true)
    const payload = parse(typo)
    assert.equal(payload.error, 'invalid_arguments')
    assert.equal(payload.issues[0].path, 'taget_app')
    assert.match(payload.issues[0].message, /did you mean "target_app"/)
    assert.deepEqual(native.calls.filter(c => c[0] === 'mouseClick'), [], 'nothing was clicked')
    const alias = await client.callTool('left_click', { coordinate: [10, 10], target_app: 'com.example.app', delivery: 'hid', force: true })
    assert.equal(alias.isError, undefined, 'the aliases keep accepting click\'s targeting')
    const scroll = await client.callTool('scroll', { coordinate: [10, 10], direction: 'down', delta_y: 2 })
    assert.equal(scroll.isError, undefined, 'scroll keeps its undeclared deltas')
    // A mutating tool that touches nothing on any platform (the clipboard shells out to pbcopy on macOS and
    // needs a native clipboard elsewhere, so it is not portable in a fake-native test).
    const token = await client.callTool('agent_pointer', { action: 'move', coordinate: [5, 5], native_overlay: false, approval_token: 'not-configured' })
    assert.equal(token.isError, undefined, 'approval_token stays accepted as an undeclared argument')
  } finally { await client.close() }
})

test('F8: Windows get_app_capabilities reports the accessibility probe', async () => {
  const native = fakeNative()
  const ctx = {
    native, targets: new TargetStateController(native, () => 1), platform: 'win32',
    focus: { strategyFor: () => 'strict', ensure: async () => ({}), beginDispatch() {}, hiddenBundleIds() {} },
    activeProfile: 'full', sleep: async () => {},
    runScript: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }),
    getAppDictionary: async () => ({ error: 'not_scriptable' }),
  }
  const payload = parse(await handleAccessibilityTool('get_app_capabilities', { bundle_id: 'com.example.app' }, ctx))
  assert.equal(payload.accessible, true)
  assert.deepEqual(payload.accessibility, { nodes: 2, hasControls: true })
  assert.equal(payload.powershell, true)
})

test('F10: a session created without a profile reasons about the desktop profile, not full', async () => {
  const s = createSession({ native: fakeNative(), macosHelper: null })
  const guide = parse(await s.dispatch('get_tool_guide', { task_description: 'press the OK button in the dialog' }))
  assert.ok(Array.isArray(guide.unavailableInProfile) && guide.unavailableInProfile.length > 0, 'AX-only tools are flagged as unavailable by default')
  s.close()
})

test('C1: left_mouse_down, scroll and multi_select validate coordinates like click', async () => {
  const native = fakeNative()
  const s = session(native, { profile: 'full' })
  for (const [tool, args] of [
    ['left_mouse_down', { coordinate: [99_999, 99_999], target_app: 'com.example.app' }],
    ['scroll', { coordinate: [99_999, 99_999], direction: 'down', target_app: 'com.example.app' }],
    ['multi_select', { locs: [[99_999, 99_999]], press_ctrl: false, target_app: 'com.example.app' }],
    ['multi_edit', { locs: [[99_999, 99_999, 'x']], target_app: 'com.example.app' }],
  ]) {
    const r = await s.dispatch(tool, args)
    assert.equal(r.isError, true, tool)
    assert.match(text(r), /outside display bounds/, tool)
  }
  assert.deepEqual(native.calls.filter(c => ['mouseButton', 'mouseScroll', 'mouseClick', 'typeText'].includes(c[0])), [], 'nothing was posted')
  s.close()
})

test('C4: actions that did nothing are errors, not prose', async () => {
  const s = session(fakeNative({
    activateApp: () => ({ activated: false }), activateWindow: () => ({ activated: false, reason: 'raise_failed' }),
    hideApp: () => false, unhideApp: () => false, listRunningApps: () => [],
  }), { profile: 'full' })
  const opened = await s.dispatch('open_application', { bundle_id: 'com.missing.app' })
  assert.equal(opened.isError, true)
  assert.equal(parse(opened).error, 'activation_failed')
  assert.equal(parse(opened).reason, 'not_running')
  const hidden = await s.dispatch('hide_app', { bundle_id: 'com.missing.app' })
  assert.equal(hidden.isError, true)
  assert.equal(parse(hidden).error, 'app_not_found')
  const missing = await s.dispatch('activate_window', { window_id: 999 })
  assert.equal(missing.isError, true)
  assert.equal(parse(missing).reason, 'window_not_found')
  const notRaised = await s.dispatch('activate_window', { window_id: 1 })
  assert.equal(notRaised.isError, true)
  assert.equal(parse(notRaised).error, 'activation_failed')
  s.close()
})

test('A13: the instructions no longer promise an effect field that results do not carry', () => {
  const mac = buildInstructions('darwin', 'desktop')
  assert.match(mac, /Only pid deliveries report a verification/)
  assert.ok(!/Results that say the effect is unverifiable/.test(mac))
})
