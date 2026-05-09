# MiniCode

**MiniCode** is a private, controllable, multi-model AI coding assistant for VS Code.

Built with a decoupled **Extension + Shared Protocol + Local Sidecar Runtime** architecture, MiniCode delivers chat, inline completions, edit workflows, agent execution, structured project understanding, and enterprise-ready security controls without depending on private Copilot APIs.

---

## Why MiniCode

Most AI coding tools are powerful, but hard to privatize, difficult to customize, and often opaque in how models, tools, and project context are handled.

MiniCode is designed for teams and developers who want:

- **private deployment** instead of hard dependency on a hosted SaaS workflow
- **model choice** instead of vendor lock-in
- **tool and execution control** instead of black-box agent behavior
- **project-aware assistance** instead of file-local autocomplete only
- **Marketplace-safe VS Code integration** built on stable APIs

---

## What MiniCode Delivers

### AI coding workflows inside VS Code

- Chat-based code ask, explain, plan, and edit flows
- Inline code completion with low-latency routing
- Context-aware editor actions for ask and edit operations
- Project progress and implementation status view inside the activity bar

### Multi-model intelligence

- Capability-based routing across `fast`, `completion`, `chat`, `reasoning`, and `embedding` workloads
- Support for local models, OpenAI-compatible services, ModelScope endpoints, and self-hosted providers
- Routing policies based on task type, with provider-level fallback and retry policies reserved for a later iteration

### Agent execution

- ReAct-style agent loop for planning, tool use, observation, and follow-up reasoning
- Built-in tool registry for file operations, Git inspection, diagnostics, code search, and controlled command execution
- Approval-aware execution flow for sensitive tools, including approval-time continuation in the current sidecar process

### Structured project understanding

- Context injection from active file, current selection, visible editors, diagnostics, dependency hints, Git state, and project index
- Project-level understanding powered by `features.json` and synchronized development metadata
- YAML-backed prompt templates for chat and completion, with versioned loading and explicit fallback/error behavior

### Security and control

- Prompt injection screening and tool risk gating
- Allowlist-based command execution policy
- In-process approval gating for high-risk operations; stronger isolation is planned for a later iteration
- Configurable local-first deployment for privacy-sensitive environments

---

## Key Highlights

- **Marketplace-safe**: built on stable VS Code APIs only
- **Private and self-hostable**: local sidecar runtime with configurable provider access
- **Multi-model by design**: route each workload to the right model class
- **Agent-ready runtime**: tools, approvals, observations, and iterative execution
- **Project-aware**: understands not just code, but the surrounding engineering context
- **Extensible architecture**: clear boundaries between UI, protocol, and runtime

---

## Architecture

MiniCode uses a three-layer architecture:

### 1. VS Code Extension

Responsible for:

- chat participation
- inline completions
- editor code actions
- project progress UI
- workspace context capture

### 2. Shared Protocol Layer

Responsible for:

- request and response contracts
- typed model capability definitions
- tool call schemas
- feature index structures
- extension/runtime consistency

### 3. Local Sidecar Runtime

Responsible for:

- provider abstraction
- model routing
- prompt rendering
- structured context building
- agent execution loop
- telemetry
- safety review
- tool orchestration

---

## Core Capabilities

### Multi-model routing

MiniCode classifies coding requests into five capability lanes:

- `fast`
- `completion`
- `chat`
- `reasoning`
- `embedding`

Each lane can be mapped to a different model according to latency, cost, and quality requirements.

### Structured context engine

MiniCode builds context from multiple sources before every important model call:

- active file
- selected code
- visible editor snapshots
- diagnostics
- workspace summary
- dependency hints
- Git status and diff
- project feature index

This allows the assistant to reason about the codebase as a system, not just as a text buffer.

### Prompt engineering system

MiniCode uses versioned prompt templates for different coding workflows:

- inline completion
- project Q&A
- edit planning
- code reasoning
- agent tool use

Prompt updates are evaluated through scenario-based tests before rollout. Prompt bodies now load from `packages/agent-sidecar/prompts/*.yaml`, and prompt version telemetry reflects the template version that was actually rendered.

### Agent runtime

The runtime supports a full agent workflow:

1. classify the task
2. construct structured context
3. render the correct prompt
4. select the provider and model
5. propose or execute tools
6. collect observations
7. continue reasoning until completion

The sidecar also exposes `POST /chat/stream` as an HTTP SSE endpoint. The VS Code extension consumes that stream and appends markdown chunks as they arrive. Stable VS Code chat APIs do not currently provide fine-grained replacement of previously streamed text, so the extension uses append-only chunk rendering rather than token-level reflow.

### Security model

MiniCode combines multiple safety layers:

- input cleaning
- prompt injection pattern detection
- tool risk classification
- approval gates
- restricted command execution
- output filtering for dangerous or sensitive content
- isolated execution path for sensitive operations is planned, not yet implemented

---

## Supported Model Backends

MiniCode supports multiple provider styles out of the box:

- **OpenAI-compatible APIs**
- **ModelScope-compatible endpoints**
- **Ollama local models**
- **self-hosted code models**

Typical model setups include combinations such as:

- `GPT-5` or `Claude` for deep reasoning
- `Qwen-Coder` or `DeepSeek-Coder` for completion and code generation
- lightweight local models for fast inline suggestions
- embedding models for project retrieval and semantic search

---

## Repository Structure

```text
.
├─ packages/
│  ├─ shared/              # shared contracts, protocol types, feature index types
│  ├─ agent-sidecar/       # runtime, provider adapters, routing, tools, telemetry, safety
│  └─ vscode-extension/    # chat UI integration, inline completion, commands, progress view
├─ scripts/                # validation and index sync scripts
├─ features.json           # project capability index
├─ AGENTS.md               # synchronized development status view
└─ README.md
```

---

## Installation

### Option 1: Local development setup

```bash
npm install
npm run build
```

Start the sidecar runtime:

```bash
npm --workspace @minicode/agent-sidecar run dev
```

Launch the VS Code extension in extension development mode.

### Option 2: Packaged extension

Build the extension package:

```bash
npm run package:extension
```

Then install the generated `.vsix` file into VS Code.

---

## Configuration

MiniCode can be configured for local or remote providers through VS Code settings and environment variables.

### Common VS Code settings

- `assistant.gateway.baseUrl`
- `assistant.provider.type`
- `assistant.models.chat`
- `assistant.models.reasoning`
- `assistant.models.fast`
- `assistant.models.completion`
- `assistant.models.embedding`
- `assistant.tools.autoApprove`
- `assistant.tools.allowedCommands`

### Example environment variables

```bash
MINICODE_PROVIDER_TYPE=openai-compatible
MINICODE_PROVIDER_BASE_URL=https://api.example.com/v1
MINICODE_PROVIDER_API_KEY=your-key
MINICODE_MODEL_CHAT=gpt-5
MINICODE_MODEL_REASONING=claude-sonnet
MINICODE_MODEL_COMPLETION=qwen-coder-plus
MINICODE_MODEL_FAST=qwen2.5-coder-7b-instruct
MINICODE_MODEL_EMBEDDING=bge-m3
MINICODE_ALLOWED_COMMANDS=npm test,npm run build,git status
MINICODE_PROMPT_VERSION=v2
MINICODE_PROMPT_DIRECTORY=packages/agent-sidecar/prompts
MINICODE_PROMPT_FALLBACK=built-in
MINICODE_CACHE_ENABLED=true
MINICODE_CACHE_MAX_ENTRIES=100
MINICODE_STREAM_SSE_PATH=/chat/stream
```

---

## Developer Workflow

### Build

```bash
npm run build
```

### Type check

```bash
npm run typecheck
```

### Run tests

```bash
npm test
```

### Validate project metadata

```bash
npm run check
```

### Run the Iteration 1 demo

Use the `MiniCode Extension Demo` launch configuration in `.vscode/launch.json`, then follow [docs/iteration-1-demo.md](docs/iteration-1-demo.md).

### Run the Iteration 2 demo

Use the same launch configuration, then follow [docs/iteration-2-demo.md](docs/iteration-2-demo.md) to verify YAML prompt loading, SSE chat streaming, and cache hits.

---

## Delivery Outcomes

MiniCode is designed to deliver measurable engineering value:

- lower API cost through mixed-model routing
- lower completion latency through capability-aware fast paths
- better project-level answer quality through structured context injection
- safer code execution through approval gates and execution controls
- higher extensibility through provider abstraction and runtime decoupling

In production deployments, the target outcomes include:

- significant cost reduction versus single-model cloud-only setups
- sub-second inline completion in optimized local or hybrid configurations
- stronger consistency across reasoning and edit workflows
- enterprise-friendly privacy and deployment control

---

## Roadmap

MiniCode is built as a long-lived platform, not just a single plugin.

Planned and extended directions include:

- richer retrieval and semantic indexing
- deeper multi-agent collaboration
- stronger sandbox isolation for risky execution paths
- team-level access control and deployment policies
- broader language and framework coverage

---

## Who This Is For

MiniCode is a strong fit for:

- individual developers who want local control
- teams building internal coding assistants
- organizations with private deployment requirements
- projects that need model flexibility across vendors and local runtimes
- AI engineering portfolios that want to demonstrate real application architecture, not just API wrapping

---

## Project Status

MiniCode is production-oriented by design and structured for long-term evolution across local development, private deployment, and enterprise extension scenarios.

---

## License

See [packages/vscode-extension/LICENSE](packages/vscode-extension/LICENSE).
