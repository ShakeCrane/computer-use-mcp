/**
 * Operator control (7.6.1): the person's side of the desktop session.
 *
 * One state machine, on every platform, that a desktop status card drives: `running`, `paused` (new mutations are
 * refused with `paused_by_user`, the one in flight is aborted, reads continue) and `stopped` (the same, latched for the
 * rest of the session; when the native module has the emergency-stop latch, Stop trips it too, so actuators stop
 * mid-gesture and nothing resumes until a trusted host resets it). The model reads the state through `control_status`
 * and in every refusal, so it stops guessing.
 *
 * The card itself is a separate process per platform (`libexec/macos-status-card.swift`, compiled on first use like
 * the capture helper; `libexec/windows-status-card.ps1`), fed through two small files in a private directory:
 * `state.json`, written here atomically, and `control.txt`, written by the card (`running`, `paused`, `stopped`). The
 * card watches this process's pid and exits when it is gone, so a crashed server leaves nothing on screen; it is
 * excluded from screen capture on both platforms, so the agent never sees its own controls.
 *
 * What the card shows is honest: the tool, its key argument, the app and the window it was aimed at, as the session
 * resolved them, never a bucketed verb like "Selecting". Designed from the review of PR #40 (a Windows-only card with
 * the same two files), whose veto-and-abort shape this keeps.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NativeModule } from '../native.js'
import { compileSwiftHelper, defaultHelperCacheDir } from './macos-helper.js'

export type ControlState = 'running' | 'paused' | 'stopped'
export type ControlReason = 'person' | 'host' | 'emergency_stop' | 'session_closed'
export type ControlWaiting = 'user_active' | 'approval' | null

export interface ControlAction {
  tool: string
  /** The tool and its key argument, e.g. `click (120, 340)`, `type 24 chars`, `run_script applescript`. */
  label: string
  app?: string
  window?: string
  at: string
  outcome: 'active' | 'done' | 'failed'
}

/** What the card renders; `state.json`. */
export interface CardFrame {
  pid: number
  state: ControlState
  reason: ControlReason | null
  startedAt: number
  updatedAt: number
  action: ControlAction | null
  recent: ControlAction[]
  waiting: ControlWaiting
  chord: string | null
  platform: NodeJS.Platform
}

export interface ControlStatus extends Record<string, unknown> {
  state: ControlState
  reason: ControlReason | null
  since: string
  card: {
    enabled: boolean
    presenter: string
    launched: boolean
    directory: string | null
    error: string | null
  }
  emergencyStop: { latched: boolean }
  lastRefused: { tool: string; at: string } | null
  waiting: ControlWaiting
}

/** Shows the card for a session directory; one per platform, or none. */
export interface CardPresenter {
  readonly kind: string
  start(directory: string): Promise<void> | void
  stop(): void
}

export const CONTROL_POLL_MS = 150
const RECENT_ACTIONS = 4

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const controller = new AbortController()
  const forward = (signal: AbortSignal) => () => { if (!controller.signal.aborted) controller.abort(signal.reason) }
  if (a.aborted) controller.abort(a.reason)
  else if (b.aborted) controller.abort(b.reason)
  else { a.addEventListener('abort', forward(a), { once: true }); b.addEventListener('abort', forward(b), { once: true }) }
  return controller.signal
}

export class OperatorControl {
  readonly #native: Partial<Pick<NativeModule, 'triggerNativeEmergencyStop' | 'isNativeEmergencyStopActive'>>
  readonly #now: () => number
  readonly #presenter: CardPresenter | undefined
  readonly #pollMs: number
  readonly #platform: NodeJS.Platform
  readonly #chord: string | null
  readonly #startedAt: number
  #directory: string | undefined
  #state: ControlState = 'running'
  #reason: ControlReason | null = null
  #since: number
  #controller = new AbortController()
  #timer: ReturnType<typeof setInterval> | undefined
  #launched = false
  #launching: Promise<void> | undefined
  #presenterError: string | null = null
  #closed = false
  #lastControl = 'running'
  #action: ControlAction | null = null
  #recent: ControlAction[] = []
  #waiting: ControlWaiting = null
  #lastRefused: { tool: string; at: string } | null = null
  #lastFrame = ''

  constructor(options: {
    native?: Partial<Pick<NativeModule, 'triggerNativeEmergencyStop' | 'isNativeEmergencyStopActive'>>
    /** The desktop card. Absent: the state machine alone (the host can still pause, resume and stop). */
    card?: { presenter: CardPresenter; directory?: string; pollMs?: number }
    now?: () => number
    platform?: NodeJS.Platform
    /** The physical emergency-stop chord, when a host armed one; shown on the card. */
    chord?: string | null
  } = {}) {
    this.#native = options.native ?? {}
    this.#now = options.now ?? Date.now
    this.#presenter = options.card?.presenter
    this.#pollMs = options.card?.pollMs ?? CONTROL_POLL_MS
    this.#platform = options.platform ?? process.platform
    this.#chord = options.chord ?? null
    this.#startedAt = this.#now()
    this.#since = this.#startedAt
    if (options.card) {
      this.#directory = options.card.directory ?? mkdtempSync(join(tmpdir(), 'computer-use-card-'))
      this.#writeControl('running')
      this.#publish()
    }
  }

  state(): ControlState { this.#refresh(); return this.#state }

  status(): ControlStatus {
    this.#refresh()
    return {
      state: this.#state,
      reason: this.#reason,
      since: new Date(this.#since).toISOString(),
      card: {
        enabled: Boolean(this.#presenter),
        presenter: this.#presenter?.kind ?? 'none',
        launched: this.#launched,
        directory: this.#directory ?? null,
        error: this.#presenterError,
      },
      emergencyStop: { latched: this.#native.isNativeEmergencyStopActive?.() === true },
      lastRefused: this.#lastRefused,
      waiting: this.#waiting,
    }
  }

  /** The signal a mutating dispatch should run under: aborted by Pause and Stop. */
  signal(parent?: AbortSignal): AbortSignal {
    this.#refresh()
    return mergeSignals(parent, this.#controller.signal)
  }

  /** A refusal payload when the person has paused or stopped; undefined when the call may proceed. */
  gate(tool: string): Record<string, unknown> | undefined {
    this.#refresh()
    if (this.#state === 'running') return undefined
    const at = new Date(this.#now()).toISOString()
    this.#lastRefused = { tool, at }
    this.#publish()
    return {
      error: `${this.#state}_by_user`,
      status: this.#state,
      tool,
      since: new Date(this.#since).toISOString(),
      reason: this.#reason,
      hint: this.#state === 'paused'
        ? 'The person paused the agent from the desktop status card. Observation tools still work; wait, then retry, or report what you have. control_status says when it resumes.'
        : 'The person stopped the agent from the desktop status card. No mutating tool runs again in this session; report what you have and finish.',
    }
  }

  /** A tracked call started; launches the card on the first one. */
  begin(action: { tool: string; label: string; app?: string; window?: string }): void {
    if (this.#closed) return
    this.#ensurePresenter()
    this.#refresh()
    this.#action = { ...action, at: new Date(this.#now()).toISOString(), outcome: 'active' }
    this.#waiting = null
    this.#publish()
  }

  finish(outcome: 'done' | 'failed'): void {
    if (this.#closed || !this.#action) return
    const finished: ControlAction = { ...this.#action, outcome }
    this.#recent = [finished, ...this.#recent].slice(0, RECENT_ACTIONS)
    this.#action = null
    this.#publish()
  }

  /** What the agent is waiting on, so the card can say "waiting for you" or "approval needed". */
  waiting(kind: ControlWaiting): void {
    if (this.#closed || this.#waiting === kind) return
    this.#waiting = kind
    this.#publish()
  }

  pause(reason: ControlReason = 'host'): void {
    if (this.#closed || this.#state !== 'running') return
    this.#transition('paused', reason)
  }

  resume(reason: ControlReason = 'host'): void {
    if (this.#closed || this.#state !== 'paused') return
    this.#transition('running', reason)
  }

  /** Terminal for the session. Trips the native latch when there is one, so actuators stop mid-gesture. */
  stop(reason: ControlReason = 'host'): void {
    if (this.#closed || this.#state === 'stopped') return
    this.#transition('stopped', reason)
    try { this.#native.triggerNativeEmergencyStop?.() } catch { /* the session-level refusal still holds */ }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    if (!this.#controller.signal.aborted) this.#controller.abort(new Error('Desktop session closed'))
    this.#writeControl('stopped')
    try { this.#presenter?.stop() } catch { /* already gone */ }
    if (this.#directory) {
      try { rmSync(this.#directory, { recursive: true, force: true }) } catch { /* the card removes what it can */ }
    }
  }

  #transition(state: ControlState, reason: ControlReason): void {
    this.#state = state
    this.#reason = reason
    this.#since = this.#now()
    if (state === 'running') this.#controller = new AbortController()
    else if (!this.#controller.signal.aborted) this.#controller.abort(new Error(`Desktop control ${state} by ${reason}`))
    this.#lastControl = state
    this.#writeControl(state)
    this.#publish()
  }

  #ensurePresenter(): void {
    if (!this.#presenter || !this.#directory || this.#launched || this.#launching) return
    const directory = this.#directory
    this.#launching = Promise.resolve()
      .then(() => this.#presenter!.start(directory))
      .then(() => { this.#launched = true; this.#publish() })
      .catch(error => { this.#presenterError = error instanceof Error ? error.message : String(error); this.#publish() })
      .finally(() => { this.#launching = undefined })
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#refresh(), this.#pollMs)
      this.#timer.unref?.()
    }
  }

  /** Apply what the card wrote, if it changed. */
  #refresh(): void {
    if (this.#closed || !this.#directory) return
    let value: string
    try { value = readFileSync(join(this.#directory, 'control.txt'), 'utf8').trim().toLowerCase() } catch { return }
    if (value === this.#lastControl) return
    if (value !== 'running' && value !== 'paused' && value !== 'stopped') return
    this.#lastControl = value
    if (value === 'stopped') this.stop('person')
    else if (value === 'paused') this.pause('person')
    else this.resume('person')
  }

  #writeControl(value: string): void {
    if (!this.#directory) return
    try { writeFileSync(join(this.#directory, 'control.txt'), value, { mode: 0o600 }) } catch { /* the card is optional */ }
  }

  #publish(): void {
    if (!this.#directory) return
    const frame: CardFrame = {
      pid: process.pid,
      state: this.#state,
      reason: this.#reason,
      startedAt: this.#startedAt,
      updatedAt: this.#now(),
      action: this.#action,
      recent: this.#recent,
      waiting: this.#waiting,
      chord: this.#chord,
      platform: this.#platform,
    }
    const payload = JSON.stringify(frame)
    if (payload === this.#lastFrame) return
    try {
      const target = join(this.#directory, 'state.json')
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, payload, { mode: 0o600 })
      renameSync(temporary, target)
      this.#lastFrame = payload
    } catch { /* the card is optional: never change a tool result */ }
  }
}

/** The tool and its key argument, with the app and window the session resolved, for the card. Never typed text. */
export function describeAction(tool: string, args: Record<string, unknown>, resolved: { app?: string; window?: string }): { tool: string; label: string; app?: string; window?: string } {
  const text = (value: unknown, max = 40) => typeof value === 'string' ? (value.length > max ? `${value.slice(0, max)}…` : value) : undefined
  const point = Array.isArray(args.coordinate) && args.coordinate.length >= 2 ? `(${args.coordinate[0]}, ${args.coordinate[1]})` : undefined
  let detail: string | undefined
  switch (tool) {
    case 'click': case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click':
    case 'mouse_move': case 'left_mouse_down': case 'left_mouse_up':
      detail = point; break
    case 'scroll': detail = `${String(args.direction ?? '')} ${point ?? ''}`.trim(); break
    case 'type': detail = typeof args.text === 'string' ? `${args.text.length} chars` : undefined; break
    case 'key': detail = text(args.text, 24); break
    case 'hold_key': detail = Array.isArray(args.keys) ? args.keys.join('+') : undefined; break
    case 'click_text': case 'wait_for_text': detail = text(args.text) ? `"${text(args.text)}"` : undefined; break
    case 'click_element': case 'press_button': case 'set_value': detail = text(args.label); break
    case 'select_menu_item': detail = [args.menu, args.submenu, args.item].filter(Boolean).join(' › '); break
    case 'run_script': detail = text(args.language); break
    case 'filesystem': detail = `${String(args.mode ?? '')} ${text(args.path, 60) ?? ''}`.trim(); break
    case 'process_kill': detail = `${String(args.mode ?? '')} ${text(args.name) ?? (args.pid !== undefined ? `pid ${String(args.pid)}` : '')}`.trim(); break
    case 'registry': detail = `${String(args.mode ?? '')} ${text(args.path, 60) ?? ''}`.trim(); break
    case 'open_application': case 'activate_app': case 'hide_app': case 'unhide_app': detail = text(args.bundle_id); break
    case 'activate_window': detail = args.window_id !== undefined ? `window ${String(args.window_id)}` : undefined; break
    case 'mouse_drag': case 'left_click_drag': detail = 'drag'; break
    case 'screenshot': detail = args.full_screen === true ? 'full screen' : undefined; break
    default: detail = undefined
  }
  return { tool, label: detail ? `${tool} ${detail}` : tool, ...(resolved.app ? { app: resolved.app } : {}), ...(resolved.window ? { window: resolved.window } : {}) }
}

// ── Presenters ────────────────────────────────────────────────────────────────

function libexecPath(name: string): string {
  return join(fileURLToPath(import.meta.url), '..', '..', '..', 'libexec', name)
}

/** The macOS card: a Swift NSPanel compiled on first use into the helper cache, like the capture helper. */
export class MacosCardPresenter implements CardPresenter {
  readonly kind = 'macos'
  #child: ChildProcess | undefined
  constructor(private readonly options: { sourcePath?: string; cacheDir?: string } = {}) {}
  async start(directory: string): Promise<void> {
    const built = await compileSwiftHelper({
      sourcePath: this.options.sourcePath ?? libexecPath('macos-status-card.swift'),
      cacheDir: this.options.cacheDir ?? defaultHelperCacheDir(),
      name: 'macos-status-card',
    })
    if (!built.ok) throw new Error(`${built.reason}. ${built.remediation}`)
    const child = spawn(built.path, [directory], { stdio: 'ignore' })
    child.on('error', () => { /* the card is optional */ })
    child.unref()
    this.#child = child
  }
  stop(): void { try { this.#child?.kill() } catch { /* already gone */ } }
}

/** The Windows card: PowerShell and WPF (the lineage is PR #40), with the server's pid watched and capture excluded. */
export class WindowsCardPresenter implements CardPresenter {
  readonly kind = 'windows'
  #child: ChildProcess | undefined
  constructor(private readonly options: { scriptPath?: string } = {}) {}
  start(directory: string): void {
    const script = this.options.scriptPath ?? libexecPath('windows-status-card.ps1')
    const child = spawn('powershell.exe',
      ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, directory],
      { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => { /* the card is optional */ })
    child.unref()
    this.#child = child
  }
  stop(): void { try { this.#child?.kill() } catch { /* already gone */ } }
}

export function defaultCardPresenter(platform: NodeJS.Platform = process.platform): CardPresenter | undefined {
  if (platform === 'darwin') return new MacosCardPresenter()
  if (platform === 'win32') return new WindowsCardPresenter()
  return undefined
}

/** `COMPUTER_USE_STATUS_CARD=true` (opt-in in 7.6.1). */
export function statusCardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.COMPUTER_USE_STATUS_CARD?.trim().toLowerCase()
  return raw === 'true' || raw === '1'
}
