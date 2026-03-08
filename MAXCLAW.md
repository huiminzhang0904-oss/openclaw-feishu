# MaxClaw 适配记录

基于 openclaw 上游的 MiniMax 定制化 fork。本文档记录所有改动点、已知坑点和同步流程。

## 仓库结构

- **agent-claw** (`gitlab.xaminim.com:matrix/agent-claw`): openclaw 上游 fork，分支 `release/maxclaw` 包含 MiniMax 定制
- **agent-server** (`gitlab.xaminim.com:matrix/agent-server`): MiniMax AI agent 框架，`openclaw/` 子目录存放 openclaw 源码（直接 cp 覆盖方式同步）
- 同步方式: `rsync -a --exclude='.git' --exclude='node_modules' openclaw-ori/ agent-server/openclaw/`

## 定制改动清单

### 1. MiniMax provider 兼容

- **文件**: `src/config/defaults.ts`
- **改动**: 添加 `isAnthropicCompatibleProvider()` 函数，让 minimax 在 auth/cache/stream 等逻辑中与 anthropic 等价
- **影响范围**: 认证模式选择、缓存保留策略、上下文裁剪默认值

```diff
+ function isAnthropicCompatibleProvider(provider: string | undefined): boolean {
+   return provider === "anthropic" || provider === "minimax";
+ }
```

### 2. 缓存 TTL

- **文件**: `src/agents/pi-embedded-runner/cache-ttl.ts`
- **改动**: `CACHE_TTL_NATIVE_PROVIDERS` Set 中加入 `"minimax"`

```diff
- const CACHE_TTL_NATIVE_PROVIDERS = new Set(["anthropic", "moonshot", "zai"]);
+ const CACHE_TTL_NATIVE_PROVIDERS = new Set(["anthropic", "minimax", "moonshot", "zai"]);
```

### 3. cacheRetention

- **文件**: `src/agents/pi-embedded-runner/extra-params.ts`
- **改动**: `isAnthropicDirect` 判断包含 `provider === "minimax"`

```diff
- const isAnthropicDirect = provider === "anthropic";
+ const isAnthropicDirect = provider === "anthropic" || provider === "minimax";
```

### 4. 中文双语错误文本

- **文件**: `src/agents/pi-embedded-helpers/errors.ts`
- **改动**: 所有用户可见错误消息追加 `\n中文翻译`，包括:
  - 计费错误、速率限制、服务过载
  - 上下文溢出、消息顺序冲突、缺失工具调用
  - 请求被拒、超时、未知错误、Cloudflare 不可用
- **新增**: `STATUS_CODE_MESSAGE_MAP` 处理 minimax 特有的 status_code 错误（如 1400010161 余额不足）
- **新增函数**: `isStatusCodeErrorPayload()`, `extractStatusCodePayload()`, `formatStatusCodeError()`

```diff
+ const STATUS_CODE_MESSAGE_MAP = new Map<number, string>([
+   [1400010161, "Your account has insufficient credits. Please top up and try again.\n您的账户余额已用完，请充值以继续体验。"],
+ ]);
```

### 5. 通用错误文本

- **文件**: `src/agents/pi-embedded-runner/run/payloads.ts`
- **改动**: `genericErrorText` 追加中文

```diff
- const genericErrorText = "The AI service returned an error. Please try again.";
+ const genericErrorText = "The AI service returned an error. Please try again.\nAI 服务返回了错误，请重试。";
```

### 6. Agent end 回退文本

- **文件**: `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`
- **改动**: 回退文本追加中文

```diff
- const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
+ const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.\nLLM 请求失败。").trim();
```

### 7. metadata.user_id 注入

- **文件**: `src/agents/pi-embedded-runner/run/attempt.ts`
- **改动**: 在 anthropic-messages API 请求中将 `sessionId` 注入到 `metadata.user_id`
- **插入位置**: `cacheTrace.wrapStreamFn` 之后、`anthropicPayloadLogger` 之前

```diff
+ // Inject metadata.user_id into Anthropic API payloads for abuse tracking.
+ if (params.sessionId && params.model.api === "anthropic-messages") {
+   const innerStreamFn = activeSession.agent.streamFn ?? streamSimple;
+   const metadataUserId = params.sessionId;
+   activeSession.agent.streamFn = (model, context, options) => {
+     const originalOnPayload = options?.onPayload;
+     return innerStreamFn(model, context, {
+       ...options,
+       onPayload: (payload) => {
+         if (payload && typeof payload === "object") {
+           (payload as { metadata?: { user_id?: string } }).metadata = {
+             ...(payload as { metadata?: Record<string, unknown> }).metadata,
+             user_id: metadataUserId,
+           };
+         }
+         originalOnPayload?.(payload);
+       },
+     });
+   };
+ }
```

### 8. 禁用内置工具

- **文件**: `src/agents/openclaw-tools.ts`
- **改动**: 环境变量 `OPENCLAW_DISABLE_REPLACED_BUILTINS=1` 可从源码级跳过 `web_search`、`web_fetch`、`image` 工具的创建
- **用途**: 配合 agent-server 的 MCP 工具替代方案，比 `tools.deny` 配置更可靠

```diff
+ const disableReplacedBuiltins = process.env.OPENCLAW_DISABLE_REPLACED_BUILTINS === "1";
+
  // image tool
- const imageTool = createImageTool({...});
+ const imageTool = disableReplacedBuiltins
+   ? null
+   : createImageTool({...});

  // web tools
- const webSearchTool = createWebSearchTool({...});
- const webFetchTool = createWebFetchTool({...});
+ const webSearchTool = disableReplacedBuiltins
+   ? null
+   : createWebSearchTool({...});
+ const webFetchTool = disableReplacedBuiltins
+   ? null
+   : createWebFetchTool({...});
```

### 9. matrix-mcp 插件

- **文件**: `extensions/matrix-mcp/` (插件目录) + `src/plugins/config-state.ts`
- **改动**:
  - MCP 工具桥接插件，从 agent-server 的 MCP endpoint 同步工具并注册到 openclaw gateway
  - 添加到 `BUNDLED_ENABLED_BY_DEFAULT` 实现自动启用

```diff
  // extensions/matrix-mcp/index.ts
+ export default function register(api: OpenClawPluginApi) {
+   const tools = listToolsSync();
+   if (tools.length === 0) {
+     api.logger.warn("[matrix-mcp] no tools from MCP server (is it running?)");
+     return;
+   }
+   for (const tool of tools) {
+     api.registerTool(createTool(tool));
+   }
+   api.logger.info(`[matrix-mcp] registered ${tools.length} tools`);
+ }
```

```diff
  // src/plugins/config-state.ts
  export const BUNDLED_ENABLED_BY_DEFAULT = new Set<string>([
    "device-pair",
    "phone-control",
    "talk-voice",
+   "matrix-mcp",
  ]);
```

### 10. Gateway agent 方法 — `/abort` 命令与 `stopReason` 支持

上游 openclaw 新版移除了 Gateway `agent` 方法中的 `/abort` 命令拦截和 AbortController 生命周期管理，导致 `stop_run` 调用链断裂。需要手动补回。

#### 10a. `stopReason` 参数 schema

- **文件**: `src/gateway/protocol/schema/agent.ts`
- **改动**: `AgentParamsSchema` 中添加 `stopReason: Type.Optional(Type.String())`
- **原因**: agent-server 的 Python 服务 `claw/service.py` 在 `stop_run` 和 `out_of_credit` 时通过 Gateway RPC 调用 `agent` 方法并携带 `stopReason` 参数，上游 schema 设置了 `additionalProperties: false` 会拒绝未声明的属性

```diff
  // src/gateway/protocol/schema/agent.ts — AgentParamsSchema
+   stopReason: Type.Optional(Type.String()),
```

#### 10b. `/abort` 命令拦截

- **文件**: `src/gateway/agent-abort.ts`（新建）+ `src/gateway/server-methods/agent.ts`
- **改动**:
  - 新建 `agent-abort.ts`，提供 `isAgentAbortCommand`、`handleAgentAbort`、`createAgentAbortController`、`cleanupAgentAbortController`
  - 在 `agent.ts` handler 中：消息解析后检测 `/abort` 命令 → 解析 `sessionKey` → 调用 `handleAgentAbort` 中断所有该 session 的运行中 agent run → 返回结果
  - 为每次 `agentCommandFromIngress` 调用创建 `AbortController`，将 `abortSignal` 传入 agent run（中断 LLM 流式调用），在 `.finally()` 中清理
  - `request` 类型断言中补充 `stopReason?: string` 字段
- **调用链**: `POST /agent/chat/stop_run` → `claw/service.py` → `claw_proxy.call(method="agent", message="/abort", stopReason=...)` → Gateway agent handler → `handleAgentAbort` → `controller.abort(stopReason)`

```diff
+ // src/gateway/agent-abort.ts（新文件）
+ export function isAgentAbortCommand(message: string): boolean {
+   const trimmed = message.trim();
+   if (trimmed.toLowerCase() === "/abort") return true;
+   return isChatStopCommandText(trimmed);
+ }
+
+ export function handleAgentAbort(params: HandleAgentAbortParams): HandleAgentAbortResult {
+   const { sessionKey, ops, stopReason } = params;
+   return abortChatRunsForSessionKey(ops, {
+     sessionKey,
+     stopReason: stopReason ?? "abort-command",
+   });
+ }
```

```diff
  // src/gateway/server-methods/agent.ts
+ if (isAgentAbortCommand(message)) {
+   const abortSessionKey = typeof request.sessionKey === "string" && request.sessionKey.trim()
+     ? request.sessionKey.trim()
+     : resolveExplicitAgentSessionKey({...});
+   const result = handleAgentAbort({
+     sessionKey: abortSessionKey,
+     ops,
+     stopReason: typeof request.stopReason === "string" ? request.stopReason : undefined,
+   });
+   respond(true, { ok: true, aborted: result.aborted, runIds: result.runIds, sessionKey: abortSessionKey });
+   return;
+ }
```

#### 10c. `controller.abort()` 传递 stopReason

- **文件**: `src/gateway/chat-abort.ts`
- **改动**: `abortChatRunById` 中 `active.controller.abort()` 改为 `active.controller.abort(stopReason)`，使下游通过 `signal.reason` 可获取停止原因

```diff
- active.controller.abort();
+ active.controller.abort(stopReason);
```

### 12. Sub-agent 超时时间下限

- **文件**: `src/agents/tools/sessions-spawn-tool.ts`
- **改动**: sub-agent spawn 时，如果传入了非零的 `runTimeoutSeconds`，clamp 到至少 600 秒（10 分钟），防止 LLM 误设过短超时导致复杂任务被中断
- **原因**: 上游默认允许任意超时值（含 0 表示无限），但实际使用中 LLM 经常给 sub-agent 设 30-60 秒的超时，导致长时间任务被提前终止

```diff
  // Default to 0 (no timeout) when omitted. Sub-agent runs are long-lived
  // by default and should not inherit the main agent 600s timeout.
+ // When a non-zero value is provided, clamp to at least 600s so the LLM
+ // cannot accidentally set a too-short timeout for complex tasks.
+ const MIN_SUBAGENT_TIMEOUT_SECONDS = 600;
  const timeoutSecondsCandidate =
      typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
              ? params.timeoutSeconds
              : undefined;
  const runTimeoutSeconds =
      typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
-         ? Math.max(0, Math.floor(timeoutSecondsCandidate))
+         ? timeoutSecondsCandidate > 0
+             ? Math.max(MIN_SUBAGENT_TIMEOUT_SECONDS, Math.floor(timeoutSecondsCandidate))
+             : 0
          : undefined;
```

### 13. Web 端 assistant 事件回退 (enforceFinalTag)

- **文件**: `src/agents/pi-embedded-subscribe.handlers.messages.ts`
- **改动**: `handleMessageEnd` 中 rawText 回退条件从 `if (!cleanedText && !hasMedia && !ctx.params.enforceFinalTag)` 改回 `if (!cleanedText && !hasMedia)`
- **原因**: 上游新增的 `enforceFinalTag` 守卫阻止了 rawText 回退，导致 claw-bridge 收不到 assistant 文本事件，web 端看不到飞书等 channel 的 agent 回复
- **影响**: 确保即使启用 `enforceFinalTag`，channel 回复内容仍能通过 claw-bridge 代理到 web 端显示

```diff
- if (!cleanedText && !hasMedia && !ctx.params.enforceFinalTag) {
+ // Keep assistant-event fallback even when enforceFinalTag is enabled.
+ // Without this, channel replies may be delivered while web chat misses
+ // assistant text when streamed deltas/assistant_texts are empty.
+ if (!cleanedText && !hasMedia) {
    const rawTrimmed = rawText.trim();
    const rawStrippedFinal = rawTrimmed.replace(/<\s*\/?\s*final\s*>/gi, "").trim();
    const rawCandidate = rawStrippedFinal || rawTrimmed;
    if (rawCandidate) {
      const parsedFallback = parseReplyDirectives(stripTrailingDirective(rawCandidate));
      cleanedText = parsedFallback.text ?? rawCandidate;
      mediaUrls = parsedFallback.mediaUrls;
      hasMedia = Boolean(mediaUrls && mediaUrls.length > 0);
    }
  }
```

## 已知坑点

### A2UI Bundle (重要)

`src/canvas-host/a2ui/a2ui.bundle.js` 被 `.gitignore` 排除，但 Docker build 时必须存在。

**原因**: 上游 CI 有完整 `vendor/a2ui/` 和 `apps/shared/` 源码可以实时编译 bundle。但 agent-server 的 Dockerfile 只 `COPY openclaw/` 子目录进 Docker，没有这些源码。`scripts/bundle-a2ui.sh` 检测到源码缺失，如果预构建 bundle 也不存在就会报错退出。

**解决方案**: 本地生成 bundle 后 `git add -f` 强制提交:

```bash
cd openclaw-ori
pnpm install
pnpm canvas:a2ui:bundle
# 然后在 agent-server 中:
git add -f openclaw/src/canvas-host/a2ui/a2ui.bundle.js openclaw/src/canvas-host/a2ui/.bundle.hash
```

**每次从上游同步 openclaw 后都要检查这个文件是否存在。**

### 插件文件权限 (重要)

新版 openclaw 有安全检查（`src/plugins/discovery.ts`），拒绝加载 world-writable (mode=666) 的插件文件。Docker 容器内默认 umask 会导致所有文件权限为 666。

**解决方案**: agent-server 的 Dockerfile 里 `COPY . .` 之后加:

```dockerfile
RUN chmod -R go-w /app/openclaw/extensions/
```

**连锁影响**: 权限错误会导致所有插件（包括 memory-core, feishu, claw-bridge, matrix-mcp 等）加载失败，进而触发 `plugins.slots.memory: plugin not found: memory-core` 错误，gateway 启动崩溃。

### 记忆搜索 (memory_search)

内置记忆搜索工具在没有配置 embedding API key 时会自动降级为 FTS（全文搜索）模式，使用 SQLite FTS5 做关键词搜索。不需要额外适配或替换为 grep。

如果看到 `disabled` 错误，检查 memory 文件是否存在于 `~/.openclaw/memory/` 以及 FTS 索引是否已初始化。

### MCP 支持

新版 openclaw **不原生支持通用 MCP server 配置**。ACP translator 层虽然有 `mcpServers` 参数但会直接忽略。工具注册仍然依赖插件系统（`api.registerTool()`），所以 `matrix-mcp` 插件方案仍然是正确的做法。

### message 工具发送的消息 web 端看不到

**现象**: agent 通过 `message` 工具向飞书等 channel 发送消息时，飞书能收到，但 web 端只显示工具调用记录，看不到实际消息内容。而 agent 的后续文本回复（如"已发送！请查收飞书消息"）web 端能看到，但飞书不发送（被 message 工具抑制机制跳过）。

**原因**: openclaw 的设计中，message 工具成功发送后会标记"channel 投递已完成"（`Committed messaging text`），后续 LLM 文本不再通过 auto-reply dispatcher 发到 channel（`replies=0`）。同时 claw-bridge 将 message 工具调用作为 `before_tool_call`/`after_tool_call` 事件转发，Python 服务处理时 `msg_content=""` 为空，web 端只看到工具调用卡片。

**解决方案**: 修改 `claw/service.py` 的 `_handle_after_tool_call`，当 message 工具成功执行发送类 action（`send`/`reply`/`thread-reply`/`broadcast`/`sendWithEffect`）时，从 `params.message` 提取消息内容填入 `msg_content`，使 web 端同时显示消息内容。

```diff
  # claw/service.py — _handle_after_tool_call

+ # message 工具成功发送时，将消息内容作为 msg_content 提交，
+ # 使 web 端也能看到通过 message 工具发到飞书等 channel 的消息。
+ msg_content = ""
+ if raw_tool_name == "message" and not is_error:
+     params_dict = req.params if isinstance(req.params, dict) else {}
+     action = params_dict.get("action", "")
+     if action in ("send", "sendWithEffect", "reply", "thread-reply", "broadcast"):
+         msg_text = params_dict.get("message", "")
+         if isinstance(msg_text, str) and msg_text.strip():
+             msg_content = msg_text.strip()

  resp_data = RespData(
      type=RespDataType.AgentMessage,
      agent_message=AgentMessage(
          msg_id=msg_id,
-         msg_content="",
+         msg_content=msg_content,
          timestamp=finish_at,
          tool_calls=[formatted_tool_call],
      ),
  )
```

**注意**: 这不是 openclaw 上游的 bug，而是 agent-server 架构（claw-bridge 代理到 web 端）的适配需求。上游设计中 web 端通过 Gateway 原生 WebSocket 直接看到所有事件，不依赖 claw-bridge 转发。

## 同步流程（从上游更新 openclaw 到 agent-server）

```bash
# 1. 在 openclaw-ori 拉取上游最新代码
cd openclaw-ori
git fetch old-origin
git merge old-origin/main  # 或 rebase

# 2. 重新应用/检查 MiniMax 定制改动（如有冲突需手动解决）

# 3. 安装依赖并生成 A2UI bundle
pnpm install
pnpm canvas:a2ui:bundle

# 4. 提交到 release/maxclaw 分支
git add -A
git add -f src/canvas-host/a2ui/a2ui.bundle.js src/canvas-host/a2ui/.bundle.hash
git commit -m "chore: sync upstream and rebuild a2ui bundle"
git push origin release/maxclaw

# 5. 同步到 agent-server
cd ../agent-server
rm -rf openclaw/
rsync -a --exclude='.git' --exclude='node_modules' ../openclaw-ori/ openclaw/

# 6. 强制添加被 gitignore 排除的必要文件
git add -f openclaw/src/canvas-host/a2ui/a2ui.bundle.js openclaw/src/canvas-host/a2ui/.bundle.hash

# 7. 提交推送
git add openclaw/
git commit -m "chore: update openclaw to latest release/maxclaw"
git push
```

## CI 测试

agent-server 的 `.gitlab-ci.yml` 中配置了 openclaw 测试，仅在 `test/*` 分支触发：

- `openclaw-test-unit` — 单元测试 (`pnpm test:fast`)
- `openclaw-test-gateway` — Gateway 集成测试
- `openclaw-test-channels` — 通道测试
- `openclaw-test-extensions` — 插件测试
- `openclaw-test-e2e` — 端到端测试

真实 LLM 调用测试 (`pnpm test:live`) 需人工执行。
