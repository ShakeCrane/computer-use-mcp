import assert from 'node:assert/strict'
import test from 'node:test'
import { handleAccessibilityTool } from '../dist/session/accessibility-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'
import { InputHandler } from '../dist/session/input-handlers.js'

function native(overrides = {}) {
  const calls = []
  return {
    calls,
    getWindow: id => id === 42 ? { windowId: 42, bundleId: 'app.fixture', isOnScreen: true } : null,
    getFrontmostApp: () => ({ bundleId: 'app.fixture' }),
    getUiTree: (...args) => ({ args }),
    getFocusedElement: () => null,
    findElement: () => [],
    performAction: () => ({ performed: true }),
    setElementValue: () => ({ set: true }),
    mouseMove: (...args) => calls.push(['mouseMove', ...args]),
    mouseClick: (...args) => calls.push(['mouseClick', ...args]),
    pressMenuItem: () => ({ pressed: true }),
    getMenuBar: () => [],
    listRunningApps: () => [],
    listWindows: () => [],
    ...overrides,
  }
}

function context(service, overrides = {}) {
  return {
    native: service,
    targets: new TargetStateController(service, () => 1),
    focus: { strategyFor: () => 'strict', ensure: async () => ({}), beginDispatch() {}, hiddenBundleIds() {} },
    activeProfile: 'full', sleep: async () => {},
    runScript: async () => ({ stdout: 'output\n', stderr: '', code: 0, timedOut: false }),
    getAppDictionary: async bundleId => ({ dict: { bundleId, suites: [] } }),
    ...overrides,
  }
}

test('extracted accessibility observations leave target provenance unchanged', async () => {
  const service = native()
  const ctx = context(service)
  ctx.targets.update({ bundleId: 'app.original' }, 'keyboard')
  const before = ctx.targets.current()
  const result = await handleAccessibilityTool('get_ui_tree', { window_id: 42 }, ctx)
  assert.equal(result.isError, undefined)
  assert.deepEqual(ctx.targets.current(), before)
})

test('extracted accessibility click uses bounded coordinate fallback and records provenance', async () => {
  const service = native({
    performAction: () => ({
      performed: false, reason: 'unsupported_action',
      bounds: { x: 10, y: 20, width: 30, height: 40 },
    }),
    getDisplaySize: () => ({ width: 1440, height: 900, scaleFactor: 2 }),
    listDisplays: () => [{ x: 0, y: 0, width: 1440, height: 900 }],
  })
  const ctx = context(service)
  // 7.6.1: the fallback posts through the input handler, so the user-active guard and coordinate validation apply.
  let guardReads = 0
  const guard = { activity: () => { guardReads++; return { msSinceInput: 60_000, thresholdMs: 4000, active: false } }, check: () => {}, status: () => ({}) }
  ctx.input = new InputHandler({ native: service, targets: ctx.targets, focus: ctx.focus, sleep: async () => {}, guard })
  const result = await handleAccessibilityTool('click_element', {
    window_id: 42, role: 'AXButton', label: 'Submit',
  }, ctx)
  assert.equal(result.isError, undefined)
  assert.deepEqual(service.calls, [['mouseMove', 25, 40], ['mouseClick', 25, 40, 'left', 1]])
  assert.equal(ctx.targets.current().establishedBy, 'pointer')
  assert.ok(guardReads > 0, 'the guard was consulted for the fallback click')
})

test('7.6.1: the click_element coordinate fallback is refused while the user is active, like click', async () => {
  const service = native({
    performAction: () => ({ performed: false, reason: 'unsupported_action', bounds: { x: 10, y: 20, width: 30, height: 40 } }),
    getDisplaySize: () => ({ width: 1440, height: 900, scaleFactor: 2 }),
    listDisplays: () => [{ x: 0, y: 0, width: 1440, height: 900 }],
  })
  const ctx = context(service)
  const guard = {
    activity: () => ({ msSinceInput: 120, thresholdMs: 4000, active: true }),
    check: () => { const error = new Error('user_active'); error.details = { error: 'user_active' }; throw error },
    status: () => ({}),
  }
  ctx.input = new InputHandler({ native: service, targets: ctx.targets, focus: ctx.focus, sleep: async () => {}, guard })
  await assert.rejects(handleAccessibilityTool('click_element', { window_id: 42, role: 'AXButton', label: 'Submit' }, ctx), /user_active/)
  assert.deepEqual(service.calls, [], 'nothing was posted')
})

test('7.6.1: without an input handler the fallback is a structured refusal, never a raw native click', async () => {
  const service = native({
    performAction: () => ({ performed: false, reason: 'unsupported_action', bounds: { x: 10, y: 20, width: 30, height: 40 } }),
  })
  const result = await handleAccessibilityTool('click_element', { window_id: 42, role: 'AXButton', label: 'Submit' }, context(service))
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0].text).error, 'input_unavailable')
  assert.deepEqual(service.calls, [])
})

test('extracted accessibility miss returns ranked label recovery candidates', async () => {
  const service = native({
    performAction: () => ({ performed: false, reason: 'not_found' }),
    findElement: () => [
      { role: 'AXButton', label: 'Cancel', value: null },
      { role: 'AXButton', label: 'Submit', value: null },
    ],
  })
  const result = await handleAccessibilityTool('click_element', {
    window_id: 42, role: 'AXButton', label: 'Sumbit',
  }, context(service))
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0].text).similar[0].label, 'Submit')
})

test('extracted scripting handler preserves output and cancellation signal', async () => {
  const service = native()
  const controller = new AbortController()
  let observedSignal
  const result = await handleAccessibilityTool('run_script', {
    language: 'applescript', script: 'return 1',
  }, context(service, {
    signal: controller.signal,
    runScript: async (_language, _script, _timeout, signal) => {
      observedSignal = signal
      return { stdout: 'one\n', stderr: '', code: 0, timedOut: false }
    },
  }))
  assert.equal(result.content[0].text, 'one')
  assert.equal(observedSignal, controller.signal)
})

// ── run_script: a refused Apple event is a permission, not a script bug ──────

test('run_script names the Automation permission when osascript reports -1743', async () => {
  const ctx = context(native(), {
    runScript: async () => ({
      stdout: '', code: 1, timedOut: false,
      stderr: 'execution error: Not authorized to send Apple events to Finder. (-1743)\n',
    }),
  })
  const result = await handleAccessibilityTool('run_script', {
    language: 'applescript', script: 'tell application "Finder" to count windows',
  }, ctx)
  assert.equal(result.isError, true)
  const text = result.content[0].text
  assert.match(text, /\(-1743\)/)
  assert.match(text, /automation_permission_denied/)
  assert.match(text, /control Finder in System Settings > Privacy & Security > Automation/)
})

test('run_script leaves an ordinary script failure untouched', async () => {
  const ctx = context(native(), {
    runScript: async () => ({ stdout: '', stderr: 'syntax error: Expected end of line (-2741)\n', code: 1, timedOut: false }),
  })
  const result = await handleAccessibilityTool('run_script', { language: 'applescript', script: 'tell' }, ctx)
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, 'syntax error: Expected end of line (-2741)')
})
