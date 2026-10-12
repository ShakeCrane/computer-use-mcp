# Development scripts

Run from the repository root after installing dependencies. Live desktop scripts
need a native build and OS permissions. They are not unattended unit tests.

| Command | Purpose |
|---|---|
| `npm test` | Build TypeScript and run the automated regression suite. |
| `npm run smoke` | Check native display/window access and application discovery without injecting input. |
| `npm run test:browser` | Exercise the isolated browser on a disposable local fixture. |
| `node scripts/test-office.mjs` | Create and verify scratch Word, Excel and PowerPoint files on macOS. |
| `npm run test:input-attribution` | Measure physical-input detection on a supported desktop. |
| `npm run measure:efficiency` | Compare catalog and observation payload sizes. |
| `npm run evaluate:strategy -- baseline.json candidate.json` | Compare matched, independently verified task traces. |
| `npm run prepare:packages` | Stamp platform manifests and copy available native binaries. |

`build-ts.mjs` compiles TypeScript into `dist.next` and swaps it into `dist`, so a server starting mid-build still finds its files (`clean-dist.mjs` only removes generated output). `live-windows.mjs` is
an attended Windows development probe. Legacy Mission Control/Spaces experiments
and obsolete v3–v5 scripts were removed in v7.2; their history remains in Git.
Only `verify-input-attribution.mjs` is included as a script in the npm package.

## `npm run integration:macos`

`scripts/integration-status-card.mjs`: a live integration test on a macOS desktop (7.6.1). It starts the real server
in-process with `COMPUTER_USE_STATUS_CARD=true`, opens Calculator, computes 1 + 2 by accessibility, verifies the result
(accessibility and OCR), presses the status card's Pause, Resume and Stop as a person would (raw native clicks, not tool
calls), checks that the card never appears in the agent's screenshots, that Stop trips the native emergency-stop latch,
and that nothing is left on screen after the session closes. It waits for you to stop typing (the user-active guard
refuses to take focus within 4 s of physical input), so keep your hands off for a minute. Nothing is written outside a
temp directory; Calculator is quit at the end.
