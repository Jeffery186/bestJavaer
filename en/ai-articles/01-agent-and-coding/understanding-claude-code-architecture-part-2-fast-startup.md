# Understanding Claude Code Architecture, Part 2: How Does Claude Code Start So Fast?

[English](./understanding-claude-code-architecture-part-2-fast-startup.md) | [Chinese Original](../../../ai-articles/01-agent-and-coding/%E8%AF%BB%E6%87%82%20Claude%20Code%20%E6%9E%B6%E6%9E%84%E5%88%86%E6%9E%90%E7%B3%BB%E5%88%97%EF%BC%8C%E7%AC%AC%E4%BA%8C%E7%AF%87%EF%BC%9AClaude%20Code%20%E6%98%AF%E6%80%8E%E6%A0%B7%E5%90%AF%E5%8A%A8%E7%9A%84%EF%BC%9F.md)

> English edition based on the Chinese original.

> Date: 2026-07-07

This is the second article in the Claude Code architecture series.

Claude Code is a terminal Agent runtime. It has a Query Loop, Tool System, Tasks, State, Memory, and Hooks. That already sounds like a lot of machinery.

So here is the question:

After someone types `claude` in a terminal, how can the input cursor appear quickly despite all that machinery? What does Claude Code do while starting its CLI?

This article is about fast startup.

> The original analysis gives Claude Code an approximate startup budget of **300 ms**.
>
> Treat that as a practical line for this CLI, not a universal rule. Around that level, a terminal program feels immediate. Once it crosses the line, users experience it as slow.

A CLI cannot hide latency as easily as a web app.

A web app can lazy-load modules, defer rendering, batch requests, or show a loading state.

In a terminal, the user is waiting in real time. If version lookup takes too long, or a prompt appears late, the delay is obvious.

Claude Code therefore has to validate the environment, establish security boundaries, prepare communication layers and the terminal UI, then keep the process near 300 ms.

## The Startup Pipeline

Many projects eventually build one enormous `init()` function:

```text
read configuration
  -> read environment variables
  -> initialize logging
  -> load plugins
  -> register commands
  -> connect to the network
  -> render UI
```

Everything becomes mixed together. It is impossible to tell which step is required now, which can wait, and which is unnecessary for a particular command.

Claude Code takes a different path.

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-00-big-init-vs-pipeline.png" alt="A large init function compared with a startup pipeline" style="zoom:67%;" />

It breaks startup across five components:

```text
cli.tsx -> main.tsx -> init.ts -> setup.ts -> replLauncher.ts
```

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-01-bootstrap-pipeline.gif" alt="Claude Code bootstrap pipeline" style="zoom:67%;" />

*Each layer narrows the problem before handing control to the next.*

Those five layers answer five questions:

- `cli.tsx`: Does this invocation require the full startup path?
- `main.tsx`: Which slower operations can begin asynchronously?
- `init.ts`: Can the current environment be trusted, and what is the configuration?
- `setup.ts`: Which components are available?
- `replLauncher.ts`: Which entrance should enter Query Loop?

The first rule is simple: decide whether full startup is necessary before starting it.

## Phase 0: Fast-Path Routing in cli.tsx

The Claude Code process first reaches `cli.tsx`.

At this moment it has one job:

**Decide whether this request needs the full Bootstrap pipeline.**

The role resembles a bootloader.

In a traditional BIOS and MBR boot sequence, the CPU begins at a fixed reset vector, enters BIOS firmware, initializes basic hardware, finds a boot disk, loads the MBR, then passes control to a bootloader and eventually a kernel.

```text
CPU starts at 0xFFFFFFF0
  -> BIOS
  -> basic hardware initialization
  -> find boot disk
  -> load MBR at 0x7C00
  -> execute bootloader
  -> bootloader or GRUB loads the Linux kernel
```

![Bootloader comparison](https://cdn.jsdelivr.net/gh/doggaifan/picbed/image-20260702215811159.png)

*The shared idea is early routing before a full system is loaded.*

`cli.tsx` has the same instinct. It does not immediately load all of Claude Code. It first examines command-line arguments, or `argv`.

```bash
claude --version
claude --help
claude mcp list
```

These commands do not need React, telemetry, the keychain, or the tool system. A user asking for a version number should not trigger an entire Agent runtime.

So `cli.tsx` detects commands that can return immediately. This is the fast path.

```ts
if (args.length === 1 && args[0] === "--version") {
  const { printVersion } = await import("./commands/version.js")
  await printVersion()
  process.exit(0)
}
```

The important detail is the dynamic `import()`.

Claude Code does not eagerly load every command module. It loads only the module needed for the current command, performs the action, and exits.

The original analysis says there are roughly a dozen fast paths covering version, help, configuration, MCP management, update checks, and similar short operations.

The exact count matters less than the pattern:

**Dynamically import the smallest thing needed, answer the request, and exit.**

## Phase 1: Start Slow I/O Early in main.tsx

When fast-path handling does not apply, `cli.tsx` enters the full startup path through `main.tsx`.

This is where a major performance optimization appears. During module evaluation, before ordinary functions run, Claude Code starts slow I/O:

```ts
const mdmPromise = startMDMSubprocess()
const keychainPromise = readKeychainCredentials()
```

MDM means Mobile Device Management. Organizations use it to enforce policies on employee devices. When Claude Code runs on a managed machine, it has to check whether enterprise restrictions apply.

Keychain is macOS storage for passwords, tokens, certificates, and credentials.

Both are I/O operations, and I/O is slow compared with ordinary in-process work.

Claude Code does not wait until TypeScript modules finish loading before starting them. It starts MDM and Keychain work asynchronously, then loads the rest of the dependency tree in parallel.

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@add620ee332d863f73313d6918f90a712be5fb7d/claude-code-from-source/ch02/ch02-02-module-io-overlap.gif" alt="Overlapping module loading and I/O" style="zoom:67%;" />

*Module loading and asynchronous I/O advance together.*

It uses unavoidable module-load time to hide asynchronous waiting time.

## Phase 2: Configuration and the Trust Boundary in init.ts

After `main.tsx`, Claude Code enters `init.ts`.

This phase parses command-line arguments, reads global and project configuration, and applies the full environment only after the user has confirmed trust.

The original analysis notes that `init()` is memoized.

That means the first call runs initialization and caches the Promise or result. Later calls reuse that result instead of performing initialization again.

```ts
let initPromise

function init() {
  if (!initPromise) {
    initPromise = reallyInit()
  }

  return initPromise
}
```

This matters because Claude Code has several entrances: REPL, `claude -p`, and external SDK calls.

Without memoization, each entrance could repeat configuration reads and write initialization state again.

The more important concept in `init.ts` is the **trust boundary**.

It asks whether the current directory, shell environment, and project configuration can be trusted and whether later startup stages can use them.

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-03-trust-boundary.png" alt="Claude Code trust boundary" style="zoom:50%;" />

Claude Code subprocesses inherit the current shell environment.

`.bashrc`, `.zshrc`, or a project script that has been sourced into the shell can all modify environment variables.

A project file sitting in a directory is not automatically active. It becomes relevant only after something executes or sources it.

Consider a suspicious project containing a fake `bin/git`, plus an initialization script that runs:

```bash
export PATH="$PWD/bin:$PATH"
```

`PATH` controls which directories the system searches for commands, with earlier entries taking precedence. Once the project directory is placed first, a later `git status` might invoke the fake Git rather than the system Git.

`NODE_OPTIONS` creates a related risk by instructing Node.js subprocesses to load additional JavaScript at startup. On Linux, `LD_PRELOAD` can cause the dynamic linker to load a chosen shared library before the program starts.

Before a user trusts the directory, Claude Code reads only information that does not depend on the project environment.

Only after that trust decision does it accept values such as `PATH`, `LD_PRELOAD`, and `NODE_OPTIONS` that can alter process behavior.

Then `setup.ts` can register commands, Agents, Hooks, and plugins.

### Commander preAction

The source also discusses Commander's `preAction` hook.

This is separate from the lifecycle Hooks configured by a Claude Code user. The shared word "hook" can be misleading.

Commander is a common Node.js CLI parser. It understands flags, subcommands, and positional arguments:

```bash
# --version and --help are flags. Claude Code handles them early as fast paths.
claude --version
claude --help

# status, commit, and branch are subcommands.
git status
git commit
git branch

# --print is a flag; the following text is a positional argument.
claude "Explain this file"
claude --print "Summarize README.md"
```

Those labels describe command syntax.

Fast path describes the execution route.

`--version` is syntactically a flag, but `cli.tsx` checks raw `process.argv` before Commander loads. It prints the version and exits, so `preAction` never fires.

`--print` is also a flag, but it needs a model, tools, and the full runtime. It therefore goes through `init()`.

```text
claude --version
  -> cli.tsx takes the fast path
  -> print version and exit

claude --print "Summarize README.md"
  -> cli.tsx does not exit early
  -> Commander parses the command
  -> preAction fires
  -> init() runs
  -> the --print handler runs
```

The shape is:

```ts
program.hook("preAction", async (thisCommand) => {
  await init(thisCommand)
})
```

Commander understands the command first, pauses before the command handler, runs `init()`, and then executes the relevant handler.

## Phase 3: Component Registration in setup.ts

After `init()`, Claude Code enters `setup.ts`.

At this point it knows:

- the active configuration,
- whether the current directory is trustworthy,
- the permission boundary,
- and the command the user wants to run.

It understands its environment, but commands, Agents, Hooks, and plugins still need registration.

Independent loading tasks advance in parallel:

- Commands: available commands.
- Agents: definitions the main Agent can call, such as Explore, Plan, and user-defined sub-agents.
- Hooks: lifecycle rules that should apply.
- Plugins: plugins that need loading.

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-04-setup-phase.gif" alt="Parallel capability registration in setup" style="zoom:67%;" />

*The setup phase advances registrations that do not depend on one another.*

After `setup()`, the components are ready.

There is an important security detail here.

Claude Code reads the Hooks configuration and freezes it as an immutable snapshot. The individual Hooks still execute later, when their lifecycle event occurs:

```text
PreToolUse: before a tool runs
PostToolUse: after a tool runs
Stop: when the Agent is about to stop
SessionEnd: when the session ends
```

Think of it as setting the rulebook before a match begins.

The hooks still fire at their corresponding points. They simply use the configuration snapshot captured at startup.

This protects against a malicious script that modifies hook configuration after Claude Code starts in order to change future approval rules.

The startup snapshot prevents the active session from changing merely because the file on disk changes.

This connects directly to the permission discussion in part one.

## Phase 4: Select an Entry Point in replLauncher.ts

`replLauncher.ts` is near the end of startup.

About seven modes converge there:

interactive REPL, one-shot `--print`, SDK mode, `--resume`, `--continue`, pipe mode, and headless mode.

The previous four phases prepared the environment and its components.

`replLauncher.ts` selects the matching entrance.

An ordinary terminal conversation enters REPL. This is the version most people know: an input box appears, the user asks questions, and Claude Code executes while rendering progress.

The original analysis points out that interactive REPL mounts a React/Ink component tree.

Ink is roughly React for the terminal. React renders components to the browser DOM; Ink renders components onto a terminal screen.

The input field, tool approval dialogs, progress, and status updates are therefore more than random `console.log` calls. They form a terminal UI.

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@0c4f3618e9854c451369abcbb961b890a5fb1e0c/claude-code-from-source/ch02/ch02-05-ink-terminal-ui.png" alt="React Ink terminal UI" style="zoom:25%;" />

*React and Ink continuously update messages, tool state, approval prompts, and the input field.*

`--print` is different. It is common in scripts, CI, and automation.

The user does not need an interactive terminal. They need Claude Code to receive a prompt, finish its work, and write output to stdout.

So `--print` does not mount a React/Ink tree. It creates a headless Query Loop.

The model still reasons. Tools still execute. Only the terminal UI is absent, and the result streams to standard output.

SDK mode similarly emits events using the SDK's protocol for another program to consume.

`--resume` and `--continue` restore an existing session or context first, then enter the same execution loop.

The key point is that these modes do not implement separate Agent runtimes. They all return to the Query Loop described in part one.

## Where Does 240 ms Come From?

The source includes a startup timeline. The numbers are approximate profiling checkpoints, not a millisecond-perfect performance table.

| Stage | Time | What happens |
| --- | ---: | --- |
| Fast-path check | about 5 ms | Inspect `argv`; return early when possible |
| Module evaluation | about 138 ms | Load dependency tree while slow I/O runs |
| Commander parsing | about 3 ms | Parse flags and subcommands |
| `init()` | about 14 ms | Parse configuration and establish trust boundary |
| `setup()` | about 35 ms | Register commands, Agents, Hooks, and plugins |
| Launch and first render | about 25 ms | Choose entry point, mount React/Ink, render UI |
| **Total** | **about 240 ms** | Remain within the 300 ms startup budget |

The individual numbers add up to roughly 220 ms, while the end-to-end result is about 240 ms. The difference is expected: the checkpoints show the broad shape of the process rather than an exact accounting of every millisecond.

The interactive diagram uses another division of phases and includes the first API call, so its individual timings do not directly match this table.

What we can say is that a warm start on a modern machine is around 240 ms, leaving some margin under the 300 ms line.

Warm start means relevant modules are likely still in the operating system's file cache because Claude Code ran recently.

Cold start happens after a reboot or a long period without use, when modules and dependencies must be loaded from disk again.

```text
warm start: recently used files remain cached, so startup is faster
cold start: the cache is gone or has never existed, so startup reads from disk again
```

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-04-startup-timeline.gif" alt="Claude Code startup timeline" style="zoom:67%;" />

*The original timeline places warm start around 240 ms. Cold start moves closer to 300 ms.*

## The Full Picture

The good part of this design is the way it reduces a large initialization problem into smaller questions with clear responsibilities.

Phase 0 asks whether Bootstrap is necessary. Commands such as `claude --version` and `claude --help` can return without loading a model or terminal UI.

Phase 1 overlaps module loading with I/O such as MDM and Keychain work.

Phase 2 uses `init.ts` to parse configuration and establish a trust boundary before potentially dangerous project environment values are accepted.

Phase 3 uses `setup.ts` to register components: Agents, Hooks, plugins, and commands.

Phase 4 chooses an execution mode and finally enters Query Loop.

That is how a production Agent runtime starts: not with one huge `init()`, but with a sequence of increasingly specific decisions.

---

## References

- [Claude Code from Source, Chapter 2: Starting Fast - The Bootstrap Pipeline](https://claude-code-from-source.com/ch02-bootstrap/)
- [Claude Code from Source, Chapter 1: The Architecture of an AI Agent](https://claude-code-from-source.com/ch01-architecture/)
