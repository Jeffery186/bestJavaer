# 读懂 Claude Code 架构分析系列，第二篇：Claude Code 是怎样启动的？

[English](../../en/ai-articles/01-agent-and-coding/understanding-claude-code-architecture-part-2-fast-startup.md) | [中文](./%E8%AF%BB%E6%87%82%20Claude%20Code%20%E6%9E%B6%E6%9E%84%E5%88%86%E6%9E%90%E7%B3%BB%E5%88%97%EF%BC%8C%E7%AC%AC%E4%BA%8C%E7%AF%87%EF%BC%9AClaude%20Code%20%E6%98%AF%E6%80%8E%E6%A0%B7%E5%90%AF%E5%8A%A8%E7%9A%84%EF%BC%9F.md)

> 日期：2026-07-07

我正在连载 Claude Code 系列体系文章，这是整个系列的第二篇。如果你觉得这个系列不错的话，欢迎追更，完全免费。

Claude Code 是一个跑在终端里的 Agent runtime。

它里面有 Query Loop，有 Tool System、Tasks、State、 Memory、Hooks。

这些东西听起来已经够复杂了。

那么问题来了。

Claude Code 里面塞了这么多东西，为什么用户在终端里敲下 `claude` 之后，它还能很快的把用户的输入光标显示出来？

Claude Code 在启动 CLI 的过程中，都做了哪些事儿？

这篇文章讲的就是这件事情，也就是 **Claude Code 的快速启动**。

> 原文给 Claude Code 设定的启动预算，大概是 **300ms**。
>
> 这里的 300ms 可以看成 Claude Code 给 CLI 启动画的一条红线，而不是放在哪都成立的铁律。
>
> 只要启动时间控制在这个量级，用户通常会觉得工具是秒开的。
>
> 如果超过这个临界值，CLI 就会开始变得迟钝，用户从体感上来说就会觉得这是个啥玩意，卡的要死。

毕竟 CLI 工具和 web 端应用不一样。

web 端可以做懒加载，可以做 UI 降级，可以做延迟渲染，接口可以分批请求，非核心功能可以等用户使用时再加载。

更甚至加载不过来的话，用户可能被弹出来个 loading。。。。。。

但如果终端工具响应慢，体感会非常明显，因为 CLI 的加载过程，用户可是 Online 在线等啊，这事儿挺急的。

比如你只是想查个版本号，结果它在那里转半天，这能行吗？

所以 CLI 慢一点都忍不了，慢就会被人吐槽，慢慢丢失用户，后面没人用了。

所以 Claude Code 启动时既要验证环境、建立安全边界、准备通信层和终端界面，还要把整个过程压在 300ms 左右。

所以这一章在聊的就是这个话题。

## 启动流程

很多项目的启动流程，最后都会成为一个巨大的 `init()`。

读配置 => 读环境变量 => 初始化日志 => 加载插件 => 注册命令 => 连接网络 => 渲染 UI。

所有东西全揉在一起，你不知道哪些步骤必须现在做，哪些步骤可以晚点做，哪些步骤根本不用做。

Claude Code 不是这么做的，它没有把所有的启动步骤都直接塞一块儿。

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-00-big-init-vs-pipeline.png" alt="启动请求分流对比图" style="zoom: 67%;" />

而是把启动流程拆在五个组件里：

`cli.tsx -> main.tsx -> init.ts -> setup.ts -> replLauncher.ts`

这五个步骤就像是一条 pipeline 流水线 。

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-01-bootstrap-pipeline.gif" alt="Claude Code Bootstrap Pipeline 动图" style="zoom: 67%;" />

*▲ pipeline 的每一层，都是一个逐层收窄的过程。*

大家可以先大致记下这张图。

在每一层中，每个组件都只执行最小的必要工作，完成后将控制权移交给下一层。

这五层其实分别在回答五个问题：

`cli.tsx`：这次要不要完整启动？

`main.tsx`：有没有执行速度比较慢的操作可以异步执行？

`init.ts`：当前环境能不能相信，配置是什么？

`setup.ts`：Claude Code 有哪些组件可以使用？

`replLauncher.ts`：最后从哪个入口进入 Query Loop 循环？

后面每一步骤我会跟大家细嗦，你先记住这个点：

**启动流程的第一步，是先判断有没有必要完整启动。**

## Phase 0：快速路径调度（cli.tsx）

Claude Code 进程最先进入的文件是 `cli.tsx`。

此时 `cli.tsx` 只有一个核心任务（注意我说的是此时）。

**判断这次请求要不要进入完整 Bootstrap。**

这个设计其实很像操作系统启动里的 bootloader。

我这里先简单跟大家拓展一下操作系统中传统 BIOS + MBR 的启动流程。

机器刚通电时，CPU 并不知道操作系统在哪里。

它只知道一件事：从一个固定地址开始执行第一条指令。

在现代 x86 体系里，这个入口通常可以理解为 `0xFFFFFFF0`，也就是所谓的 Reset Vector。

这个地址并不存放操作系统，它会映射到主板上的 BIOS 固件 ROM。

这里通常不会放很多代码，一般只是放一条 `jump` 跳转指令，把 CPU 带到真正的 BIOS 初始化代码里。

BIOS 启动后，会初始化基础硬件，然后根据启动顺序去找启动盘。

在传统 BIOS + MBR 启动模式下，BIOS 会读取启动盘的第一个扇区，也就是 MBR，并把它加载到内存中的 `0x7C00` 位置。

接着 BIOS 跳到 `0x7C00` 执行。

这里放的是最早期的 bootloader 代码。

bootloader 再继续加载后续引导程序，比如 GRUB，最后由 GRUB 加载 Linux kernel。

所以完整一点就是：

```text
CPU 从 0xFFFFFFF0 开始执行
  -> 进入 BIOS
  -> BIOS 初始化基础硬件
  -> BIOS 找启动盘
  -> BIOS 把 MBR 加载到 0x7C00
  -> 跳到 0x7C00 执行 bootloader
  -> bootloader / GRUB 加载 Linux kernel
```

<img src="https://cdn.jsdelivr.net/gh/doggaifan/picbed/image-20260702215811159.png" alt="image-20260702215811159" style="zoom:50%;" />

*▲ 两者共同的地方。*

为什么要扯这个？

因为 `cli.tsx` 在 Claude Code 里的角色，就很像这个 bootloader。`cli.tsx` 第一件事不是加载完整 Claude Code ，而是先判断要不要启动完整的 Agent 。

它会先看有没有命令行参数，也就是 `argv`。

比如：

```bash
claude --version
claude --help
claude mcp list
```

这些命令其实不需要启动完整的 Claude Code。

你就只想看看版本号、获取帮助、列出 MCP Server 等，这时候根本不需要加载 React，初始化 telemetry，读取 keychain，加载工具系统。

所以 `cli.tsx` 会先判断这是否是一个可以直接执行的指令，如果是，就直接处理并退出，这条路径就叫 `fast path`。

大概是这个意思：

```ts
if (args.length === 1 && args[0] === "--version") {
  const { printVersion } = await import("./commands/version.js")
  await printVersion()
  process.exit(0)
}
```

注意这里用了动态 `import()`。

它不是一上来把所有命令模块都加载进来，它只加载当前命令需要的那个模块。

如果用户只是查版本号，那就只 Import 版本号相关代码，执行完成然后退出，不用管后面的 `main.tsx`、`init.ts`、`setup.ts`。

> 原文说这里大概有十几个 fast path，覆盖 version、help、配置、MCP 管理、更新检查等场景。
>
> 具体细节并不重要，重要的是这个模式，动态 import ，执行，退出。

## Phase 1：异步执行慢 I/O（main.tsx）

如果 fast path 没命中，`cli.tsx` 就会进入完整启动流程。

完整启动的第一步，就是加载 `main.tsx`。

这是第二个很重要的执行步骤。

`main.tsx` 在模块加载阶段，下面这段代码会在执行任何函数前触发，这是整个 bootstrap 流程中最关键的性能优化技术。

```ts
const mdmPromise = startMDMSubprocess()
const keychainPromise = readKeychainCredentials()
```

这两块代码是啥意思呢？

MDM 是 `Mobile Device Management`，移动设备管理。公司给员工发 Mac，一般会用 MDM 管理设备策略，相当于就是企业给员工个人电脑设置的一系列配置。

Claude Code 如果运行在企业设备上，就不能当做个人电脑处理。启动时需要检查 MDM，看看有没有企业级限制。

而 Keychain 是 macOS 的系统钥匙串。它用来安全保存密码、token、证书、登录凭据。

这两个都是 I/O 型操作，I/O 操作的一个痛点就是慢。

I/O 操作不能等着 Claude Code 加载完对应的 ts 模块后再执行，而是先让这两个操作异步执行，然后 Claude Code 并行走接下来的模块加载。

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@add620ee332d863f73313d6918f90a712be5fb7d/claude-code-from-source/ch02/ch02-02-module-io-overlap.gif" alt="main.tsx 模块加载与 I/O 重叠动图" style="zoom: 67%;" />

*▲ 模块加载和异步 I/O 同时执行。*

Claude Code 在用同步加载模块的时间来覆盖异步等待。

## Phase 2：解析配置与建立信任边界（init.ts）

`main.tsx` 之后，会进入 `init.ts`。

它会解析命令行参数，读取全局配置和项目配置，并在用户确认信任后应用完整的环境配置。

> 这里原文提到一个细节：`init()` 是 memoized 的。
>
> memoized 在这里可以理解为：第一次调用时执行初始化，并把对应的 Promise 或结果缓存下来。后面再调用 `init()`，拿到的还是同一份执行结果，不会重新执行一遍。

伪代码如下

```ts
let initPromise

function init() {
  if (!initPromise) {
    initPromise = reallyInit()
  }

  return initPromise
}
```

为什么要这么设计？

因为 Claude Code 会有多个调用入口，REPL、claude -p 、外部 SDK 调用也会用到。

如果每个入口都进行初始化的话，就很容易出现重复初始化。

比如配置重复读取、初始化状态重复写入。

Claude Code 的 memoized 的 `init()` 把这类问题规避了。

`init.ts` 里面有个很重要的东西，是`trust boundary`，可以理解为是信任边界。

这里的 trust boundary 关注的是：

**当前目录、shell 环境、项目配置，是否可以信任，以及能不能被后续启动流程继续使用。**

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-03-trust-boundary.png" alt="Claude Code Trust Boundary" style="zoom:50%;" />

因为 Claude Code 启动的子进程，会继承当前 shell 里的环境变量。

`.bashrc`、`.zshrc`，或者被用户执行、`source` 过的项目脚本，都可以修改这些环境变量。

> 注意，项目脚本只是放在目录里不会自动生效，必须先被执行或加载进当前 shell。

举个最直观的例子。

假设某个陌生项目里放了一个假的 `bin/git`，项目的初始化脚本又执行了下面这句：

```bash
export PATH="$PWD/bin:$PATH"
```

`PATH` 决定系统去哪些目录里寻找命令，而且排在前面的目录优先级更高。

这条配置会把项目自己的 `bin` 放到最前面。后面 Claude Code 执行 `git status` 时，系统找到的可能不是电脑里真正的 Git，而是项目准备的那个假 `git`。

`NODE_OPTIONS` 也有类似风险。它可以要求 Node.js 子进程在启动时额外加载一段 JavaScript。

`LD_PRELOAD` 则主要出现在 Linux 上，它可以让动态链接器在程序启动前先加载指定的共享库。

在用户确认信任当前目录之前，Claude Code 只读取不依赖项目环境的安全信息。

用户确认信任当前目录以后，它才会读取 `PATH`、`LD_PRELOAD`、`NODE_OPTIONS` 这类可能影响进程行为的环境变量。

等环境和配置确认完成，后面的 `setup.ts` 才继续注册命令、Agent、Hooks、插件等能力。

### Commander 的 preAction Hook

> 原文在 `init.ts` 里还提到了 Commander 的 `preAction` hook。
>
> 我们上一节说到，hook 就是用户自定义的 Claude Code 全生命周期的拦截器。
>
> 而`preAction` 是 Commander 提供的命令执行钩子。
>
> 它和 Claude Code 里用户配置的生命周期 Hooks 属于两套机制，只是名字里都有 Hook。

Commander 是 Node 生态里一个常见的 CLI 参数解析库。

Commander 会解析 flags（选项）、subcommands（子命令）、positional arguments（位置参数）。

这些其实都是 CLI 里面的参数类型。

简单来说，Commander 就是先把命令结构解析出来，它能够认出来你要干什么。

我给你举个例子你就明白了，比如下面这几条命令。

```bash
# 从语法上看，--version 和 --help 都属于 flags
# 但在 Claude Code 中，它们会被 fast path 提前处理
claude --version
claude --help

# 下面的 status、commit、branch 都是 subcommands 子命令
git status
git commit
git branch

# 下面的 --print 是 flag，后面的两段文字是 positional arguments 位置参数
claude "帮我解释这个文件"
claude --print "总结 README.md"
```

flag、subcommand、positional argument 说的是命令在语法上属于哪一类。

fast path 说的是这条命令实际走哪条执行路径。

`--version` 在语法上确实是一个 flag，但 `cli.tsx` 会先直接检查原始的 `process.argv`。一旦发现 `--version`，它会输出版本号并退出。这时 Commander 还没有加载，所以 `preAction` 也不会执行。

`--print` 同样是 flag，但它需要模型、工具和完整运行环境。它需要走 init 的流程。

完整流程大概是这样：

```text
claude --version
  -> cli.tsx 命中 fast path
  -> 输出版本号并退出

claude --print "总结 README.md"
  -> cli.tsx 没有提前退出
  -> Commander 解析命令
  -> 触发 preAction
  -> 执行 init()
  -> 再执行 --print 对应的 handler
```

Claude Code 就是借助了它的 `preAction` 机制。

伪代码是这样：

```ts
program.hook("preAction", async (thisCommand) => {
  await init(thisCommand)
})
```

Commander 先把命令结构解析出来，但暂时不执行对应命令。

等它确认用户要执行哪个命令后，会先触发 `preAction`，调用一次 `init(thisCommand)`。初始化完成，再执行这个命令对应的 handler。

## Phase 3：注册组件（setup.ts）

`init()` 完成以后，会进入 `setup.ts` 流程。

前面的 init.ts 流程走完之后，Claude Code 已经知道了

* 当前的配置是什么
* 当前目录能不能相信
* 权限边界是什么
* 用户要执行哪个命令

走到这里，Claude Code 已经知道自己运行在什么环境中，但命令、Agent、Hooks 和插件还需要完成注册。

这些相互独立的加载任务会尽可能并行执行。

>这里的 Agents 指可供主 Agent 调用的 Agent，比如 Explore、Plan 以及用户自定义的 subagent。

* Commands：有哪些命令可以用
* Agents：有哪些 Agent 定义可以使用
* Hooks：有哪些生命周期钩子要生效
* Plugins：有哪些插件需要加载

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-04-setup-phase.gif" alt="Claude Code setup 阶段并行注册能力动图" style="zoom: 67%;" />

*▲ setup 阶段，把能并行注册的同时推进。*

`setup()` 执行完成以后，Claude Code 才算是把各项组件都准备完毕了。

这里还有一个细节需要注意。

Claude Code 会在这一步读取 Hooks 配置，并把它冻结成一份不可变快照。下面这些 Hook 依然要等对应事件发生时才会执行：

```bash
PreToolUse hook：工具执行前触发
PostToolUse hook：工具执行后触发
Stop hook：Agent 要停止时触发
SessionEnd hook：会话结束时触发
```

你可以把它理解成比赛开始前把规则表定下来。

比赛进行到对应阶段时，`PreToolUse`、`PostToolUse`、`Stop`、`SessionEnd` 仍然会正常触发，只是它们依据的是启动时保存的那份配置。

这一步为什么要这么设计？

这块还是跟权限有关系。

如果某个恶意脚本能在 Claude Code 启动后修改 hooks 配置，它就可能改变后续工具调用的审批规则。

所以 Claude Code 在启动阶段把 Hooks 配置快照固定下来。会话启动后，即使磁盘上的配置文件被修改，当前会话也不会跟着改变。

这里的思路和第一篇讲的权限系统连起来了。

## Phase 4：选择运行入口（replLauncher.ts）

到了 `replLauncher.ts`，启动流程基本上就走到最后了。

大概会有七种入口最后会汇聚到这里：

交互式 REPL、`--print` 一次性输出、SDK mode、`--resume` 恢复会话、`--continue` 继续会话、pipe mode、headless 无头模式。

前面四层已经把环境和组件准备好了。

`replLauncher.ts` 要做的是根据这次调用的配置，选择对应的入口执行。

如果是普通终端对话，那就进入 REPL。

这也是大家平时最熟悉的 Claude Code 形态：终端里出现输入框，用户可以一轮一轮地问，Claude Code 一边执行，一边渲染结果。

> 原文这里提到一个实现细节。
>
> 交互式 REPL 会挂载 React/Ink 组件树。
>
> Ink 你可以简单理解成终端里的 React。
>
> 网页里 React 负责把组件渲染到浏览器 DOM。
>
> Claude Code 这里用 Ink，把组件渲染到终端屏幕上。
>
> 所以终端里那些输入框、状态提示、工具审批、进度变化，并不是随便 `console.log` 打出来的。
>
> 它背后其实是一套**终端 UI。**

下面就是一个  React/Ink 组件树。

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@0c4f3618e9854c451369abcbb961b890a5fb1e0c/claude-code-from-source/ch02/ch02-05-ink-terminal-ui.png" alt="React Ink 渲染 Claude Code 终端 UI 示意图" style="zoom: 25%;" />

*▲ React/Ink 组件持续更新消息、工具状态、审批提示和输入框。*

如果是 `--print` 模式，`--print` 通常用于脚本、CI、自动化流程。

这时用户不需要一个可以交互的终端界面。

它只需要 Claude Code 接收一个 prompt，跑完，然后把结果输出到 stdout 就完事儿了。

所以 `--print` 不会挂上 React/Ink 组件树。

它会创建一个 headless 的 query loop。

headless 的意思就是没有 UI 界面。

模型照样会思考，工具照样会执行，只是外面不再渲染一个终端 UI。

结果会被流式写到标准输出，跑完就完事儿了。

SDK mode 也是同一个道理，它要按 SDK 的协议把事件传到外部，让外部程序消费。

`--resume` 和 `--continue` ，它们只是先把已有会话或上下文恢复出来，然后再进入同一个执行循环。

这里有一个设计很重要。

这些启动方式没有各写一套 Agent 逻辑。

外面看起来有七种入口，但其实都会回到第一篇讲过的 query loop 中。


## 240ms 是怎么来的

> 原文给了一张启动时间线。
>
> 它强调这些时间是近似值，来自代码里的 profiling checkpoint。
>
> 这个 profiling checkpoint 就相当于是代码运行过程中的快照计时时间。
>
> 比如 Java 中的 System.currentTimeMillis()  和 System.nanoTime(); 来计算时间差

| 阶段 | 时间 | 发生了什么 |
| --- | ---: | --- |
| Fast-path check（快速路径检查） | 约 5ms | 检查 `argv`，能直接回答就提前退出 |
| Module evaluation（模块求值） | 约 138ms | 加载依赖树，并让慢 I/O 并行执行 |
| Commander parse（命令解析） | 约 3ms | 解析 flags 和 subcommands |
| `init()` | 约 14ms | 解析配置，建立信任边界 |
| `setup()` | 约 35ms | 注册命令、Agent、Hooks 和插件 |
| Launch + first render 启动 + UI 渲染 | 约 25ms | 选择入口，挂载 React/Ink，渲染 UI |
| **总计** | **约 240ms** | 控制在 300ms 启动预算以内 |

这几项按数字直接相加大约是 220ms，而原文给出的端到端结果约为 240ms，两者之间有约 20ms 的差异。

原文已经提前说明，这些数字来自代码中的 profiling checkpoint，只用于展示大致结构，不能当作一张精确到每一毫秒的耗时清单。

下面的交互图又采用了另一种阶段划分，把首次 API 调用也画了进去，所以图里的单项耗时不会和上面逐项对应。

我们可以确定的是：现代机器上的 warm start 大约在 240ms 这个量级，距离 300ms 的预算线还有一些余量。

> 这里还需要解释一下 warm start 和 cold start。
>
> warm start 可以理解成热启动。比如你刚刚运行过一次 Claude Code，退出后很快又重新执行 `claude`。虽然这次仍然会创建一个新的 CLI 进程，但相关模块文件很可能还在操作系统的文件缓存里，不需要重新从磁盘慢慢读取。
>
> cold start 就是冷启动。比如电脑刚重启，或者 Claude Code 很久没有运行，操作系统缓存里还没有这些文件。模块、依赖和其他启动数据需要重新从磁盘读取，启动时间自然会更长。

简单说：

```text
warm start：东西刚用过，操作系统缓存里还有，启动更快
cold start：第一次使用或者缓存已经没有了，需要重新读取，启动更慢
```

<img src="https://cdn.jsdelivr.net/gh/crisxuan/searchnews-assets@4a168777f1cac89c5123c5d1cedf0cd0f9c04a94/claude-code-from-source/ch02/ch02-04-startup-timeline.gif" alt="Claude Code Startup Timeline" style="zoom: 67%;" />

*▲ 原文给出的启动时间线：warm start 约 240ms，cold start 会更接近 300ms。*

---

我觉得 Claude Code 做的好的一个层面是把整个大的 init 逐渐缩小成为每一层需要处理的问题，职责明确。

这也是很多优秀的设计所需要考虑的地方。

这里就给大家总结一下上面的每一步到底都干了啥。

Phase 0：确认当前阶段是否需要进行 Bootstrap 。
一开始，用户只是在终端输入了一条指令。

比如 claude --version、claude --help ，这类指令会直接返回，不需要加载模型、不需要启动 UI。

Phase 1：所有的东西都必须加载 => 模块加载与 IO 异步并行。

这里 main.tsx 主要做了一个事儿：模块加载的同时，把 MDM 和 Keychain 这类 I/O 异步执行。

Phase 2：这一阶段是 Claude Code 与环境建立可信状态。

这层主要是由 init.ts 来负责。刚启动时，Claude Code 对当前环境还没完全信任，这一层 init.ts 会解析配置，建立 trust boundary 信任边界。

Phase 3：这一阶段主要是把 Claude Code 的各个组件注册好。

前面只是做了一堆加载和检查，这一层实际完成 Claude Code 的组件注册，比如有哪些 Agent 、Hooks 、插件可用，完成这一步之后，系统才知道我能干，这一层由 setup.ts 负责完成这项工作。

Phase 4：根据对应的注册入口选择运行模式。

用户可以以多种方式启动 Claude Code，系统需要知道用户采用的哪种启动方式，再来根据对应的模式启动。这一步完成后，才真正进入后面的执行入口 query loop。

这就是一个生产级 Agent runtime 的启动方式。

---

参考资料：

- Claude Code from Source, Chapter 2: Starting Fast — The Bootstrap Pipeline
  https://claude-code-from-source.com/ch02-bootstrap/
- Claude Code from Source, Chapter 1: The Architecture of an AI Agent
  https://claude-code-from-source.com/ch01-architecture/
