# CLI Mode Sync Guide

> 本文档供 Agent 在原作者 (op7418/CodePilot) 更新后执行同步操作时使用。
> 执行前请完整阅读本文档，理解改动原理后再操作。

## 背景

我们对 CodePilot 做了一个核心改造：**移除 Claude Agent SDK，改为直接调用 Claude Code CLI**。

原因：SDK 的 `spawn({ env: customEnv })` 会完全替换子进程环境，导致 Claude Code 无法读取 `~/.claude/settings.json` 中的 env overrides（如 proxy 配置 `ANTHROPIC_BASE_URL`）。直接调用 CLI 并继承 `process.env` 可以解决这个问题。

## 我们的改动摘要

### 核心原则

1. **不使用 `@anthropic-ai/claude-agent-sdk`** — 已从 `package.json` 移除
2. **用 `child_process.spawn` 调用 `claude --print --output-format stream-json --verbose`** 替代 SDK 的 `query()`
3. **CLI 继承 `process.env`**，不构造自定义环境
4. **Settings UI 移除了 Providers 标签页**（CLI 模式下 provider 由 `~/.claude/settings.json` 管理）
5. **model 参数传短别名**（如 `opus`/`sonnet`/`haiku`），让 CLI 通过自己的 settings 解析实际模型 ID

### 改动文件清单

| 文件 | 改动说明 |
|------|----------|
| `package.json` | 移除 `@anthropic-ai/claude-agent-sdk` 依赖 |
| `src/types/index.ts` | 添加 `CliSystemMessage`、`CliAssistantMessage`、`CliUserMessage`、`CliResultMessage` 等 CLI 消息类型；添加本地 `PermissionResult`、`PermissionUpdate`、`PermissionMode` 类型（替代 SDK 导入） |
| `src/lib/claude-client.ts` | **核心文件**。移除所有 SDK 导入，改用 `spawn` + `readline` NDJSON 解析。新增 `buildCliEnv()`、`buildCliArgs()`。`streamClaude()` 和 `generateTextViaSdk()` 完全重写。支持 resume 失败自动重试 |
| `src/lib/conversation-registry.ts` | `Query` → `ChildProcess` |
| `src/lib/permission-registry.ts` | `PermissionResult` 从 `@/types` 导入而非 SDK |
| `src/lib/bridge/permission-broker.ts` | `PermissionUpdate` 从 `@/types` 导入而非 SDK |
| `src/lib/agent-sdk-capabilities.ts` | 移除 SDK 导入，使用本地接口，`captureCapabilities` 和 `refreshMcpStatus` 为 no-op |
| `src/lib/agent-sdk-agents.ts` | 移除 SDK 导入，使用本地 `AgentDefinition` 接口 |
| `src/app/api/chat/route.ts` | model 传 `effectiveModel`（短别名）而非 `resolved.upstreamModel` |
| `src/app/api/chat/interrupt/route.ts` | `conversation.interrupt()` → `conversation.kill('SIGINT')` |
| `src/app/api/chat/mode/route.ts` | 返回 `{ applied: true }`，mode 通过 `--permission-mode` CLI flag 在下次消息时生效 |
| `src/app/api/chat/model/route.ts` | 返回 `{ applied: true }`，model 通过 `--model` CLI flag 在下次消息时生效 |
| `src/app/api/chat/rewind/route.ts` | 返回 not-supported stub |
| `src/app/api/chat/structured/route.ts` | 用 `spawn` 替代 SDK `query()`，通过 system prompt 指导 JSON 输出 |
| `src/app/api/chat/permission/route.ts` | 导入改为从 `@/types` |
| `src/app/api/plugins/mcp/reconnect/route.ts` | 返回 not-supported stub |
| `src/app/api/plugins/mcp/toggle/route.ts` | 返回 not-supported stub |
| `src/app/api/providers/models/route.ts` | 移除 SDK model discovery 代码块，使用静态 DEFAULT_MODELS |
| `src/components/settings/SettingsLayout.tsx` | 移除 Providers 标签页和 ProviderManager 导入 |

## 同步操作流程

### Step 1: 拉取原作者最新代码并 rebase

```bash
cd /Users/maemolee/GitHub/CodePilot
git fetch origin
git rebase origin/main
```

### Step 2: 处理冲突

如果 rebase 报冲突，按以下规则解决：

#### 规则 A — `package.json` / `package-lock.json`
- 接受原作者新增的依赖
- **确保 `@anthropic-ai/claude-agent-sdk` 不在 dependencies 中**
- 冲突解决后运行 `npm install` 重新生成 lockfile

#### 规则 B — `src/lib/claude-client.ts`（最可能冲突）
- 这是改动最大的文件。如果原作者重构了此文件，需要手动合并
- **原则：保留原作者新增的功能逻辑，但调用方式必须是 `spawn` CLI 而非 SDK `query()`**
- 关键检查点：
  - 不能有 `import { query } from '@anthropic-ai/claude-agent-sdk'`
  - 不能有 `import type { Options, SDKResultSuccess, ... } from '@anthropic-ai/claude-agent-sdk'`
  - `streamClaude()` 必须用 `spawn(claudePath, cliArgs, ...)` 而非 `query({ prompt, options })`
  - `generateTextViaSdk()` 同上
  - `buildCliEnv()` 必须返回 `{ ...process.env, ... }`（继承环境）
  - `assistant` message handler 必须处理 `text` blocks（`controller.enqueue(formatSSE({ type: 'text', data: block.text }))`）

#### 规则 C — `src/types/index.ts`
- 接受原作者新增的类型
- **确保以下本地类型定义存在**（不从 SDK 导入）：
  - `PermissionBehavior`, `PermissionMode`, `PermissionUpdateDestination`, `PermissionRuleValue`, `PermissionUpdate`, `PermissionResult`
  - `CliSystemMessage`, `CliAssistantMessage`, `CliUserMessage`, `CliResultMessage`, `CliStreamEventMessage`, `CliMessage`

#### 规则 D — 控制路由（interrupt/mode/model/rewind/mcp/*）
- 如果原作者增加了新的 SDK 方法调用（如 `conversation.someNewMethod()`），改为 stub 返回或等效 CLI 操作
- `interrupt`: 必须是 `conversation.kill('SIGINT')`，不能是 `conversation.interrupt()`

#### 规则 E — `SettingsLayout.tsx`
- 如果原作者在 Settings 新增了标签页，保留
- **Providers 标签页必须保持移除**（不导入 `ProviderManager`，不渲染 `providers` section）

#### 规则 F — 任何新文件 `import from '@anthropic-ai/claude-agent-sdk'`
- 如果原作者新增了导入 SDK 的文件，需要改为使用本地类型或 CLI 调用
- 搜索命令：`grep -r "from '@anthropic-ai/claude-agent-sdk'" src/`
- 结果必须为空

### Step 3: 验证

```bash
# 1. 确认没有 SDK 导入残留
grep -r "from '@anthropic-ai/claude-agent-sdk'" src/
# 期望：无输出

# 2. 确认 SDK 不在依赖中
grep "claude-agent-sdk" package.json
# 期望：无输出

# 3. TypeScript 编译
npx tsc --noEmit
# 期望：无错误

# 4. 单元测试
npm run test
# 期望：通过（2 个环境相关的 provider-resolver 测试可能因本地 ANTHROPIC_BASE_URL 失败，属正常）

# 5. 构建
npm run build
# 期望：成功
```

### Step 4: 推送

```bash
git push fork main --force-with-lease
```

## 如果原作者做了大重构

如果原作者对 `claude-client.ts` 做了大规模重构（如拆分文件、重命名函数），rebase 冲突可能无法自动解决。此时：

1. `git rebase --abort` 放弃 rebase
2. 从原作者最新代码创建新分支：`git checkout -b cli-mode-redo origin/main`
3. 重新应用 CLI 模式改造（参照上方"改动文件清单"）
4. 关键：`claude-client.ts` 中找到 `query()` 调用，替换为 `spawn` + NDJSON 解析
5. 全局搜索替换 SDK 导入：`grep -r "claude-agent-sdk" src/`
6. 通过验证步骤后合并回 main
