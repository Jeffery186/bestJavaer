# Understanding Claude Code Architecture, Part 1: Let's Begin

[English](./understanding-claude-code-architecture-part-1.md) | [Chinese Original](../../../ai-articles/01-agent-and-coding/%E8%AF%BB%E6%87%82%20Claude%20Code%20%E6%9E%B6%E6%9E%84%E5%88%86%E6%9E%90%E7%B3%BB%E5%88%97%EF%BC%8C%E7%AC%AC%E4%B8%80%E7%AF%87%EF%BC%8C%E5%BC%80%E5%A7%8B%EF%BC%81.md)

> English edition based on the Chinese original.

> Date: 2026-06-29

## A Short Preface

I came across a GitHub project that analyzes the Claude Code source exposed through source maps.

I had already seen plenty of Claude Code source-analysis articles. Some went too deep into individual implementation details. Others were clearly written by AI and lost their rhythm halfway through.

This repository gave me a better way to approach the topic, so I decided to write a full series around it.

The goal is to make every diagram earn its place and to explain the architecture as a coherent system, not as a pile of disconnected source files.

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@45e45a2/claude-code-from-source/ch01/cover.jpg" alt="Claude Code from Source cover" style="zoom:50%;" />

*Source: Claude Code from Source home-page cover.*

The cover itself is playful.

The NO' REILLY mark is clearly an echo of O'REILLY. Alejandro Balderas is an Anthropic engineer who has worked deeply on Claude Code, yet the book is framed as something co-authored with AI. In the middle, a crab holds a `.map` file: a reference to the source-map leak, and a literal map for an architecture guide.

That is my own reading of the image. Take it lightly.

---

## The Main Question

What is Claude Code, really?

A traditional CLI is essentially a function. One command performs one operation and returns a deterministic result.

When you run `grep`, it does not decide to run `sed` at the same time. When you run `curl`, it does not download something and then decide how to continue based on the downloaded contents.

An Agentic CLI is different.

It accepts a natural-language task, chooses tools based on the task, calls them in the necessary order, observes the results, and repeats until the work is done or the user stops it.

![Traditional CLI and Agentic CLI execution structures](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@565bdd9/claude-code-from-source/ch01/ch01-00-cli-vs-agent-excalidraw-skill.png)

*A traditional CLI is a linear pipeline. An Agentic CLI builds a feedback loop around model decisions.*

This gives us a useful definition:

An Agentic CLI is not a fixed list of instructions. It is a loop centered on a large language model, where the model generates the next instruction at runtime.

Claude Code is Anthropic's production implementation of that idea. It is a TypeScript monolith that turns a terminal into a complete development environment driven by Claude.

This first article explains six core abstractions.

## Six Core Abstractions

Claude Code is built around six core abstractions:

**Query Loop, Tool System, Tasks, State, Memory, and Hooks.**

They correspond to the query loop, tools, tasks, state, memory, and lifecycle hooks.

The hundreds of utility functions, terminal renderers, Vim emulation, and cost-tracking pieces exist to support these six ideas.

<img src="https://cdn.jsdelivr.net/gh/doggaifan/picbed/image-20260625201931230.png" alt="Claude Code's six core abstractions" style="zoom:50%;" />

*Source: interactive diagram from Claude Code from Source, chapter one.*

### Query Loop: The Center of the System

The first abstraction is Query Loop. It lives in `query.ts`, which the original analysis describes as an asynchronous generator and the center of the system.

Claude Code works in repeated rounds:

```text
call the model
  -> receive a streaming response
  -> collect tool calls
  -> execute tools
  -> append results to context
  -> continue with the next round
```

![Query Loop](https://cdn.jsdelivr.net/gh/doggaifan/picbed/image-20260626215559019.png)

*Query Loop is the common processing cycle. Different entry points converge on the same `query()`, which both performs work and streams results outward.*

Query Loop is not only an implementation detail of the REPL.

REPL means Read-Eval-Print Loop, an interactive command environment. The normal REPL, SDK calls, sub-agents, and headless `--print` mode all use the same Query Loop structure.

Claude Code does not create separate Agent logic for each of those entry points. They all converge on `query()`, and consumers pull generated events with `for await`.

```ts
for await (const event of query(input)) {
  render(event)
}
```

The model produces raw events. An Agent has to render and package them as messages before returning them to the user.

I ran `claude -p` to inspect the message events directly. The data below is redacted:

```json
{"type":"system","subtype":"init","cwd":"<redacted>","session_id":"<redacted>","tools":["Read","Edit","Bash","..."],"model":"<model>"}
{"type":"system","subtype":"status","status":"requesting"}
{"type":"stream_event","event":{"type":"message_start"}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello!"}}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}
{"type":"result","subtype":"success","result":"Hello!","stop_reason":"end_turn"}
```

`system/init` marks session initialization. `system/status: requesting` means Claude Code is calling the model. `message_start` begins the stream, `content_block_delta` carries incremental output, and the final `result/success` ends the query.

An async generator is useful for three reasons.

First, it controls output pace. An Agent continuously produces model text, tool calls, tool results, and state updates. A callback-based design can keep pushing events even when the terminal cannot render them quickly enough.

Second, it makes cancellation clearer. When the user presses `Ctrl+C`, the model may still be running, a tool may still be executing, and a subtask may still be alive. A pile of callbacks can appear stopped while work continues in the background. A generator gives the system a clear cancellation path and a final termination reason.

Third, it explains why work stopped. The final result carries a `stop_reason`.

![Agent stop reasons](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@7d97afd/claude-code-from-source/ch01/ch01-02-stop-reason-explained.png)

*Claude Code records why the Agent stopped instead of merely reporting that it stopped.*

### Tool System

The second abstraction is the tool system, implemented around `Tool.ts`, `tools.ts`, and `services/tools/`.

Tools are what an Agent can do on a computer: read files, run shell commands, edit code, and search the web.

Every Claude Code tool describes more than an execution function. It includes identity, mode, execution behavior, permissions, and rendering.

Two ideas are important here: the tool executor and streaming scheduling.

The executor performs calls such as Read, Write, Bash, and Grep. It divides calls into serial and concurrent groups. Reading files can usually happen in parallel. Writing files and commands that change state cannot be freely parallelized.

A streaming scheduler adds an optimization. It asks whether a tool can start before the model has finished producing its complete answer.

Once the model emits a concurrency-safe `Read` call, Claude Code can start reading. The model may still be generating while the file has already been fetched.

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@e34b6ee/claude-code-from-source/ch01/ch01-03-tool-system-streaming-executor.gif" alt="Streaming tool executor" style="zoom:67%;" />

*The tool system can inspect a model stream and start safe tools early.*

Claude Code overlaps tool execution with model streaming.

### Tasks and Sub-agents

Tasks are background execution units that carry sub-agents.

Each sub-agent follows a state machine:

`pending -> running -> completed | failed | killed`

![Sub-agent Query Loop](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@128dfa7/claude-code-from-source/ch01/ch01-04-tasks-sub-agent-query-loop-clean.png)

*A sub-agent starts a new Query Loop with its own message history, tool set, and permission mode.*

The key piece is `AgentTool`.

When Claude Code creates a sub-agent, the parent Agent creates another Query Loop. That loop has its own context, tools, and permission mode, so the sub-agent is a smaller Agent in its own right.

This gives the system recursion: an Agent can delegate to another Agent, and that Agent can delegate again.

The risk is obvious. A sub-agent that can make decisions, run commands, and modify files can also move outside the original task.

That is why the permission system has a `bubble` mode. A sub-agent cannot approve a dangerous action for itself. It reports upward, and the parent Agent or the user decides.

That is a necessary boundary in a multi-Agent system.

### State: Two Layers

Claude Code has two layers of state.

The first is a mutable singleton called `STATE`. It holds session-level data such as the current working directory, model configuration, cost tracking, session ID, token usage, and permission mode. The analysis estimates about 80 fields.

```text
current working directory
active model
session ID
cost so far
token usage
permission mode
```

At startup, Claude Code writes those values into `STATE`:

```ts
STATE.cwd = currentWorkingDirectory
STATE.sessionId = currentSessionId
STATE.model = currentModel
STATE.permissionMode = currentPermissionMode
```

![Session-level STATE](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@13856fc/claude-code-from-source/ch01/ch01-05-state-session-registry.png)

*The first state layer works like a session registry: initialize it at startup, mutate it during execution, and let modules read it as needed.*

The second layer is UI state: a new message arrives, the input mode changes, the user must approve a tool call, the progress bar updates, or the model is generating.

This state must be reactive.

The analysis uses Zustand, a React state-management mechanism, as the mental model:

```ts
const useStore = create((set, get) => ({
  messages: [],
  inputMode: "normal",
  addMessage: (msg) => set((state) => ({
    messages: [...state.messages, msg],
  })),
  setInputMode: (mode) => set({ inputMode: mode }),
}))
```

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@6d64e2b/claude-code-from-source/ch01/ch01-06-state-reactive-ui-store.png" alt="Reactive UI state" style="zoom:50%;" />

*Use `set()` to write and `get()` to read; state changes notify the UI to render again.*

Not every state should be reactive. Session infrastructure can be mutable. UI state must respond immediately.

### Memory Across Sessions

Memory lives around the `memdir/` path and carries persistent context between sessions.

The official description talks about three levels. The original article treats it as four:

- User level: `~/.claude/CLAUDE.md`, effective globally for Claude.
- Project level: `CLAUDE.md` in the repository.
- Directory or module level: `CLAUDE.md` inside a business module.
- Team level: shared through symbolic links and usually maintained outside an individual developer's day-to-day work.

![Memory across sessions](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@7e2c521/claude-code-from-source/ch01/ch01-07-memory-cross-session-context.png)

*Memory writes long-lived information into Markdown files, selects relevant pieces at session start, and sends them to Query Loop.*

At the beginning of a session, Claude Code scans those files, parses frontmatter, asks the LLM which memories are relevant, and then enters the Query Loop.

Project conventions, architecture decisions, debugging history, and personal preferences all fit this model. Markdown can be opened, edited, and versioned.

My current view is that an Agent's best memory may simply be a maintainable `MEMORY.md`.

### Hooks: Lifecycle Interceptors

Hooks live in `hooks/` and `utils/hooks/`. They are user-defined interceptors across the Claude Code lifecycle.

The original analysis says hooks can fire across four execution types and 27 events:

**shell commands, one-shot LLM prompts, multi-turn Agent conversations, and HTTP webhooks.**

For readers familiar with Java Spring, the idea resembles AOP, though the targets differ. Spring AOP intercepts Java method calls. Claude Code Hooks intercept predefined lifecycle events such as before and after a tool call, prompt submission, and session end.

![Hooks and Spring AOP](https://cdn.jsdelivr.net/gh/doggaifan/picbed/image-20260627144932971.png)

*Similarities and differences between Hooks and Spring AOP.*

Hooks can block a tool, modify input, inject extra context, or stop the Query Loop entirely.

Part of the permission system is implemented through hooks. A `PreToolUse` hook can reject a tool call before Claude Code shows the interactive permission prompt.

## One Complete Claude Code Request

Imagine a user types, "Add error handling to the login function," and presses Enter.

![Claude Code Golden Path animation](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@e05657e/claude-code-from-source/ch01/ch01-09-golden-path-flow.gif)

*A request enters through the REPL, passes through Query Loop, model streaming, and tool execution, then returns to the terminal.*

![Claude Code Golden Path](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@e05657e/claude-code-from-source/ch01/ch01-10-golden-path-static-full-path.png)

*The same complete path in a static view.*

The sequence is:

```text
user types a task
  -> REPL gives it to Query Loop
  -> Query Loop calls the model API
  -> the model streams content and tool calls
  -> a streaming scheduler dispatches reads, edits, and commands
  -> tools execute actions
  -> results become session context
  -> Query Loop calls the model again
  -> the loop stops when no further tools are requested or an external condition intervenes
```

Three details deserve attention.

First, a generator pulls messages from the outside. A callback chain pushes events from the inside.

```ts
runAgent(input, {
  onText(text) {},
  onToolCall(tool) {},
  onToolResult(result) {},
  onDone(reason) {},
  onError(error) {},
})
```

In a callback chain, the outer `runAgent` does not control the execution of its internal callbacks. With Query Loop, the consumer pulls one message at a time:

```ts
for await (const msg of query(input)) {
  render(msg)
}
```

The terminal's consumption speed can influence generation speed. The analogy is TCP flow control: a sender cannot push indefinitely when the receiver cannot keep up.

Second, Claude Code can start a safe tool before a full model response finishes.

The ordinary serial approach waits for the complete answer, discovers a tool call, executes it, and returns the result.

![Serial tool execution](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@2ea13e5/claude-code-from-source/ch01/ch01-11-streaming-serial-tool-flow.png)

*A serial approach waits for the full model output before beginning tool execution.*

Claude Code uses `StreamingToolExecutor`. It can start concurrency-safe calls such as Read and Grep as soon as they appear. The source calls this `speculative execution`.

There is a trade-off. Later model output can invalidate an early result, causing duplicated work and extra token use. Claude Code accepts that occasional waste to lower end-to-end latency.

Third, the loop is reentrant.

```text
user asks a question
  -> model decides to read a file
  -> tool reads the file
  -> result returns to context
  -> model decides to edit a file
  -> tool edits the file
  -> result returns to context
  -> model decides it can finish
  -> final response
```

![Agent runtime loop](https://cdn.jsdelivr.net/gh/doggaifan/picbed/image-20260629071056159.png)

*The model examines context, chooses a next action, and receives tool results back into the same context.*

## Permission System

Claude Code can run shell commands, change files, launch processes, make network requests, and rewrite Git history.

Without a permission system, this would be dangerous.

The analysis notes that many people casually enable `bypassPermissions`. That is a poor habit for a tool with this much reach.

Claude Code has seven source-level permission modes:

| Mode | Meaning |
| --- | --- |
| `bypassPermissions` | Allow everything without checks, mainly for internal use or tests |
| `dontAsk` | Allow actions while still recording logs |
| `auto` | Use a lightweight LLM classifier to decide allow or deny |
| `acceptEdits` | Approve file edits automatically and ask about other actions |
| `default` | Standard interactive confirmation |
| `plan` | Read-only mode; writing is blocked |
| `bubble` | Let a sub-agent pass permission requests to its parent |

![Permission resolution](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@635720a/claude-code-from-source/ch01/ch01-13-permission-resolution-flow.gif)

*Hooks, tool checks, and permission modes participate in a strict resolution path.*

The most interesting mode is `auto`.

Before deciding, it calls a lightweight LLM to judge whether a requested action matches the user's original intent. Reading files, running tests, and changing related code may fit a bug-fix task. Deleting a directory or changing SSH configuration should pause for confirmation.

That places an automatic approval layer between fully manual confirmation and unrestricted execution.

The default `bubble` behavior for sub-agents is equally important. A sub-agent cannot approve its own risky action. It asks the parent Agent, and the parent can decide whether user confirmation is required.

## Multi-Provider Architecture

Claude Code uses a multi-provider architecture.

It can reach Claude through four infrastructure paths: the direct API, AWS Bedrock, Google Vertex AI, and Foundry.

![Multi-provider architecture](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@45e45a2/claude-code-from-source/ch01/ch01-04-multi-provider-architecture.png)

*The rest of the system can stay unaware of which provider is active.*

The Anthropic SDK provides wrappers for different cloud providers while exposing one interface to the upper layers.

`getAnthropicClient()` reads environment variables and configuration, chooses a provider, and creates the appropriate client. After that, `callModel()` and other callers treat it as a common Anthropic client.

The architecture resembles a factory plus adapter pattern. The factory chooses what to create at startup. The adapter gives the rest of the system one stable interface.

Query Loop does not care whether the request goes through the direct API or Bedrock. Provider choice is stored in `STATE`, while the Agent loop, tool system, and permission system remain separate.

## Build System and Source Maps

Claude Code serves as an internal Anthropic tool and a public npm package. Both use the same codebase, with compile-time feature flags controlling what enters a build.

```ts
const module = feature("SOME_FLAG")
  ? require("./some/internal/module")
  : null
```

`feature()` comes from Bun's bundling API. At build time, each flag becomes a Boolean literal. When it is false, the bundler removes the relevant `require()` branch completely.

The module does not load, enter the bundle, or ship.

The irony is that early npm packages contained source maps with `sourcesContent`, which preserved the original TypeScript source. The build flags removed runtime code, while source maps still exposed the source text.

That is how people were able to study the architecture.

## How the Pieces Connect

![Claude Code component connections](https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@45e45a2/claude-code-from-source/ch01/ch01-05-how-the-pieces-connect.png)

Memory becomes part of the system prompt and enters Query Loop.

Query Loop drives tools.

Tool results return to Query Loop as messages.

Tasks are recursive Query Loops with isolated context.

Hooks intercept Query Loop at defined points.

State is read and written by all modules, while the reactive layer updates the UI.

**The circular relationship between Query Loop and Tool System is the defining feature of the runtime.**

The model produces a tool call. A tool produces a result. The result enters context. The model sees it and chooses the next action. The loop stops only when the model has no more tool calls or when a budget, round limit, or user cancellation ends it.

That is the core of an Agent.

Claude Code is a terminal Agent runtime.

The model is the brain.

Tools are its hands and feet.

Permissions are the brakes.

State is the nervous system.

Memory is long-term experience.

Hooks are engineering discipline.

Query Loop is the heartbeat.

The next article moves to chapter two: startup.

---

## References

- [Claude Code from Source, Chapter 1: The Architecture of an AI Agent](https://claude-code-from-source.com/ch01-architecture/)
- [Claude Code from Source](https://claude-code-from-source.com/)
- [Anthropic Claude Code Docs: Overview](https://docs.anthropic.com/en/docs/claude-code/overview)
