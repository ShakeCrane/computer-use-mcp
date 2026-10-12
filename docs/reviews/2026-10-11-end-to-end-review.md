# computer-use-mcp 7.6.0: end-to-end review in three passes, 2026-10-11

Reviewed by Claude Code (Fable 5.1) at `main` @ `97c01db` (7.6.0, two days after the 2026-10-09 review and
design pass that produced it). James: "review this project end to end in three passes: 1. deep pass to understand,
2. deep pass to confirm findings, 3. deep pass including online research to compare against competitors. Then look at
the new PR and ways to take such thinking and significantly improve it."

Method. Pass 1 read the TypeScript server, session, registry, catalog, policy, handlers, specs, reviews, changelog,
skills and the open PR and issues in full; three parallel read-only reviewers covered the native Rust and Swift layer,
the host-services layer (console, broker, Tasks, HTTP, browser) and the tests, CI and packaging. Pass 2 confirmed every
finding against the code and, where a fake native could drive it, with scripts (`scratchpad/confirm.mjs`); the unit
suite was run (537 tests, 536 pass, 1 skipped, 0 fail, 122 s on Node 25.4); the built server was started in-process
for `tools/list`, `doctor`, `get_target` and `policy_status` (read-only; nothing was clicked or typed). Pass 3 read the
primary sources for Anthropic, OpenAI Codex, cua, Peekaboo, Windows-MCP, Hermes and Microsoft, as of today. Nothing
was committed; this file is the only change in the working tree.

## 1. Bottom line

- **7.6.0 is a real improvement and the repository is in good order.** The default list is 39 tools and 42 KB
  in-process (46 KB on the wire), down from 73 and 113 KB; platform filtering, the session target, the waits and the
  self-checking launcher all work as described; the suite is green on five CI targets; npm `latest` is 7.6.0 and the
  tag exists. The 10-09 review's four blocking defects are fixed.
- **One advertised 7.6.0 feature does not exist.** `screenshot {full_screen: true}` is in the schema, the changelog,
  the release note, the instructions, AGENTS.md and the skill, and no handler reads it: with a session target set the
  call still captures the target window (§3.1 F1, confirmed by script). The honest-actions contract (`effect`,
  `route`, `delivery`) that the instructions and the skill already tell the model to rely on is also not shipped; the
  spec says so, the instructions do not.
- **The default profile can hide the user's apps and cannot restore them.** `focus_strategy: "prepare_display"`
  is on every input tool in `desktop`, `unhide_app` is not listed there (F3, confirmed live).
- **Three safety gaps remain from the last review and one is new:** the `click_element` coordinate fallback posts a
  click past the user-active guard (F4, confirmed by script); the sensitive-label redaction still blanks "Shipping
  address", "Compass", "Pinned tabs" and "Opinion" (F5, confirmed); misspelled targeting arguments are accepted
  silently, so a typo sends input to the wrong window (F2, confirmed); and the emergency-stop latch the native layer
  implements is never armed by the stock server, so out of the box there is no global stop at all (F7).
- **Two holes in the run console host that any web page can reach** (HS1, HS2): the Host and Origin checks
  cover `/mcp` only, so a page the person has open can capture the screen through `/driver`, inject a "user" turn
  through `/rpc`, or cancel the run, and the console page accepts `tools/call` from any window and is frameable. The
  console is opt-in and loopback, which is why this is not the first bullet; it should be fixed before the next
  console demo.
- **Four native paths report success for nothing** (N1 to N4): Windows `SendInput` and UIA `Invoke` results are
  ignored, the first DXGI capture of an idle desktop returns an unwritten texture, macOS `activate_window` sets
  `raised = true` whatever happened, and the addon leaks every autoreleased object because nothing pushes a pool.
- **Delivery is one new module away from breaking** (T1, T2): `package.json` lists `dist` files by name, which is
  why PR #40's tarball jobs are red and why the next contributor's will be; the stage job fails with E409 on a
  pending stage and staged 7.6.0 twice.
- **PR #40 (a Windows status card with Pause, Resume and Stop) is the right instinct built in the wrong layer.** The
  repository already has three stop and pause mechanisms (the native latch and chord, the broker's pause and takeover,
  the console's cancel) and a native always-on-top overlay on both platforms; the PR adds a fourth, file-polled,
  PowerShell-rendered one, Windows-only, that appears in the agent's own screenshots, swallows clicks that land on it,
  survives a server crash as an orphan, and is missing from the package `files` list, which is why its four tarball
  jobs are red. §5 has the review, §6 the design that takes the idea where it should go: one operator control plane
  with a native HUD on macOS and Windows, a hard stop, takeover on physical input, approvals through the HUD, and a
  model-visible `control_status`.
- **The field moved in the two days since the last research, in exactly this direction.** Windows-MCP 0.8.8
  (yesterday) ships "show AI control, temporarily block physical input, allow user takeover"; Peekaboo 4.9.0 (Oct 7)
  shows overlays from a hidden companion app and labels unverified effects in every summary; cua-driver 0.34.1 (Oct 9)
  adds live window previews; Codex's own-cursor UX has an open issue about orphaned cursor overlays (the lifecycle
  lesson for §6); Claude Code's CLI shows a macOS notification "Claude is using your computer · press Esc to stop" and
  consumes Esc. Nobody yet combines a window-scoped HUD with a hard stop, honest effect reporting and OCR for
  self-drawn apps; this repository is closest.

## 2. Pass 1: what the project is

### 2.1 Shape

| Layer | Where | Size | Role |
|---|---|---|---|
| Catalog and registry | `src/tool-catalog.ts`, `src/registry/` | 1.4k lines | 78 tools with meta (`job`, `tier`, `platforms`, hints); `registerAll` filters by platform and profile at registration, validates arguments with zod (passthrough), copies the approval token from `_meta`, binds MRTR state to an argument hash, wires progress |
| Server | `src/server.ts`, `src/instructions.ts`, `src/mcp-v7.1.ts`, `src/mcp-tasks.ts`, `src/resources.ts`, `src/prompts.ts` | 1.5k | SDK 2.0.0 `McpServer`; instructions generated per platform and profile; legacy and 2026-07-28; Tasks bridge; six resources; four prompts |
| Session | `src/session.ts` + `src/session/*` | 6.5k | One dispatch pipeline: defaults, policy (allow/block/sensitive/approval token/elicitation), native emergency latch, in-process queue plus cross-process lease lock, `prepare_display` slot, then a chain of handlers: admin, browser, window, agent-desktop (OCR, waits), Linux AT-SPI, discovery, accessibility, spaces, screenshot, input, OpenAI adapter, core; audit record |
| Native | `native/src/*.rs` (10.8k) + `libexec/macos-agent-helper.swift` | | CGEvent/SendInput/X11 input, pid delivery, HID activity tap and emergency chord, window and AX enumeration, capture (screencapture, DXGI, X11), overlay pointer (NSPanel, layered Win32 window), spaces, clipboard, keychain, permissions; the Swift helper does ScreenCaptureKit window capture and Vision OCR |
| Host services | `src/agent-run.ts`, `src/run-console*.ts`, `src/desktop-broker.ts`, `src/supervisor*.ts`, `src/runtime*.ts`, `src/browser*.ts`, `src/http.ts` | 3.5k | Run console (MCP App plus HTTP host), desktop broker with pause, resume and takeover, supervisor worker on the native chord, sandboxed runtime, browser backend, loopback HTTP |
| Verification | `test/*.test.mjs` (54 files), `.github/workflows` | 537 tests | Fake natives for nearly everything; byte budgets and instruction coverage on the real transport; six native builds, three native test jobs, five test platforms, a tarball install matrix, package verification, a staged npm publish |

Dispatch order matters for review: `prepare_display` state is reset at every dispatch including reads
(`session.ts:402`), policy runs before the lock, elicitation can wait inside the in-process queue (`coordinateDesktop`
wraps the whole dispatch, `session.ts:538-543`), and the native latch is consulted only for mutating tools.

### 2.2 What 7.6.0 delivered against the 10-09 programme

| Spec item | Status in 7.6.0 | Evidence |
|---|---|---|
| R0 the four blocking defects (guard first-call, `process_kill` broadcast, `hold_key` cap, start-up) | Done | `activity.rs` seed; `admin-handlers.ts:249-263`; `input-handlers.ts:26,503`; `env.ts`, `launch.ts`, `server.ts:485` |
| R0 `prepare_display` per dispatch and only for mutating tools; `hide_app`/`unhide_app`/`click_element` fallback through the guard | **Not done** | `session.ts:402` still runs `beginDispatch` on every dispatch; `window-handlers.ts:159-160` and `accessibility-handlers.ts:207-215` unchanged |
| R0 Swift helper compiled without the first caller's signal | **Not done** | `macos-helper.ts:171` passes `signal` into `compile` |
| R0 PR #34 landed and extended to pid delivery | Done | #39, changelog |
| R0 CI on Node 22 and 25, package job asserts 7.5 files, publish skips cleanly | See §3.6 | |
| R7 the design pass (default `desktop`, platform filtering, one `click`, diet, `approval_token` out, two `_meta`, instructions per platform, `job`, budgets) | Done | measured live: 39 tools / 42,330 B and 76 / 77,353 B in-process |
| R7 `screenshot` gains `full_screen` and `display_id` | **`full_screen` is schema-only (F1); `display_id` absent** | `screenshot-handlers.ts` never reads `args.full_screen` |
| R3 `wait_for_text`, `wait_for_stable` | Done (macOS) | `agent-desktop-handlers.ts` |
| R3 `verify:` on clicks, no blanket sleep | Not done | |
| R1 `effect` / `route` / `delivery` on every action; typed refusals; never `ok` for a no-op | **Not done, but the instructions and skill already describe it** | `instructions.ts:45`; `skills/computer-use/SKILL.md` "A result that says its effect is unverifiable"; `open_application` still returns `ok` with `activated: false` (`window-handlers.ts:149`) |
| R2 `capture_id`, element tokens | Not done | |
| R4 unchanged-frame short-circuit, `format: "path"` | Not done (SCK path dedups by hash and returns the cached full image) | `screenshot-handlers.ts:118` |
| R5 redaction, `resize_window window_id`, coordinate validation on `scroll`/`left_mouse_*`/`multi_*`, lock wait, OpenAI scaling, nearest key names | **Not done** | §3.2 |
| R6 unattended safety: hard-blocked chords, `no_approver`, consumed Esc, `scrape` SSRF | **Not done** | `legacy-policy.ts`; `admin-handlers.ts:345` fetches any URL |

The release note says R1 is "the next release". The instructions (`instructions.ts:45`) and the skill tell the model
today that results say whether the effect is unverifiable; they do not, except the pid-delivery note.

### 2.3 Repository state

Tags: v7.6.0 exists (v7.3.0 and v7.5.0 do not; 7.5.0 was never published and the release note says so). npm `latest`
is 7.6.0 (2026-10-09 12:26 UTC). Open: PR #40 (§5), issues #36 (per-platform packages: still manifests only, no reply),
#32 (Windows overlay deadlock: fixed in reasoning in 7.4.0, awaiting a reporter), #21 (Linux empty AX tree: no reply
since the 7.2 AT-SPI bridge). Local `doctor`: 12 pass, 0 warn, 0 fail, 1 skip; the guard clock is available; pid
delivery has records for TextEdit and the Unreal editor.

## 3. Pass 2: findings, confirmed

Severity: **high** = wrong action on the user's desktop, a safety control bypassed, or a documented feature that does
not exist; **medium** = wrong result or wasted calls; **low** = polish. "Script" means reproduced in
`scratchpad/confirm.mjs` against a fake native; "live" means on the built server; "code" means the line was read.

### 3.1 New in 7.6.0

| # | Sev | Finding | Where | Confirmed | Fix |
|---|---|---|---|---|---|
| F1 | high | **`screenshot {full_screen: true}` is advertised and ignored.** With a session target set, the capture is the target window (both the ScreenCaptureKit path and the native path resolve `observationWindow()` without consulting the flag). The changelog, release note, instructions, AGENTS.md and the skill all promise the opposite. An agent that set a target and then asks for the whole screen gets a window and a mapping line that says so, and will compute screen coordinates from the wrong frame | `registry/definitions.ts:100`; `screenshot-handlers.ts:68-76, 248-264` | script (A): `takeScreenshot` received `windowId: 1` | Read `args.full_screen` in `#captureWindow` and in `handle`; a test that sets a target and asserts a screen capture |
| F2 | high | **Misspelled or undeclared arguments are accepted silently.** The registry parses with `passthrough()` so the undeclared `approval_token` and the alias parameters work, but `taget_app`, `target_windowid`, `delivery_mode` and every other typo are dropped without a word, and the input goes to the session target or the frontmost app. The aliases (`left_click` and the rest) advertise only `coordinate`, so a host that validates against the schema refuses `target_app` on them, and a model cannot discover that they take it | `registry/registry.ts:329`; `definitions.ts:127-131` | script (C); live: alias schema keys `["coordinate"]` | Parse with `strict()` plus an explicit allowlist (`approval_token`, and the six targeting keys on the aliases), or add the targeting keys to the alias schemas; return `invalid_arguments` with the unknown key and the nearest valid name |
| F3 | high | **The default profile hides apps it cannot unhide.** `focus_strategy: "prepare_display"` is accepted by every input tool in `desktop`; `hide_app` and `unhide_app` are `ax` tier and not registered. The recovery skill says "then `unhide_app` for any `hiddenBundleIds`", which returns `Unknown or disabled tool`. Hidden apps stay hidden until the person unhides them; nothing restores them on dispose | `tool-catalog.ts:167-168`; `definitions.ts:12`; `focus.ts:101-104`; `skills/computer-use-recovery/SKILL.md` | script (G) and live | Either restore hidden apps automatically at the end of the dispatch (and on close), as Claude Code does, or put `unhide_app` in `core`; `prepare_display` should also be refused when the profile cannot undo it |
| F4 | high | **`click_element` falls back to a real pointer click without the user-active guard or coordinate validation.** When AXPress is unsupported the handler moves the cursor and clicks; `focus.ensure` returns early when the target is already frontmost, so the guard is never consulted. A plain `click` at the same moment is refused with `user_active` | `accessibility-handlers.ts:207-215`; `focus.ts:107-116` | script (D): guard not called, `mouseClick` posted | Route the fallback through `InputHandler.clickAt` (guard, validation, pid delivery, target update) |
| F5 | high | **Sensitive-value redaction matches substrings.** `/pass(?:word|code)?\|secure\|credential\|one.?time\|otp\|pin\|cvv\|cvc/i` blanks the value of any element whose label contains `pin` or `pass`: "Shipping address", "Compass", "Pinned tabs", "Opinion", "Spinner", "bypass", "Passport number". The model then cannot read a shipping address field it was asked to fill, and the audit redactor (`legacy-policy.ts:231`) has the same regex. Carried over from the 10-09 review (medium there; high here because `fill_form` and `find_element` return `value: null` for ordinary fields) | `accessibility-handlers.ts:83` | script (B) | Anchor on word boundaries and roles (`AXSecureTextField`, `uia_is_password`), keep the trusted signals, test the false positives |
| F6 | medium | **The tool guide recommends tools the default profile does not have, as its default answer.** Its generic fallback is `get_app_capabilities, get_ui_tree, find_element, click_element`; `press the OK button` yields `find_element, press_button`; both are flagged `unavailableInProfile` with "set COMPUTER_USE_PROFILE=full". The guide keeps its own hand-written `coreish` list instead of asking the catalog, so it disagrees with the instructions that are generated from the catalog | `tool-guide.ts:203-208, 236, 240-248` | script (H) | Derive availability from `listedTools(platform, profile)`; when the AX route is unavailable, recommend the OCR route on macOS and coordinates elsewhere |
| F7 | high | **No global stop is armed by default.** The native layer has a hard latch (`ensure_not_emergency_stopped` in every actuator, `interruptible_sleep`) and a physical chord, and the session refuses mutations while latched; but only `DesktopSupervisor` (a host-embedding class in `docs/STRATEGY.md`) calls `configureEmergencyStopChord`, and nothing in the stdio server or the console host starts it. Claude Code consumes Esc; Windows-MCP 0.8.8 and Hermes have takeover and hard blocks; here a person at the keyboard has no way to stop the agent except killing the host | `session.ts:319`; `activity.rs:85-170`; `supervisor-worker.ts:5`; `server.ts` (no supervisor) | code; live `doctor` has no emergency-stop check | Arm the chord in `createSession` on macOS and Windows (opt-out), report it in `doctor` and the instructions, and make it the Stop of §6 |
| F8 | medium | **Windows `get_app_capabilities` still says `accessible: true` for any app with a window.** The 7.6 change (`accessible` means `hasControls`) was applied to the macOS branch only; the Windows branch returns `accessible: windows.length > 0` and no `accessibility` object, so the changelog is wrong for Windows users | `accessibility-handlers.ts:344-348` | code | Run the same probe on Windows (UIA `getUiTree` exists) |
| F9 | medium | **`click_text` is a desktop mutation that does not refresh the desktop resources.** `DESKTOP_STATE_MUTATIONS` omits `click_text` (and `set_target`), so `computer://frontmost` and `computer://windows` subscribers are not notified after an OCR click | `server.ts:56-64` | code | Derive the set from the catalog (`job === 'act'` and `mutates`) |
| F10 | low | `createSession` defaults the profile to `full` when called directly (`opts.profile ?? env ?? 'full'`); `parseProfile` defaults to `desktop`. `instructions` use `process.platform` while the registry honours `opts.platform`; the `profile` option's comment still says "Default full" | `session.ts:177`; `server.ts:121,177` | code | Use `DEFAULT_PROFILE` and `opts.platform` |
| F11 | low | The `screenshot.target_app` description says "Omit for full screen", which is false once a target is set; `scrape` identifies as `computer-use-mcp/7.0.0` | `definitions.ts:101-102`; `admin-handlers.ts:345` | code | |

### 3.2 Carried over from the 10-09 review and still open

| # | Sev | Finding | Where | Confirmed |
|---|---|---|---|---|
| C1 | medium | `scroll` (HID path), `left_mouse_down`, `left_mouse_up`, `multi_select`, `multi_edit` post at unvalidated coordinates; `click` validates | `input-handlers.ts:392-399, 406-429, 604-612, 627-637` | script (I): `left_mouse_down` at (99999, 99999) reached the native call |
| C2 | medium | `prepare_display` state is one shared slot reset on every dispatch including reads; parallel reads can clear a mutation's `hiddenBundleIds` before the result is decorated | `session.ts:402, 512`; `focus.ts:42,83` | code |
| C3 | medium | The Swift helper compile is cached with the first caller's abort signal; a cancelled first OCR call caches `swiftc failed` for ten minutes | `macos-helper.ts:155, 171` | code |
| C4 | medium | `open_application` returns `ok` with `activated: false`; `hide_app` returns `ok` "App not found"; `activate_window` returns `ok` with `window_not_found` | `window-handlers.ts:116-121, 149, 160-161` | code |
| C5 | medium | The OpenAI adapter passes model coordinates unscaled; `openai_computer` screenshots default to 1024 px wide, so on a 2560-point display clicks land 2.5× off | `openai-compat.ts:24-36, 78` | code |
| C6 | medium | `filesystem read` loads the whole file into memory with no size cap; `offset`/`limit` are unbounded; `search` is a substring match documented as a glob; `copy`/`move`/`delete` act on names, not the verified descriptor (acknowledged for write only) | `admin-handlers.ts:124-128, 151-165, 187` | code |
| C7 | medium | `scrape` fetches any URL including loopback and link-local (the run console on 4517, cloud metadata); R6 planned a refusal | `admin-handlers.ts:345` | code |
| C8 | low | The cross-process lock fails immediately with `locked_by_pid` and no wait or retry hint | `session.ts:386-395` | code |
| C9 | low | `resize_window` ignores `window_id` on macOS; `snapshot.display` is accepted and ignored; `#describeCapture` and `annotateScreenshot` assume the main display | `window-handlers.ts:207-216, 243`; `screenshot-handlers.ts:208`; `virtual-pointer.ts:105` | code |

### 3.3 Design findings

- **The guidance layer promises more than the result layer delivers.** Instructions and skill: "say which route you
  used", "results that say the effect is unverifiable". Results: `Clicked (10, 10)`. Until R1 ships, the instruction
  sentence should say what is true today (only pid deliveries report verification).
- **Coordinate semantics change with `delivery`.** `click {coordinate}` is screen points, except with
  `delivery: "pid"` and `target_window_id`, where it is window points (`input-handlers.ts:46-48, 191`); `click_text`
  overrides that with `screen: true`. One `space: "screen" | "window"` argument would be explicit.
- **`set_target` is `readOnlyHint: true`** (live). It changes where every later input goes; hosts that auto-approve
  read-only tools let a model retarget without a prompt. It should be `mutates: false` for the lock but
  `readOnlyHint: false` for hosts.
- **The guard is a UX control, not a safety control** (the 10-09 review said so; still true): `force: true` is
  model-supplied and the instructions ask the model to be good. §6 proposes the person's side of it.
- **Three pause/stop mechanisms exist and none is reachable from the stock server**: the native latch and chord, the
  broker's `pause`/`resume`/`takeover`, the console's `run_cancel` (cooperative). PR #40 adds a fourth. §6 unifies them.

### 3.4 Native layer (reviewer report, verified)

The native reviewer read all seventeen Rust files, the Swift helper and their TypeScript consumers. Every claim below
was checked against the cited lines before inclusion; one of its findings was dropped because the premise is wrong
(the "forced first call contaminates the macOS seed" scenario: `createSession` calls `userGuard.activity()` at
construction, `session.ts:214`, which installs the tap before any input can be posted).

The seven native items from 10-09:

| Item | Status | Evidence |
|---|---|---|
| Guard seeded from the HID idle counter | Fixed on macOS only | `activity.rs:380`; **Windows still stamps `GetTickCount64()` at hook install (`activity.rs:564`) and Linux `monotonic_ms()` (`:809`)**, so with `COMPUTER_USE_USER_IDLE_MS` set there the first guarded call is refused exactly as macOS was |
| `hold_key` cap | Capped in TS; the native hold still sleeps on the Node thread (`keyboard.rs:783`, 10 ms slices, only the latch interrupts, not the host signal) | up to 10 s of event-loop stall remains |
| Untrusted-process input refused | Fixed on every path including `*_to_pid` and `type_keys` | `permissions.rs:92-98`; `keyboard.rs:424, 473, 697, 766`; `mouse.rs:458-786` |
| Windows primary-monitor-only, GDI window capture, no DPI awareness | Not fixed | `mouse.rs:834-843` scales by `SM_CXSCREEN` without `MOUSEEVENTF_VIRTUALDESK`; `screenshot.rs:814 EnumOutputs(0)`; `:1008-1016 BitBlt`; no DPI-awareness call anywhere |
| Windows overlay deadlock (#32) | Cause fixed (`PostMessageW`, `READY` gate, `GetMessageW` -1); `hwnd()` still polls up to 750 ms on the napi thread (`overlay.rs:485-505`); unverified on hardware | |
| Swift helper compiled with the first caller's signal | Not fixed | `macos-helper.ts:137-160, 171` (C3) |
| Linux absence hidden | Not fixed; missing `wmctrl` is replaced by `true` (`windows.rs:66-69`), `hide_app` returns true unconditionally (`apps.rs:160`), and `.status()` children inherit the MCP stdout (`keyboard.rs:144`, `mouse.rs:184-258`, `screenshot.rs:23-87`) so a tool's stdout chatter can corrupt the JSON-RPC stream | |

New native findings, ranked:

| # | Sev | Finding | Where | Verified |
|---|---|---|---|---|
| N1 | high | **No autorelease pool anywhere in the addon.** Node's main thread never pushes one, so every autoreleased object the window, app, capture and AX paths touch (`runningApplicationWithProcessIdentifier:`, `bundleIdentifier`, `localizedName`, `frontmostApplication`, `runningApplications`) leaks for the life of the process; `list_windows` runs two of these per window on every targeted call. A day-long session grows RSS steadily with no report | `windows_macos.rs:88-124, 224-225, 591-596`; `apps.rs:240-405`; `screenshot.rs:293-301`; `accessibility_macos.rs:125-133` | grep: no `autoreleasepool` in `native/src` |
| N2 | high | **Windows: the first DXGI capture of a static desktop returns a never-written staging texture as a screenshot.** Warm-up acquires and releases a frame without copying; the capture then tries `AcquireNextFrame(100)` three times, and on an idle desktop all time out, nothing is copied, and the staging texture is mapped and returned as a fresh image | `screenshot.rs:850-862, 891-938` | code |
| N3 | high | **macOS `activate_window` asserts success it never observed.** An `AXRaise` failure falls back to setting `AXMain`, ignores that result and sets `raised = true`; the timeout parameter is unused; `frontmostAfter` is read right after the asynchronous activation and usually names the previous app; the focus logic keys on `activated` and proceeds to type into the previous app | `windows_macos.rs:565-578, 596-605` | code |
| N4 | high | **Windows: `SendInput` return values ignored on every path**, so input blocked by UIPI (an elevated target from a non-elevated host) inserts zero events and the tool says "Clicked" or "Typed" | `keyboard.rs:903-905, 993-995`; `mouse.rs:828, 859-861, 903-905` | code |
| N5 | medium | AX walks and `activate_window` set no messaging timeout (only `get_window_ax_info` sets 0.4 s), so a busy app (Unreal compiling shaders) stalls the whole server for the default 6 s per round trip across up to 500 nodes | `accessibility_macos.rs:421`; `windows_macos.rs:435, 704` | grep |
| N6 | medium | The macOS tap never re-enables itself after `kCGEventTapDisabledByTimeout` / `ByUserInput`; the clock then freezes and the guard reads the user as idle forever while `doctor` still says the clock is available | `activity.rs:310-382` (only the initial `tap.enable()`) | grep |
| N7 | medium | Windows `write_clipboard` empties the clipboard and discards the `SetClipboardData` result, then returns Ok; a long `type` routes through paste, pastes nothing, reports "Typed" | `clipboard.rs:164-177` | code |
| N8 | medium | Windows UIA `perform_action` ignores `Invoke()` / `Toggle()` results and returns `performed: true` | `accessibility.rs:435-442` | code |
| N9 | medium | Windows `capture_window`: `GetWindowRect`, `BitBlt` and `GetDIBits` results ignored; the rect includes the invisible DWM border so the image-to-screen mapping is off; minimised windows yield garbage | `screenshot.rs:1004-1039` | code |
| N10 | medium | Secure Event Input (a password field, a `sudo` prompt) and elevated windows hide keystrokes from the clock on both platforms; a user typing a password reads as idle | `activity.rs:501-535` | reasoning; see §8 |
| N11 | low | The latch is handled inconsistently: `type_text`, `mouse_move`, `scroll` and `drag` return `Ok(())` when latched while `key_press` errors; `type_keys` counts dropped characters as typed. Mitigated by the session-level check | `keyboard.rs:470-472, 739-740`; `mouse.rs:455-457, 688-703` | code |
| N12 | low | `drain_runloop` loops while `CFRunLoopRunInMode` returns `kCFRunLoopRunFinished` and breaks after the first handled source, the inverse of the intent; harmless at a 1 ms pump but ~1,000 native calls per second idle on two threads (the pump and the supervisor's 25 ms wait that sleeps 1 ms per iteration) | `overlay.rs:60-69`; `apps.rs:220-229`; `lock.ts:228-241`; `activity.rs:204` | code |
| N13 | low | `activateWithOptions: 1` is `ActivateAllWindows`, not `IgnoringOtherApps` (`1 << 1`) as the comment says; `release_agent_held_buttons` tracks the left button only; `type_text` chunks UTF-16 at 20 units and can split a surrogate pair; the key table is built once per process so a layout change is never seen; Spaces mutations return `removed: true` / `destroyed: true` with no check | `apps.rs:291`; `mouse.rs:441`; `keyboard.rs:474, 689`; `spaces_macos.rs:508-589` | code |

Parity, in one line each: macOS alone has pid delivery, SCK capture and OCR, layout-aware `type mode: "keys"`, the
menu bar, the permission probe and the HID-seeded clock; Windows alone has a native clipboard, batched Unicode typing
and an `activate_window` that polls; Windows lacks multi-monitor input and capture, DPI awareness, occlusion-safe
capture and any background delivery; Linux lacks native accessibility, window bounds (hard-coded 0), display scale,
the overlay, the chord and Wayland capture.

### 3.5 Host services (reviewer report, verified)

The host-services reviewer read the console, broker, Tasks, HTTP, browser, runtime and supervisor modules. One
sub-claim was dropped after checking: the argument hash excludes `approval_token` (`registry.ts:104`), so a host that
adds the token only on the re-entry round does not get `invalid_request_state`.

| # | Sev | Finding | Where | Verified |
|---|---|---|---|---|
| HS1 | **high** | **The run console host applies its Host and Origin checks to `/mcp` only.** `/rpc`, `/driver`, `/driver/activity`, `/driver/usage`, `/run-id` and `/attachment/N` are served to any origin, with any `Content-Type`, with no body cap. A `text/plain` POST is a CORS simple request, so any web page the person has open can `fetch('http://127.0.0.1:4517/driver', {mode:'no-cors', body:'{"capture":true,...}'})` to capture the screen through the shared session, or `/rpc {name:'run_say', arguments:{text:…}}` to append a turn the agent is told to obey (remote prompt injection into a desktop-control agent), or `run_cancel`. With DNS rebinding the same routes read the whole transcript, the latest frame and the person's uploaded images. The README's "loopback-only and unauthenticated" describes `/mcp` | `run-console-host.ts:279-283, 347-348, 354-429` | code: the validators run inside `if (url === '/mcp')` only |
| HS2 | **high** | **The console page's `message` listener trusts any window and the page is frameable.** It handles `tools/call` from any `postMessage` without checking `event.source` or `event.origin`, and no `frame-ancestors` is sent, so an attacker page can embed the console in a hidden iframe and inject or cancel without a cross-origin fetch | `run-console-host.ts:101-118, 275-278` | code; grep: no `frame-ancestors` |
| HS3 | medium | `tasks/cancel` aborts the signal and **releases the session lease immediately**, but four of the five task-eligible tools never read the signal (`scrape` uses its own 15 s timeout; `get_ui_tree`, `get_app_dictionary`, `snapshot` are synchronous), so a "cancelled" task still drives the desktop while the lease says it does not | `mcp-tasks.ts:95-100, 363-371`; `admin-handlers.ts:345` | code |
| HS4 | medium | **The bundled HTTP runner gives every request a fresh desktop session.** `http.ts` passes no `session`; the handler builds a server per request and each server creates and closes its own session, so `set_target`, the last screenshot, the agent pointer and the helper lock state do not survive between calls | `http.ts:23`; `server.ts:252, 371-380, 347-350` | code |
| HS5 | medium | The emergency-stop supervisor is **one-shot and its worker's exit is unobserved**: the worker breaks after the first takeover; the parent listens for `message` and `error` only; after one takeover the chord is silently unmonitored. No test references `supervisor` | `supervisor-worker.ts:12, 19`; `supervisor.ts:13-19` | code |
| HS6 | medium | **The agent can write `role: "user"` turns.** `run_say` accepts `role` from any `/mcp` caller; the console renders it as the person's bubble and `pending()` reports it as an unanswered instruction to the next turn, so a prompt-injected agent can plant its own orders | `agent-run.ts:775-779` | code |
| HS7 | low | Tasks retention: 4 MiB × 256 results kept for the full TTL and, with a file store, persisted unredacted (UI trees, images) | `mcp-tasks.ts:120-154`; `task-store.ts:23-30` | code |
| HS8 | low | `http.ts` validates `COMPUTER_USE_HTTP_PORT` and the host at import time and throws on an empty port, the class of start-up death `env.ts` removed elsewhere | `http.ts:12-20` | code |
| HS9 | low | The launcher suffix-matches `argv[1]` instead of using `isModuleEntrypoint`; a bin symlink under another name exits 0 silently (the case the launcher was written for) | `launch.ts:51-55`; `entrypoint.ts:45-53` | code |
| HS10 | low | The console brand is interpolated with a string replacement value, so an operator brand containing `$'` or `` $` `` splices the template | `run-console.ts:81-83` | code |
| HS11 | low | `packages/computer-use-remote` and `packages/computer-use-supervisor` are empty directories (no `package.json`); their only footprint is the env strip in `spawn.ts:42` and an AGENTS.md row. `desktop_act` journals a failed action as `isError: false` with `status: 'unknown_outcome'` inside `structuredContent` | `packages/`; `desktop-broker.ts:242-244` | ls; code |

Worth keeping, verified: every model or host value in the console UI goes through `textContent`; captures happen only
server-side; frames are never persisted; task ids are CSPRNG; request state is HMAC-bound to tool and arguments with
one-shot approval ids; the browser backend re-checks origin per route and blocks redirects; `http.ts` refuses
non-loopback binds.

### 3.6 Tests, CI and packaging (reviewer report, verified)

The reviewer ran `npm test` (537 / 536 pass / 1 skipped), `npm pack --dry-run`, a scratch build of `pr-40`, and read the
CI logs. Verified here: the workflow lines, the test regex, the Linux native path, the E409 log line and the absence of
any `_meta` token test.

| # | Sev | Finding | Where | Verified |
|---|---|---|---|---|
| T1 | high | **`files` enumerates `dist` modules by name**, so any new `src/*.ts` module breaks the published package while all five test jobs stay green (they run from the checkout) and the package job's static required list cannot know about it. This is PR #40's failure, and it will be the next contributor's | `package.json:107-211`; `ci.yml:273-282` (`input-handlers.js` listed twice) | reproduced: pack of `pr-40` lacks `dist/status-overlay.js`; CI log run 38025257040 |
| T2 | high | **The stage job fails on a pending stage and double-stages.** Commit 13d084f's run 37926218430 failed with `npm error code E409 … Cannot stage previously published version "7.6.0"` while 7.6.0 was staged and awaiting approval; the next push staged 7.6.0 again. The "already published" skip (ci.yml:427-436) does not cover "already staged" | `ci.yml:419-442` | `gh run view --log-failed`: the E409 line at 11:57:24Z |
| T3 | medium | `concurrency.cancel-in-progress: true` applies to `main` pushes, so a second push can cancel a stage job mid-`npm stage publish` | `ci.yml:9-11` | code |
| T4 | medium | The suite runs on Node 20 only; the install matrix (20, 22, 24, current) is Linux-only and only imports entry points without loading the addon | `ci.yml:182, 294-322` | code |
| T5 | medium | No MSRV pin and no `cargo fmt --check` although CONTRIBUTING requires fmt clean and AGENTS.md sets 1.94.1; CONTRIBUTING says "1.70+" | `ci.yml`, `native/Cargo.toml` | grep |
| T6 | medium | **The Linux CI "real input" smoke verifies nothing**: `smoke-new-tools.mjs` clicks at (100, 100) on all five runners, and on Linux with no X server `mouse_move` returns silently when `XOpenDisplay` fails. The Linux test job installs no xvfb, wmctrl, xdotool, scrot or xclip | `mouse.rs:33-35`; `ci.yml:64, 213` | code |
| T7 | medium | The Swift helper is never compiled in CI; both helper suites use a fake runner and a shell-script "binary", so a Swift syntax error ships | `test/v7.5-agent-desktop.test.mjs:20-42`; `test/v7.6-helper-serial.test.mjs:12-34` | code |
| T8 | medium | The published `bin` (`dist/launch.js`) and `dist/http.js` are never executed by any test or job; only `checkInstall` is unit-tested | `test/v7.5.1-startup.test.mjs` | grep |
| T9 | medium | **The 7.6 `_meta["computer-use/approval_token"]` path has no test**; every token test uses the legacy argument | `registry.ts:347-348` | grep: nothing in `test/` |
| T10 | low | The instruction-coverage test only checks names containing an underscore, so single-word tools (`registry`, `snapshot`, `scrape`, `zoom`, `click`, `wait`) are never checked in the "mentioned but not listed" direction; the budgets are measured in-process over `InMemoryTransport` on darwin only | `test/v7.6-tool-surface.test.mjs:31, 42, 56, 175` | code |
| T11 | medium | The six per-platform packages still 404 (checked today), nothing builds or publishes them, and `native.ts:94` still tells users to install them (issue #36, no reply since 10-08) | `src/native.ts:72-97`; `packages/` | `npm view` |
| T12 | low | darwin-x64 is cross-compiled and executed by no job; `cargo test` runs on three of six targets | `ci.yml:29-33, 109-151` | code |
| T13 | low | README images use relative paths against the org rule of absolute `raw.githubusercontent.com` URLs, which is also why 1.3 MB of media ships in the tarball; `scripts/verify-input-attribution.mjs` requires the generic `computer-use-napi.node` that the published tarball does not contain; `workers/` ships but its Dockerfile needs a lockfile npm never packs; `docs/releases/v7.3.0.md` is not in `files` | `README.md:12-56`; `scripts/verify-input-attribution.mjs:9`; `workers/linux/Dockerfile` | code |
| T14 | low | CONTRIBUTING names `npm run demo`, `examples/browser-test.ts` and `examples/demo-v4.ts`, none of which exist | `CONTRIBUTING.md:13, 127-129` | ls |
| T15 | low | The Linux Docker worker installs AT-SPI and the X libraries but none of `wmctrl`, `xdotool`, `scrot`, `xclip`; it is built by no job (issue #21 remains unanswerable from CI) | `workers/linux/Dockerfile:3` | code |
| T16 | low | Tags are manual and unchecked: v7.3.0 and v7.5.0 are untagged; published tarballs carry no `gitHead`, so the commit link lives only in the attestation | `git tag -l`; CONTRIBUTING.md:145 | `git`, `npm view` |

Coverage gaps worth closing first: the `_meta` token (T9); "not callable" for a macOS-only tool on win32 and for Spaces
on linux (one weak assertion today); an alias (`right_click`) end-to-end over a transport; the start-up guard seed;
`destination` enforcement for `filesystem copy/move`; `process_kill` POSIX kill and list parsing; the never-dispatched
tools `cursor_position`, `read_clipboard`, `list_running_apps`, `hide_app`, `list_displays`, `list_menu_bar`; the Linux
AT-SPI bridge; `doctor` with a real native.

## 4. Pass 3: the field, as of 2026-10-11

What changed since the 10-09 research input (`2026-10-09-inputs/research-computer-use-gaps.md`), from primary sources:

| Tool | New since 10-09 (date) | What it means for this repository |
|---|---|---|
| **Windows-MCP 0.8.8** (CursorTouch, Python) | Oct 10: PR #445 "Show AI control, temporarily block physical input, and allow user takeover": a breathing blue glow at the screen edge and around the cursor, a top notice with the takeover shortcut, hidden during capture (an orange flash acknowledges a capture); physical input intercepted by a low-level hook while the indicator is confirmed visible; takeover on substantial mouse movement or `Ctrl+Alt+Shift+Backspace`; an amber "takeover pending" state; AI resumes after 10 s of no physical input and all keys released; a read-only `ControlStatus` tool; honest limits ("best-effort, not a security boundary"; Windows can silently remove a low-level hook) | The closest shipped answer to PR #40, one day older, and already better on four points: indicator hidden from captures, takeover on physical input, a state the model can query, documented limits. Also: #450 lets callers exclude processes from UIA traversal (our #383-class risk), #451 moves UIA calls to a dedicated thread |
| **Peekaboo 4.9.0** (Oct 7), 4.8, 4.7, 4.6 (Sep 22 to Oct 4) | Overlays shown from a hidden companion app without activating it; CLI and MCP summaries state when a receiver effect is "unverified or unreported"; accepted dispatch evidence kept after an unchanged read-back so it is not reported as a no-op; signed receipts bound to the native observation; unattended clipboard reads refused before the macOS privacy prompt; exact-window background drag, selection and scrolling; `see --fresh` | Receipts and unverified-effect wording are the R1 contract, shipped weekly. The hidden-companion overlay is the macOS technique for §6's HUD |
| **cua-driver-rs 0.34.1** (Oct 9) | `display_only` on `get_window_state` for live previews; GNOME windows captured from their own actor; waits for libei input acknowledgement; Windows background article: UIA first, `PostMessage`, `SendInput` only with `dispatch:"foreground"`; `PrintWindow`, then Windows.Graphics.Capture for occluded windows, `BitBlt` last and marked; the agent's cursor is a click-through layered window with a `cursor_id` per agent | The Windows capture ladder answers the 10-09 "occlusion-safe Windows capture" gap with named APIs. The action-support ledger is oracle E2E per OS (Win32 122/122, Quartz 145/145, X11 116/116) |
| **Codex Computer Use** (OpenAI, closed) | Own cursor coloured from the wallpaper, wiggles while thinking, several cursors in parallel (MacStories); a purple window-capture indicator replaces the traffic lights; "Always allow" per app, admin-restrictable; terminals and ChatGPT itself cannot be automated; locked-Mac mode relocks on local input; Windows is foreground-only ("step away, use a VM, or use remote control"). Open issue #46847 (Sep 20, no maintainer reply): up to four orphaned cursor overlays after tasks finish; only a full app restart clears them | The orphaned-overlay issue is the lifecycle requirement for any HUD (§6.3.9). The per-app "always allow" and admin restriction match `COMPUTER_USE_ALLOWED_APPS` plus an approval memory this server lacks |
| **Claude Code CLI / Desktop** | CLI: per-session app approval with sentinel warnings; apps hidden and auto-restored; terminal excluded from screenshots; macOS notification "Claude is using your computer · press Esc to stop", Esc consumed; one lock per machine. Desktop: tiers (browsers and trading view-only, terminals and IDEs click-only), denied-apps list, "unhide apps when Claude finishes" toggle, background mode on macOS 15+ that "generally waits if you're typing", a permission prompt the first time a task needs the full screen; the API toolset `computer_toolset_20260801` (17 members, batch with halt-text rule, `hold_key` and `wait` ≤ 300 s, `left_click` takes `text` for held modifiers) | The guard here waits for the user as Claude does; what is missing is the consumed Esc, the capture exclusion, the automatic unhide (F3) and the tiers. The toolset's `left_click {text}` modifier form is worth accepting on `click` |
| **Hermes** (wraps cua) | Tinted overlay cursor glides to each target, "the real OS cursor never moves"; unattended runs refuse rather than auto-approve; hard-blocked chords (empty trash, lock, log out) and typed patterns (`curl \| bash`); 20-image screenshot eviction | R6, still planned here |
| **Microsoft** | Agent workspace: a separate standard account per agent, contained desktop, pause/stop/takeover controls, non-repudiation; still gated behind "experimental agentic features" | The platform answer to "who is driving"; a process-level HUD remains the answer for everyone else |
| **MCP Apps** | Stable spec stays 2026-01-26 (`io.modelcontextprotocol/ui`); the core 2026-07-28 revision does not change it; Claude Code still renders no apps | The run console's MCP App remains host-limited; a native HUD is the only visual a person gets in Claude Code |

What to take, ranked by value over cost: (1) the honest-effect wording in every summary (Peekaboo, cua) is R1 and is
the single biggest trust gain; (2) an indicator that is hidden from captures and a takeover on physical input
(Windows-MCP, Claude Code) is §6; (3) the Windows capture ladder with named APIs (cua) closes the oldest Windows gap;
(4) the per-app approval memory and tiers (Codex, Claude) fit the existing policy layer; (5) a consumed global stop
(Claude Code) is F7.

## 5. PR #40: "feat(windows): add an optional floating Computer Use status card" (ShakeCrane, Oct 10)

### 5.1 What it does

425 lines: `src/status-overlay.ts` (a `WindowsStatusOverlay` that owns a temp directory with `state.json` and
`control.txt`), `libexec/windows-status-overlay.ps1` (a WPF window built from inline XAML: elapsed time, four step
labels, Pause/Resume, Stop, collapse), a change to `createSession` that wraps `dispatch` (veto mutations when paused or
stopped, abort in-flight calls through `AbortSignal.any`, record a friendly step label per call), three tests, a doc
page, three off-screen renders and a README paragraph. Opt-in with `COMPUTER_USE_STATUS_OVERLAY=1`, Windows only, real
native only.

### 5.2 Why CI is red

The four "Install packed tarball" jobs fail with `ERR_MODULE_NOT_FOUND .../dist/status-overlay.js imported from
dist/session.js`: `package.json` lists `dist` files one by one and the PR did not add `dist/status-overlay.js` and
`.d.ts` (and `libexec` is already shipped as a directory, so the script is fine). One line fixes it; the tests and CI
reviewer notes the deeper problem, that a runtime import can be left out of the tarball at all (§3.6).

### 5.3 Findings, ranked

| # | Sev | Finding | Where |
|---|---|---|---|
| P1 | high | **The card appears in the agent's own screenshots and swallows the agent's clicks.** It is a normal topmost WPF window at the top centre of the work area (344×213), not click-through, not hidden during capture. Every `screenshot` includes it (Windows capture is the screen), so the model sees a "Stop" button it can click, and a `click` whose coordinates fall under the card hits the card and is reported `Clicked`. Windows-MCP hides its indicator during capture; Claude Code excludes the terminal; cua's overlay is click-through | `windows-status-overlay.ps1:13-20, 96-98`; no capture coupling |
| P2 | high | **An orphaned card after a server crash.** The panel closes only when `control.txt` is deleted or says `stopped`; a Node crash leaves the temp directory and the file saying `running`, so the card stays on screen forever, as Codex's orphaned cursors do (#46847). It should watch the parent pid | `.ps1:117-126`; `status-overlay.ts:111-122` |
| P3 | high | **A fourth stop mechanism, cooperative, beside a native hard stop that it does not use.** Stop sets a flag and aborts a signal; the native latch (`triggerNativeEmergencyStop`) would stop the actuators mid-gesture and refuse everything until a trusted reset, on both platforms. The PR's docs say "use the project's existing trusted-host native emergency stop for high-risk situations", which the stock server never arms (F7) | `status-overlay.ts:66-69`; `session.ts:319` |
| P4 | medium | **Pause does not trigger on the person's own input.** The card has to be clicked; meanwhile the user-active guard already knows when the person is typing. Windows-MCP and Claude Code's background mode pause on physical input | |
| P5 | medium | **The labels hide what matters.** `friendlyToolName` buckets `click` as "Selecting" and `type` as "Typing" with no app or window; `run_script`, `filesystem`, `process_kill` and `registry` fall through to a raw name; `wait_for_window` and `get_window` become "Opening an app"; `hold_key` becomes "Typing". A person watching cannot tell a click in Notepad from a click in their banking app | `status-overlay.ts:119-126` |
| P6 | medium | **Windows-only, with a parallel implementation.** The repository already has a native always-on-top, non-activating, click-through overlay window on both platforms (`overlay.rs`: an `NSPanel` with `ignoresMouseEvents`, a `WS_EX_LAYERED \| WS_EX_TRANSPARENT \| WS_EX_NOACTIVATE` window) with a message-pumped thread that was hardened for #32. A second UI stack (PowerShell, WPF, file polling at 150 ms and 180 ms) brings its own failure modes (PowerShell execution policy, the 1 to 2 s PowerShell start, antivirus prompts, a `powershell.exe` child per session) | `overlay.rs:150-210, 317-440` |
| P7 | medium | **Any same-user process can resume or stop the agent** by writing `control.txt`; the directory name is unguessable, which is a mitigation, not a boundary; the PR does not say so | `status-overlay.ts:34-36` |
| P8 | low | Not in `doctor`, `policy_status`, the instructions, the catalog or the CHANGELOG; `=1` where every other boolean here is `=true`; the README paragraph lands in "Set up your agent" ahead of the requirements; the tests reach TypeScript `private` fields from JavaScript | |
| P9 | low | Good: opt-in, headless under an injected native, atomic `state.json` writes, `0o600` files, no network, `AbortSignal.any` so a paused call aborts, honest "cooperative, not an emergency stop" doc, and off-screen renders labelled as such | |
| P10 | low | `AbortSignal.any` exists from Node 20.3 while `engines.node` says `>=20`; the new `dispatch` branch (veto, signal merge, `close()`) has no test, only the class in isolation; `tool !== 'doctor' && tool !== 'policy_status'` is a hand list where the catalog's `job === 'meta'` exists | `session.ts` on `pr-40`:545-568 |

### 5.4 Verdict

Do not merge as is; keep the contributor. The idea (a person-facing control surface on the desktop) is the most
requested thing in every tracker surveyed in §4 and the repository has every primitive to do it well. Ask for: the
`files` entry (P8 fix for CI), parent-pid watching (P2), hiding during capture or click-through (P1), and the native
latch for Stop (P3) as the minimum; or, better, invite the contributor onto §6 and land the Windows HUD there.

## 6. Taking the idea further: an operator control plane

### 6.1 The idea is right; the layer is wrong

A status card answers "is an agent driving my machine, what is it doing, how do I stop it". That is an operator
concern and it belongs beside the user-active guard, the native latch and the broker's pause and takeover, which already
exist and are already the things a person needs, not in a per-tool wrapper that re-derives state from tool names.

### 6.2 What exists already

| Primitive | Where | Status |
|---|---|---|
| Native hard stop: latch checked by every actuator and in `interruptible_sleep`; physical chord (two modifiers plus Escape or F12) on macOS and Windows; generation counter; `wait_for_native_emergency_stop` for a worker | `activity.rs` | Built, tested, never armed by the stock server (F7) |
| Session refuses mutations while latched | `session.ts:319` | Built |
| Broker: `pause` (model-safe), `resume` (trusted host), `takeover` (physical input or latch), per-record `AbortController`, observations invalidated on pause | `desktop-broker.ts` | Built, host-embedding only |
| Supervisor worker: arms the chord, pauses on physical input when the monitor distinguishes injected events | `supervisor*.ts` | Built, host-embedding only |
| User-active guard: knows the last physical input, refuses takeover within 4 s | `user-activity.ts` | On by default (macOS) |
| Native overlay window: always-on-top, non-activating, click-through, on both platforms, message-pumped thread | `overlay.rs` | Draws one dot (`agent_pointer`) |
| Run console: plan, task states, narration, transcript, `run_cancel` | `agent-run.ts` | Built, browser-rendered, needs the host |
| Approval: token, host elicitation, MRTR one-shot | `registry.ts`, `legacy-policy.ts` | Built; no path when the host has no elicitation and no token |

### 6.3 Design

1. **One state machine, in the session, on every platform:** `running → paused → running`, `running → takeover →
   running` (automatic), `* → stopped` (latched; trusted reset). Exposed to the model as a read-only
   `control_status` tool (state, reason, since, who: `person` | `physical_input` | `host` | `chord`, the last refused
   call) and in every refusal (`paused_by_user`, `takeover`, `emergency_stop_active`), so a model stops guessing (the
   Windows-MCP `ControlStatus` shape). The console's `cancel_requested` maps onto it.
2. **Stop is the native latch.** The HUD's Stop and the chord both call `triggerNativeEmergencyStop`; actuators stop
   mid-drag, the session refuses, the HUD shows "Stopped: press the chord again or run `computer-use-mcp --reset`"
   (reset is a person's action, never the model's). Arm the chord in `createSession` on macOS and Windows by default
   (`COMPUTER_USE_EMERGENCY_CHORD`, default `ctrl+alt+escape`; `none` to disable); consume the chord key so injected
   text cannot dismiss a dialog with it. `doctor` gains `emergency_stop`.
3. **Takeover is automatic.** The guard already stamps physical input; when input arrives while a mutating call is in
   flight, abort the call's signal, release held buttons and modifiers (`mouse_drag` already does this in `finally`),
   enter `takeover`, and resume after `COMPUTER_USE_USER_IDLE_MS` of quiet, exactly the guard's threshold. No click on
   a card needed; the card shows "You took over · resuming when you stop" (Windows-MCP's amber state).
4. **The HUD is the existing native overlay, grown up.** Extend `overlay.rs` from one dot to a small panel: the same
   `NSPanel` (non-activating, `ignoresMouseEvents` except on its three buttons) and the same layered Win32 window.
   Content: a coloured ring around the agent pointer (already drawn); a 2 px frame around the target window (Codex's
   purple frame, from `get_target`); a one-line status: state, elapsed, the current task title from the run plan when
   there is one, else the honest action ("click in TextEdit · Untitled", "type 24 chars into Safari · Login", "run
   AppleScript (approval pending)"), never a bucketed verb; the three controls, Pause, Stop, Approve/Deny when an
   approval is pending; the chord as a hint. Linux gets the text-only status through the console until an X11 overlay
   is worth writing.
5. **Hidden from captures, by construction.** Window captures through ScreenCaptureKit and `target_window_id` never
   include it; for screen captures the native capture path hides the overlay for the frame (`overlay.rs` owns the
   window, `screenshot.rs` can ask it) and the Windows path excludes it with `SetWindowDisplayAffinity` /
   `WDA_EXCLUDEFROMCAPTURE`. The agent never sees its own controls, so it cannot click them and injected text cannot
   point it at them.
6. **Approvals through the HUD.** When policy needs approval and the host has no elicitation and no token, the HUD's
   Approve/Deny is the approver, with the same bounded scope text the elicitation shows (tool, app, window, script
   hash). That closes the "approval needed, nobody to ask, so the call fails" path for Claude Code and every host
   without elicitation, and it is a person's click on a window the model cannot see or reach. R6's `no_approver`
   refusal stays for unattended runs.
7. **Per-app memory.** "Allow this app for this session" on the first mutating call to an app not in
   `COMPUTER_USE_ALLOWED_APPS` (Codex's "Always allow", Claude's per-session approval), with the sentinel warnings for
   terminals, Finder/Explorer and settings; stored in the session, surfaced in `policy_status`.
8. **Honest labels come from R1, not from tool names.** The status line is the action's `route`/`effect` once R1
   lands ("click · pid · changed"); until then it is tool, app and window from the resolved target, which the session
   already knows at dispatch.
9. **Lifecycle.** The overlay is owned by the native thread the session already pumps; it is hidden on dispose, on
   `exit`, on the lease release path (`forceRelease`), and the thread watches the owning process so a crashed server
   cannot leave it (the Codex #46847 failure). One HUD per machine: the cross-process lease holder owns it; a second
   server shows nothing and reports `locked_by_pid` with the holder's HUD visible.
10. **Profiles and surface.** `control_status` is `core` and read-only; `control_resume`, `control_reset` are host-only
    (never model-callable) like the broker's `resume`; the HUD is on by default where the overlay exists
    (`COMPUTER_USE_HUD=false` to disable), because an indicator that is off by default protects nobody.
11. **Tests.** The state machine and the refusals with a fake native (like the guard tests); the overlay exclusion
    with a capture of a known pixel under the panel; the orphan test (kill the server, assert the panel is gone within
    a second); a smoke on macOS CI that arms the chord and reads `doctor`.

### 6.4 Phasing

| Step | Content | Size |
|---|---|---|
| 1 | Land from #40: the opt-in gate, the dispatch veto and signal, the tests, with `files` fixed, parent-pid watching and capture hiding; keep the WPF card behind the flag as the Windows interim UI | days |
| 2 | Arm the native chord by default; `control_status`; Stop through the latch; `doctor` and instructions updated (F7) | days |
| 3 | Takeover on physical input via the guard; automatic resume | days |
| 4 | The native HUD on macOS (NSPanel) and Windows (layered window), capture exclusion, target frame, run-plan title | 1 to 2 weeks |
| 5 | Approvals and per-app memory through the HUD | 1 week |

## 7. Recommended order of work

_Same day: James asked for the 7.6.1 list and a cross-platform status card to be built. The work and its verification are tracked in [`docs/specs/v7.6.1-fixes/tasks.md`](../specs/v7.6.1-fixes/tasks.md); the items below marked for 7.6.1 are in the working tree, uncommitted._

1. **7.6.1, this week (correctness and the two console holes):** F1 (`full_screen`), F3 (auto-unhide, or
   `unhide_app` in `core`), F4, F5, F2, F8, F9, F10, F11; C1, C3, C4; HS1 and HS2 (Host/Origin on every console route,
   a per-launch token for `/rpc` and `/driver*`, `frame-ancestors 'none'`, `event.source` check); HS6 (drop `role`
   from `run_say`); N3, N7, N8 (check the return values); T1 (`"dist/"` in `files`, or a pack-contents assertion that
   fails with the file name); T2 (skip when the version is pending); the instruction sentence about `effect` made
   true; reply to #36 and #21; the PR #40 asks in §5.4.
2. **7.7 honest actions (R1, R2, R5, R6)** as specified on 10-09, with the Peekaboo and Windows-MCP wording as the
   reference: `effect` and `route` on every action, typed refusals, `capture_id`, hard-blocked chords, `no_approver`,
   `scrape` host rules, the cross-process lock wait; plus N1 (autorelease pools), N2 and N4 (Windows capture and
   input truth), N5 and N6 (AX timeouts, tap re-enable), HS3 to HS5, T4 to T9.
3. **7.8 operator control plane (§6)**, steps 1 to 5, with the #40 contributor on the Windows half; F7 lands in step 2.
4. **8.0 app bridges** as specified on 10-09, unchanged; the Windows capture ladder (cua: `PrintWindow`, then
   Windows.Graphics.Capture, then marked `BitBlt`) and DPI awareness belong to whichever Windows contributor takes
   #32 and #36.

## 8. Not verified here

- Windows and Linux runtime behaviour (CI builds and unit-tests there; no desktop run); the PR #40 panel was not
  launched.
- Whether `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` excludes a layered window from DXGI duplication on
  Windows 11 (documented for Windows 10 2004+, untested here), and whether ScreenCaptureKit's `excludingWindows`
  covers the NSPanel in a display capture (it does for window captures by construction).
- Codex's and Claude's indicator wording is from the vendors' docs and a review, not from running them.
- Whether Windows-MCP's low-level hook survives UIPI and secure desktop transitions; the PR says it does not claim to.
- Whether a listen-only CGEventTap is subject to `kCGEventTapDisabledByTimeout` (N6's severity depends on it), and
  whether D3D11 staging textures are zero-initialised (N2: black versus garbage).
- The browser-side behaviour of the console CSRF path (HS1): nothing was executed; the reasoning is from the route
  code and the CORS simple-request rules.
- Whether the hosted `macos-14` runner is trusted for Accessibility, that is whether the CI smoke clicks land or the
  trust check is not on that path; the log only shows PASS.
- The Rust unit tests (cargo was not run here) and whether the Swift helper compiles on the CI image (no job tries).
