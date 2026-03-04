# 多 IM 远程会话桥接系统

## 核心思路

让用户通过 Telegram（后续可扩展 Discord/飞书等）远程操控 CodePilot 中的 Claude 会话。复用现有 `streamClaude()` 管线，在服务端消费 SSE 流，而非通过浏览器。

## 目录结构

```
src/lib/bridge/
├── types.ts                 # 共享类型（ChannelBinding, BridgeStatus, InboundMessage 等）
├── channel-adapter.ts       # 抽象基类 + adapter 注册表（registerAdapterFactory/createAdapter）
├── channel-router.ts        # (channel, user, thread) → session 映射，自动创建/绑定会话
├── conversation-engine.ts   # 服务端消费 streamClaude() SSE 流，保存消息到 DB，onPartialText 流式回调
├── permission-broker.ts     # 权限请求转发到 IM 内联按钮，处理回调审批
├── delivery-layer.ts        # 出站消息分片、限流、重试退避、HTML 降级
├── bridge-manager.ts        # 生命周期编排，adapter 事件循环，流式预览状态机，deliverResponse 渲染分发
├── markdown/
│   ├── ir.ts                # Markdown → IR 中间表示解析器（基于 markdown-it）
│   ├── render.ts            # IR → 格式化输出的通用标记渲染器
│   └── telegram.ts          # Telegram HTML 渲染 + 文件引用保护 + render-first 分片
├── markdown/
│   ├── ...                  # (见上)
│   └── feishu.ts            # 飞书 Markdown 处理：hasComplexMarkdown / buildCardContent / buildPostContent / htmlToFeishuMarkdown
├── adapters/
│   ├── index.ts             # Adapter 目录文件（side-effect import 自注册所有 adapter）
│   ├── telegram-adapter.ts  # Telegram 长轮询 + offset 安全水位 + 图片/相册处理 + 自注册
│   ├── telegram-media.ts    # Telegram 图片下载、尺寸选择、base64 转换
│   ├── telegram-utils.ts    # callTelegramApi / sendMessageDraft / escapeHtml / splitMessage
│   ├── feishu-adapter.ts    # 飞书 WSClient + REST 消息收发 + typing 指示器 + 自注册
│   └── discord-adapter.ts   # Discord.js Client + Gateway intents + 按钮交互 + 流式预览 + 自注册
├── markdown/
│   └── discord.ts           # Discord 消息分片（2000 字符限制）+ 代码围栏平衡
└── security/
    ├── rate-limiter.ts      # 按 chat 滑动窗口限流（20 条/分钟）
    └── validators.ts        # 路径/SessionID/危险输入校验
```

## 数据流

### 飞书

```
飞书消息 → WSClient(WebSocket) → EventDispatcher
  → im.message.receive_v1 → handleIncomingEvent()
    → 去重(message_id LRU 1000) → 授权检查 → 群策略过滤 → @提及检查
    → text → parseTextContent() → enqueue()
    → image → downloadResource(stream/writeFile) → base64 FileAttachment → enqueue()
    → post → parsePostContent() 提取文本+图片 → enqueue()
    → /perm 文本命令 → 构造 callbackData → enqueue()
  → BridgeManager.runAdapterLoop() → handleMessage()
    → deliverResponse():
      → hasComplexMarkdown(代码块/表格)? → sendAsCard() [schema 2.0 markdown]
      → 纯文本? → sendAsPost() [msg_type: post, md tag]
    → 权限请求 → sendPermissionCard() [schema 2.0 卡片 + /perm 文本命令]
```

### Discord

```
Discord 消息 → discord.js Client (Gateway WebSocket)
  → messageCreate → processMessage()
    → bot/self 过滤 → 去重(messageId Set 1000) → 授权检查(user+channel)
    → guild 策略过滤(allowed_guilds + group_policy) → @提及检查
    → !command → /command 规范化
    → 图片附件 → fetch(url) → base64 FileAttachment
    → enqueue()
  → interactionCreate → handleInteraction()
    → deferUpdate() (3s Discord 超时) → 存储 Interaction(60s TTL) → enqueue(callbackData)
  → BridgeManager.runAdapterLoop() → handleMessage()
    → deliverResponse():
      → markdownToDiscordChunks(2000 字符, 代码围栏平衡) → 逐块发送
    → 权限请求 → ActionRowBuilder + ButtonBuilder 组件
    → 流式预览 → channel.send() 首次 / message.edit() 后续 / delete 结束
    → typing → channel.sendTyping() 每 8s
```

**Discord 关键设计决策：**
- **原生 Markdown**：Discord 原生支持 Markdown，无需 IR→HTML 转换（不同于 Telegram）
- **保守流式默认值**：Discord 编辑限速 5/5s/channel，默认 interval 1500ms, minDelta 40 chars
- **按钮交互**：deferUpdate() 立即响应（3s Discord 超时），存储 Interaction 对象供 answerCallback 使用，60s TTL 清理
- **授权默认拒绝**：空白允许列表 = 拒绝所有（安全优先，同飞书模式）
- **`!` 命令别名**：在 adapter 层规范化为 `/` 命令后入队——bridge-manager 命令处理器无需改动

### Telegram

```
Telegram 消息 → TelegramAdapter.pollLoop()
  → 纯文本/caption → enqueue()
  → 单图 → telegram-media.downloadPhoto() → base64 FileAttachment → enqueue(msg + attachments)
  → 相册(media_group_id) → bufferMediaGroup() → 500ms 防抖 → flushMediaGroup() 批量下载 → enqueue()
  → BridgeManager.runAdapterLoop() → handleMessage()
    → 命令? → handleCommand() 处理 /new /bind /cwd /mode /stop 等
    → 普通消息/图片? → ChannelRouter.resolve() 获取 ChannelBinding
      → ConversationEngine.processMessage(binding, text, ..., files?, onPartialText?)
        → 有图片时：写入 .codepilot-uploads/ + <!--files:JSON-->text 格式存 DB（桌面 UI 可渲染）
        → streamClaude({ prompt, files }) → Claude vision API
        → consumeStream() 服务端消费
          → permission_request → 立即回调 → PermissionBroker 转发到 IM
          → text → 累积 currentText + previewText → onPartialText(previewText) 回调
          → tool_use/tool_result → 累积内容块（currentText 清零，previewText 不清零）
          → result → 捕获 tokenUsage + sdkSessionId
        → addMessage() 保存到 DB
      → deliverResponse() 按 channelType 分发渲染:
        → Telegram: markdownToTelegramChunks() → deliverRendered() → 限流 + HTML/plain 双通道
        → 其他 IM: deliver() → 纯文本分块发送
    → finally: adapter.acknowledgeUpdate(updateId) → 推进 committedOffset 并持久化
```

## DB 表（在 db.ts migrateDb 中）

| 表 | 用途 |
|---|------|
| channel_bindings | IM 地址 → CodePilot session 映射 |
| channel_offsets | 轮询 offset 持久化（key 为 bot user ID，通过 getMe API 获取） |
| channel_dedupe | 出站消息幂等去重 |
| channel_outbound_refs | 平台消息 ID 映射 |
| channel_audit_logs | 审计日志 |
| channel_permission_links | 权限请求 → IM 消息映射（含 resolved 标记） |

## 关键设计决策

**1. 权限请求死锁解决**
SSE 流在 `permission_request` 事件处会阻塞等待审批。`consumeStream()` 通过 `onPermissionRequest` 回调在流消费过程中立即转发到 IM，而非等流结束后再转发。

**2. Offset 安全水位**
分离 `fetchOffset`（用于 getUpdates API）和 `committedOffset`（持久化到 DB）。消息入队时仅推进 fetchOffset，只有在 bridge-manager 完整处理完消息后（handleMessage 的 finally 块），才调用 `adapter.acknowledgeUpdate(updateId)` 推进 committedOffset 并持久化到 DB。`markUpdateProcessed()` 使用连续水位推进（contiguous walk）：仅当 `recentUpdateIds` 中存在当前 committedOffset 时才前进，避免跳过仍在 media group buffer 中的相册更新 ID。相册 flush 时预注册所有 buffered ID 到 recentUpdateIds，保证 ack 时水位能连续推过。内存 dedup set 防止重启后重复处理。

**2a. Bot 身份标识**
Offset 的 DB key 使用 Telegram `getMe` API 返回的 bot user ID（如 `telegram:bot123456`），而非 token hash。好处是 token 轮换后 offset 不丢失。首次迁移时自动将旧 token-hash key 的值复制到新 bot-ID key。

**3. 并发模型**
`processWithSessionLock()` 实现同会话串行、跨会话并行。不同用户的消息不互相阻塞。

**4. Adapter 注册式架构**
新 IM 只需实现 `BaseChannelAdapter` 并调用 `registerAdapterFactory()` 自注册，然后在 `adapters/index.ts` 中添加一行 side-effect import。bridge-manager 通过 `import './adapters'` 加载目录，registry 自动发现所有已注册的 adapter，无硬编码依赖。

**5. 权限回调安全**
PermissionBroker 在处理 IM 内联按钮回调时，验证 callbackData 中的 chatId 和 messageId 与存储的 permission_link 记录匹配，防止跨聊天伪造审批。`markPermissionLinkResolved()` 使用 `AND resolved = 0` 原子条件更新，确保同一权限请求不被重复审批。

**6. 输入校验**
`security/validators.ts` 对所有 IM 入站命令参数做校验：工作目录路径（拒绝 `..`、null 字节、shell 元字符）、session ID（hex/UUID 格式）、危险输入检测（命令注入、管道符）。`sanitizeInput()` 剥离控制字符并限制 32K 长度。

**7. runAdapterLoop 必须在 state.running = true 之后启动**
`runAdapterLoop` 内部是 fire-and-forget 的 async IIFE，循环条件 `while (state.running && ...)` 在第一个 `await` 之前同步求值。如果调用时 `state.running` 还是 `false`，循环直接跳过，消费者永远不会启动，消息入队后无人消费。`start()` 中必须先设 `state.running = true`，再调用 `runAdapterLoop`。

**8. 出站限流**
`security/rate-limiter.ts` 按 chatId 滑动窗口限流（默认 20 条/分钟）。`DeliveryLayer` 在每次发送前调用 `rateLimiter.acquire(chatId)` 阻塞等待配额，分片间额外加 300ms 节流。错误分类：429 尊重 `retry_after`、5xx 指数退避、4xx 不重试、解析错误降级纯文本。

**9. Telegram 图片接收**
复用已有 `streamClaude({ files })` vision 管道，不引入 sharp 等 native 依赖。`telegram-media.ts` 负责图片下载：`selectOptimalPhoto()` 从 Telegram 的 photo[] 多尺寸数组中选最小且长边 ≥ 1568px（Claude vision 最优值）的版本；`downloadFileById()` 含 3 次重试 + 指数退避 + 双重大小校验。统一返回 `MediaDownloadResult { attachment, rejected, rejectedMessage }`，拒绝时直接发 Telegram 通知，禁止静默丢弃。相册消息通过 500ms 防抖合并（`media_group_id` → `mediaGroupBuffers` Map）。`InboundMessage.attachments` 透传到 `conversation-engine` 和 `streamClaude`。

**10. 图片消息 DB 格式统一**
Bridge 和桌面端使用相同的消息存储格式：图片写入 `.codepilot-uploads/`，消息 content 以 `<!--files:[{id,name,type,size,filePath}]-->text` 格式保存。桌面 UI 的 `MessageItem.parseMessageFiles()` 解析后通过 `FileAttachmentDisplay` + `/api/uploads?path=` 渲染缩略图。`conversation-engine.ts` 中 `getSession()` 提前到文件持久化之前调用，确保 workingDirectory 可用。

**11. Telegram 出站 Markdown 渲染**
Claude 的回复是 Markdown 格式，Telegram 仅支持有限 HTML 标签（b/i/s/code/pre+code/blockquote/a）。采用三层架构将 Markdown 转换为 Telegram HTML：

- **IR 层**（`markdown/ir.ts`）：使用 markdown-it 将 Markdown 解析为中间表示 `MarkdownIR = { text, styles[], links[] }`。text 是纯文本，styles 是 `{ start, end, style }` 区间标记。支持 bold/italic/strikethrough/code/code_block/blockquote/links/lists/headings/tables/hr。表格使用 code-block 模式渲染为 ASCII 表格（包裹在 `<pre><code>` 中保留对齐）。HTML 内联标签中的 `<br>` 被转换为换行符。
- **渲染层**（`markdown/render.ts`）：通用标记渲染器 `renderMarkdownWithMarkers(ir, options)`，接受样式→标签映射表 + escapeText + buildLink 回调，输出格式化文本。使用 boundary tracking + LIFO stack 处理嵌套。
- **Telegram 层**（`markdown/telegram.ts`）：组合 IR+渲染器，映射样式到 Telegram HTML 标签。`wrapFileReferencesInHtml()` 防止 `README.md`、`main.go` 等文件名被 Telegram linkify 误识别为 URL（用 `<code>` 包裹）。`markdownToTelegramChunks(text, limit)` 实现 render-first 分片：先按 IR text 长度分块，再渲染每块为 HTML，若 HTML 超出 4096 限制则按比例重新分割。

`bridge-manager.ts` 通过 `deliverResponse()` 按 `adapter.channelType` 分发渲染：Telegram 走 `markdownToTelegramChunks()` + `deliverRendered()`（HTML/plain 双通道），其他 IM 走 `deliver()` 纯文本。`deliverRendered()` 在分块部分失败时继续投递剩余 chunk 并追发截断提示，最终返回 `ok: false` 标识不完整投递。命令响应和错误消息仍使用 `escapeHtml()` + `deliver()`。

**12. Telegram 流式预览（sendMessageDraft）**
利用 Telegram Bot API 9.5 的 `sendMessageDraft` 方法，在 Claude 生成过程中以草稿形式实时展示文本预览。架构上抽象为通道级可选能力（`BaseChannelAdapter` 的 `getPreviewCapabilities`/`sendPreview`/`endPreview` 三个可选方法），未实现这些方法的 adapter 自动跳过。

- **引擎层**：`consumeStream()` 维护独立的 `previewText` 变量（只累积、不因 `tool_use` 清零），通过 `onPartialText` 回调同步传递完整预览文本。
- **编排层**：`bridge-manager.handleMessage()` 检查 adapter 能力 → 分配 `draftId` → 构建节流闭包（间隔 700ms + 最小增量 20 字符 + trailing-edge timer）→ `flushPreview()` fire-and-forget 发送 → finally 清理 timer + `endPreview()`。
- **降级**：`sendPreview` 返回 `'sent'|'skip'|'degrade'` 三态。400/404（API 不支持）→ 永久降级该 chatId；429/网络错误 → 仅跳过本次。`previewDegraded` Set 在 adapter `stop()` 时清空。
- **线程安全**：`processWithSessionLock` 保证同 session 串行 → 同时刻只有一个 `previewState`。多个 in-flight `sendMessageDraft` 安全：Telegram 对同 `draft_id` last-write-wins。

**13. 飞书适配器 — WSClient + 渲染分流**
飞书使用 `@larksuiteoapi/node-sdk` 的 `WSClient`（长连接 WebSocket）接收事件，`Client`（REST）发送消息和下载资源。与 Telegram 的 HTTP 长轮询不同，WSClient 由 SDK 管理重连。消息去重使用内存 Map LRU（上限 1000），无需持久化 offset。

**14. 飞书渲染策略 — Card vs Post**
Claude 回复按内容分流渲染（对齐 Openclaw 方案）：
- 含代码块（` ``` `）或表格 → `msg_type: 'interactive'`，schema 2.0 卡片（`{ tag: 'markdown', content }` 元素），代码高亮和表格正常渲染。
- 纯文本 → `msg_type: 'post'`，`{ tag: 'md', text }` 格式，渲染粗体、斜体、行内代码、链接。
- 每层发送失败自动降级：card → post → text。

`markdown/feishu.ts` 的 `hasComplexMarkdown()` 负责路由判断，`buildCardContent()` / `buildPostContent()` 构建消息体。

**15. 飞书权限交互 — 无按钮，文本命令兜底**
**关键限制**：飞书卡片交互回调（card.action.trigger）需要 HTTP webhook 端点，不支持通过 WSClient 长连接接收。Openclaw 通过 `http.createServer()` + `Lark.adaptDefault()` 暴露公网 webhook 解决。CodePilot 是桌面应用无公网端点，因此：
- Schema 2.0 不支持 `action` 标签（错误码 200861）
- Schema 1.0 的 `action` 标签可渲染按钮，但点击报 200340（无 webhook 端点接收回调）
- **最终方案**：权限卡片使用 schema 2.0 markdown 展示信息 + `/perm` 文本命令。用户复制命令发送即可审批。`processIncomingEvent()` 检测 `/perm` 前缀并构造 `callbackData`，走 `permission-broker.handlePermissionCallback()` 标准流程。

**16. 飞书 Typing 指示器 — Emoji Reaction**
飞书无 typing indicator API。使用 Openclaw 方案：`onMessageStart()` 在用户消息上添加 "Typing" emoji reaction（`im.messageReaction.create`），`onMessageEnd()` 删除。`lastIncomingMessageId` Map 追踪每个 chat 的最新消息 ID。非关键路径，fire-and-forget。

**17. 飞书 @提及检测**
通过 `/bot/v3/info/` REST API 获取 bot 的 `open_id`/`bot_id`，存入 `botIds` Set。群聊消息检查 `event.message.mentions` 数组中是否有匹配的 ID。文本中的 `@_user_N` 占位符由 `stripMentionMarkers()` 清理。

**18. Telegram 通知模式互斥**
`telegram-bot.ts` 的通知功能（UI 会话通知）与 bridge 模式互斥。通过 `globalThis.__codepilot_bridge_mode_active` 标志协调（存 globalThis 防 HMR 重置）。Bridge 启动时设 `true`，4 个 notify 函数检查此标志后提前返回。

## 设置项（settings 表）

| Key | 说明 |
|-----|------|
| remote_bridge_enabled | 总开关 |
| bridge_telegram_enabled | Telegram 通道开关 |
| bridge_auto_start | 服务启动时自动拉起桥接 |
| bridge_default_work_dir | 新建会话默认工作目录 |
| bridge_default_model | 新建会话默认模型 |
| bridge_default_provider_id | 新建会话默认服务商 |
| telegram_bridge_allowed_users | 白名单用户 ID（逗号分隔） |
| bridge_telegram_image_enabled | Telegram 图片接收开关（默认 true，设为 false 关闭） |
| bridge_telegram_max_image_size | 图片大小上限（字节，默认 20MB） |
| bridge_telegram_stream_enabled | 流式预览总开关（默认启用，设为 `false` 关闭） |
| bridge_telegram_stream_interval_ms | 预览节流间隔（默认 700ms） |
| bridge_telegram_stream_min_delta_chars | 最小增量字符数（默认 20） |
| bridge_telegram_stream_max_chars | 草稿截断阈值（默认 3900） |
| bridge_telegram_stream_private_only | 仅私聊启用预览（默认 true，群聊自动跳过） |
| bridge_feishu_enabled | 飞书通道开关 |
| bridge_feishu_app_id | 飞书应用 App ID |
| bridge_feishu_app_secret | 飞书应用 App Secret（API 返回脱敏） |
| bridge_feishu_domain | 平台域名：`feishu`（默认）或 `lark` |
| bridge_feishu_allowed_users | 允许的 open_id/chat_id（逗号分隔，空=不限） |
| bridge_feishu_group_policy | 群消息策略：`open`（默认）/ `allowlist` / `disabled` |
| bridge_feishu_group_allow_from | 群聊白名单 chat_id（逗号分隔） |
| bridge_feishu_require_mention | 群聊需要 @bot 才触发（默认 true） |

## API 路由

| 路由 | 方法 | 功能 |
|------|------|------|
| /api/bridge | GET | 返回 BridgeStatus（纯查询，无副作用） |
| /api/bridge | POST | `{ action: 'start' \| 'stop' \| 'auto-start' }` |
| /api/bridge/channels | GET | 列出活跃通道（支持 `?active=true/false` 过滤） |
| /api/bridge/settings | GET/PUT | 读写 bridge 设置 |

## Telegram 命令

| 命令 | 功能 |
|------|------|
| /new [path] | 新建会话 |
| /bind \<session_id\> | 绑定已有会话 |
| /cwd /path | 切换工作目录 |
| /mode plan\|code\|ask | 切换模式 |
| /status | 当前状态 |
| /sessions | 列出会话 |
| /stop | 中止运行中任务 |
| /help | 帮助 |

## 相关文件（bridge 之外）

- `src/lib/telegram-bot.ts` — 通知模式（UI 发起会话的通知），与 bridge 模式互斥
- `src/lib/permission-registry.ts` — 权限 Promise 注册表，bridge 和 UI 共用
- `src/lib/claude-client.ts` — streamClaude()，bridge 和 UI 共用
- `src/components/bridge/BridgeSection.tsx` — Bridge 设置 UI（一级导航 /bridge），含 Telegram/飞书通道开关
- `src/components/bridge/BridgeLayout.tsx` — 侧边栏导航（Telegram + Feishu 入口）
- `src/components/bridge/TelegramBridgeSection.tsx` — Telegram 凭据 + 白名单设置 UI（/bridge#telegram）
- `src/components/bridge/FeishuBridgeSection.tsx` — 飞书凭据 + 群聊策略 + 域名选择 UI（/bridge#feishu）
- `src/app/api/settings/feishu/route.ts` — 飞书设置读写 API
- `src/app/api/settings/feishu/verify/route.ts` — 飞书凭据验证 API（测试 token 获取 + bot info）
- `electron/main.ts` — 窗口关闭时 bridge 活跃则保持后台运行；启动时通过 POST `auto-start` 触发桥接恢复
- `src/app/api/settings/telegram/verify/route.ts` — 支持 `register_commands` action 注册 Telegram 命令菜单
