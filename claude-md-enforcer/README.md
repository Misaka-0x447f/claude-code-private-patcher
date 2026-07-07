# claude-code-private-patcher

一个 Claude Code 的 `PreToolUse` 钩子脚本,用一个低成本模型(经 OpenRouter 调用 `deepseek/deepseek-v4-flash`)判断当前会话中助手对用户的回复,其开头第一句话是否清楚地声明了自己的具体模型名称。不合规就阻断当前的工具调用。

## 依赖

- Node.js 18+(需要内置 `fetch` 与 `AbortController`,无第三方依赖)
- Claude Code 支持 `hookSpecificOutput` 格式的 PreToolUse 钩子

## 配置步骤

### 1. 准备密钥文件

在 `~/.claude/claude-md-guard-chatkey` 里写入你的 OpenRouter API key(单行字符串,首尾空白会被自动 trim),并把权限收紧:

```
mkdir -p ~/.claude
printf 'sk-or-...' > ~/.claude/claude-md-guard-chatkey
chmod 600 ~/.claude/claude-md-guard-chatkey
```

权限过宽(其他用户可读)时脚本会在 stderr 打印警告,但不会阻断。

### 2. 在 Claude Code settings 里挂钩

编辑 `~/.claude/settings.json`(或对应 scope 的 settings 文件),加入:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/misaka/git/claude-code-private-patcher/claude-md-enforcer/main.js"
          }
        ]
      }
    ]
  }
}
```

`matcher: "*"` 匹配所有工具调用,确保每一轮真正说话之后的第一次工具调用都会被拦下来做检查。

## 判定逻辑

一次 PreToolUse 触发时,脚本按如下顺序处理:

1. 从 stdin 读取 hook JSON,取 `session_id` 与 `transcript_path`。
2. 读 transcript JSONL 尾部,从末尾往前找到第 3 条"真实用户发言"作为解析起点,避免长会话每次全量扫描;逐行 `JSON.parse`,单行解析失败会跳过而不整体崩溃。"真实用户发言"= `role: user` 且内容为纯文本或含 `type: text` 块,**并且**不是 harness 注入的伪用户消息 —— `isMeta: true`、`[Request interrupted...]` 打断标记、`<system-reminder>` / `<task-notification>` / `<local-command-stdout>` / `<local-command-caveat>` / `<command-name>` / local-command Caveat 开头的文本都会被过滤(这些消息在协议上是 user 角色,但不是人说的话;若不过滤,它们会推进 `latestUserUuid`,让已通过的轮次被重新审查,审到的往往是任务中途无前缀义务的 assistant 文本,造成误 block)。
3. 在剩余消息里找出**最新一条真实用户发言**的 `uuid` —— 记作 `latestUserUuid`。
4. 从 `os.tmpdir()/claude-hook-state/<sanitized-session-id>.json` 读取两个字段:
   - `lastPassedUserUuid` —— 上次通过检查时的用户消息 uuid。
   - `lastBlockedAssistantUuid` —— 上次 block 时那段不合规发言所在的 assistant 消息 uuid。
5. 若 `state.lastPassedUserUuid === latestUserUuid` → 本轮已通过,直接放行,不调用 API。
6. 决定"从哪里开始查找 assistant 发言文本"的锚点:
   - 如果 `state.lastBlockedAssistantUuid` 存在、在当前消息列表里找得到、且位置在 `latestUserUuid` **之后** → 用它作为锚点(表示"上次已经判过这个 assistant 消息,应该看它之后的新回复")。
   - 否则用 `latestUserUuid` 作为锚点(新一轮,或者被 block 后用户又发了新消息)。
7. 从锚点之后开始遍历,找到**下一个** `role: assistant` 消息中的**第一个** `type: text` 内容块。工具调用(`tool_use`)和工具结果回传(`tool_result`,虽然在协议上是 `role: user`)都被显式忽略。
8. 如果找不到任何 assistant 文本(助手直接连着调工具、还没生成新的文字) → 放行,不更新状态、不调 API,等下一次 hook 再看。
9. 找到发言文本 → 读 `~/.claude/claude-md-guard-chatkey`,调用 OpenRouter,把发言原文交给 `deepseek/deepseek-v4-flash`,让它语义判断"开头第一句话是否清楚提到了具体的模型名称"。脚本自身不做任何正则或字符串匹配。judge 的 system prompt 里显式注入了 Claude 全系列及常见友商模型名(Claude、Fable、Mythos、Opus、Sonnet、Haiku、GPT、DeepSeek、Gemini、Grok、Qwen 及版本号/组合形式),并要求"没见过的名字也按有效处理"——否则 judge 模型的训练数据晚于新模型发布时,会把 "Fable 5" 这类新名字判成"不是模型名"造成整轮误 block(2026-07-02 实际踩坑)。
10. 判断结果:
    - `compliant: true` → 写入 `{lastPassedUserUuid: latestUserUuid, lastBlockedAssistantUuid: null}` 后放行。
    - `compliant: false` → 写入 `{lastPassedUserUuid: 保持原值, lastBlockedAssistantUuid: 当前发言所在的 assistant 消息 uuid}`,通过 `hookSpecificOutput.permissionDecision = "deny"` 阻断本次工具调用。`permissionDecisionReason` 统一固定为 `"检测到违反用户级 CLAUDE.md 要求。请阅读并复述一遍该文件，并确保复述的过程中也遵守要求，再继续。"`,判断模型给出的具体理由会写到 stderr 供调试查看,不进入对话上下文。

### 为什么需要两个锚点

只用 `latestUserUuid` 会陷入死循环:助手被 block 之后,用户没说话就让助手自己修正,此时 `latestUserUuid` 没变,脚本每次都会从**同一个用户消息之后**找**同一段**已经被判过不合规的 assistant text 送去判断,永远得到 `false`,永远 block。

引入 `lastBlockedAssistantUuid` 之后,被 block 的 assistant 消息 uuid 会被记下来。下一次触发时,锚点前进到那个消息之后,才能看到助手修正后的**新** assistant 消息,判断也才能得到"合规"的结果并放行。

## 错误处理

严格遵循"不接受静默错误"。所有会导致无法完成合规判断的**配置或程序错误**都会 **block** 当前工具调用,并把详细原因原文写进 `permissionDecisionReason`(与内容不合规的固定文案区分开,方便你一眼看出到底是"我说错了"还是"hook 本身崩了"):

- 密钥文件不存在或为空
- 密钥文件 IO 错误
- 状态文件 IO 错误(非文件缺失)
- OpenRouter 请求失败、返回非 2xx、响应结构异常
- 判断模型响应无法解析为 JSON、或缺失 `compliant` 字段
- OpenRouter 调用超过 15 秒未返回(硬超时,通过 `AbortController` 触发)
- hook 输入 JSON 解析失败、缺失关键字段
- 任何未捕获异常(经顶层 catch 兜底)

只有下列情况才是"不需要判断而静默放行"(exit 0 无输出):

- transcript 里还没有任何真实用户发言
- 当前轮已经通过过检查(状态文件里 uuid 相同)
- 当前轮里助手还没说过任何文字

状态文件写入失败属于"主检查已通过、但缓存写不进去"的次要错误,不会阻断,而是 stderr 打警告 —— 后果只是下一次工具调用可能对同一轮重复调一次 OpenRouter。

## 状态文件

- 目录:`$TMPDIR/claude-hook-state/`(macOS/Linux 常见为 `/tmp/claude-hook-state/`)
- 文件名:`<sanitized-session-id>.json`,其中 sanitize 会把非 `[a-zA-Z0-9_-]` 字符全部替换成 `_`,并截断到 128 字符,防止路径穿越。
- 内容:`{"lastPassedUserUuid": "<uuid>"}`
- 清理:不自动清理。tmpdir 通常由操作系统重启时清理,如需主动回收可自建 cron。

## 明确不做的事

- 不感知会话中途切换模型的场景(目前无稳定的 hook 渠道通知模型变更)。
- 不监听 `SessionEnd` 自动清 state(该事件触发条件不稳定)。
- 不对 `/clear`、`/exit` 做特殊处理,按 Claude Code 默认行为走。
- 不做正则或字符串匹配来判定合规性 —— 完全由 OpenRouter 上的判断模型决定。
