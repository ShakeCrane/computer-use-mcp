# ADK-Rust + Claude desktop agent

A Rust agent on [ADK-Rust](https://github.com/zavora-ai/adk-rust) with the Anthropic model provider (`adk-model`'s
`anthropic` feature) driving a desktop through `computer-use-mcp`, started as a child process over stdio with the
desktop status card on. The person at the machine sees what the agent is doing and can pause or stop it; the agent is
told what `user_active`, `paused_by_user` and `stopped_by_user` mean and reports instead of retrying.

```bash
export ANTHROPIC_API_KEY=...
cargo run --manifest-path agents/adk-anthropic-agent/Cargo.toml -- "Open Calculator and compute 42 * 58"
```

- Default task (no argument): a screenshot and a three-sentence description, nothing clicked or typed.
- `COMPUTER_USE_MCP_BIN=/path/to/computer-use-mcp/dist/launch.js` runs a checkout's build instead of the published package.
- `ANTHROPIC_MODEL` picks the model (default `claude-opus-5-5`); `COMPUTER_USE_PROFILE` the tool surface (default
  `desktop`, the 7.6.1 default list, which is also the auto-approve list in `src/main.rs`).
- Needs Node 20+ (`npx` starts `@zavora-ai/computer-use-mcp`), a signed-in desktop, and on macOS Accessibility and
  Screen Recording granted to the terminal that runs the binary. The card is compiled on first use with `swiftc`.
- The `Cargo.toml` points at an ADK-Rust checkout at `../../../../adk-rust` (projects/adk-rust beside projects/mcp-servers) (the 3.x API is not on crates.io yet);
  change the paths or add a `[patch]` section for your layout.

What you see while it runs: each tool call and its result on stdout, and the card on the desktop. Press **Pause** and
the next mutating call comes back `paused_by_user`, which the log marks "the person is in control"; press **Stop** and
the agent reports what it has and finishes.

For a governed version of the same loop (every action previewed, approvals bound to the exact action, reservations
with deterministic cleanup, identity from `adk-auth`), ADK-Rust ships `adk-computer-use`, a deterministic graph over this
server; this example is the plain agent, which is the right starting point for a task you watch from the card.

## Known limitation (ADK-Rust 3.0.0, 2026-10-11)

`adk-tool`'s MCP bridge carries image blocks out of a tool result as `inline_data`, but `adk-model`'s Anthropic
converter (`anthropic/convert.rs`, `tool_result_content`) turns every function response into a string, so the
`screenshot` image never reaches Claude as an image block. In the first run of this example the agent noticed
("the screenshot tool returned no image"), fell back to `list_windows` and `read_window_text`, and reported what it
could and could not verify, which is the behaviour the instruction asks for. Until the converter forwards
`inline_data` as `image` blocks inside `tool_result`, prefer OCR and accessibility tasks here, or run the JavaScript
`claude-agent` example, which hands the image to the API directly.
