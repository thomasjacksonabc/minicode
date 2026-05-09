# Iteration 2 Demo

This demo validates the Iteration 2 scope: YAML prompt templates, HTTP SSE chat streaming, and cache metadata.

## Prerequisites

1. `npm install`
2. `npm run build`
3. Start the sidecar with `npm --workspace @minicode/agent-sidecar run dev`
4. Launch `MiniCode Extension Demo` from `.vscode/launch.json`

## Scenario 1: YAML prompt templates are active

1. Open `packages/agent-sidecar/prompts/chat.yaml`.
2. Change a visible phrase in the `messages.system` block, for example add `Template marker: iteration-2-demo`.
3. In the Extension Development Host, send `/ask explain the current file`.
4. Open the sidecar response details in the chat output and confirm:
   - the response metrics report `promptVersion: v2`
   - the rendered behavior reflects the updated YAML template after restarting the sidecar

Notes:
- Template loading is file-backed.
- If the YAML file is missing or invalid and fallback mode is `built-in`, the sidecar emits an explicit warning into prompt rendering state instead of silently ignoring the failure.

## Scenario 2: Chat streaming uses HTTP SSE

1. In the Extension Development Host, ask for a longer explanation, for example `/ask explain how the current agent runtime works`.
2. Watch the response arrive in chunks instead of only after the full completion is finished.
3. Confirm the final chat output includes:
   - `Streaming: SSE`
   - `First chunk: <n> ms`

Notes:
- The extension consumes `POST /chat/stream`.
- Stable VS Code chat APIs are append-only for this integration, so streamed chunks are appended as markdown rather than reflowed token-by-token.

## Scenario 3: Cache metadata is visible

1. Trigger the same `/ask explain this helper` request twice with unchanged context.
2. On the second response, confirm the chat output includes `Cache: hit (chat)`.
3. Trigger the same inline completion request twice in the same file and cursor context.
4. Confirm the sidecar logs or inspection output show completion cache metadata with `hit: true`.

## Automated verification

Run:

```bash
npm test
npm run build
npm run check
```

The automated suite covers:
- YAML prompt loading, fallback, and error behavior
- SSE endpoint events
- chat/completion cache hits
- Iteration 1 approval-flow regression protection
