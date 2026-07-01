#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const JUDGE_MODEL = 'deepseek/deepseek-v4-flash';
const API_TIMEOUT_MS = 15000;
const KEY_FILE = path.join(os.homedir(), '.claude', 'claude-md-guard-chatkey');
const STATE_DIR = path.join(os.tmpdir(), 'claude-hook-state');
const RECENT_USER_TURNS = 3;

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function emitBlock(reason) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

function emitAllow() {
  process.exit(0);
}

function getRole(msg) {
  return msg?.message?.role ?? msg?.role ?? msg?.type ?? null;
}

function getContent(msg) {
  return msg?.message?.content ?? msg?.content ?? null;
}

function isRealUserMessage(msg) {
  if (getRole(msg) !== 'user') return false;
  const content = getContent(msg);
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(b => b?.type === 'text');
  }
  return false;
}

async function loadTranscriptTail(transcriptPath) {
  let raw;
  try {
    raw = await fs.readFile(transcriptPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`读取 transcript 文件失败 (${transcriptPath}): ${err.message}`);
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const collected = [];
  let userSeen = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    collected.unshift(parsed);
    if (isRealUserMessage(parsed)) {
      userSeen++;
      if (userSeen >= RECENT_USER_TURNS) break;
    }
  }
  return collected;
}

function findLatestUserUuid(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) {
      return messages[i]?.uuid ?? null;
    }
  }
  return null;
}

function findFirstAssistantTextAfter(messages, afterUserUuid) {
  const idx = messages.findIndex(m => m?.uuid === afterUserUuid);
  if (idx < 0) return null;
  for (let i = idx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (getRole(m) !== 'assistant') continue;
    const content = getContent(m);
    if (typeof content === 'string' && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
        return block.text;
      }
    }
  }
  return null;
}

function sanitizeSessionId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'unknown-session';
}

function stateFilePath(sessionId) {
  return path.join(STATE_DIR, `${sanitizeSessionId(sessionId)}.json`);
}

async function readState(sessionId) {
  const p = stateFilePath(sessionId);
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lastPassedUserUuid: null };
    throw new Error(`读取状态文件失败 (${p}): ${err.message}`);
  }
  try {
    const obj = JSON.parse(raw);
    return { lastPassedUserUuid: obj?.lastPassedUserUuid ?? null };
  } catch {
    process.stderr.write(
      `[claude-md-guard] 警告: 状态文件 ${p} 内容损坏,已按空状态处理并将在通过后覆盖。\n`
    );
    return { lastPassedUserUuid: null };
  }
}

async function writeState(sessionId, state) {
  const p = stateFilePath(sessionId);
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(p, JSON.stringify(state), 'utf8');
  } catch (err) {
    process.stderr.write(
      `[claude-md-guard] 警告: 状态文件写入失败 (${p}): ${err.message}。本轮已通过,但下一次工具调用可能被重复检查。\n`
    );
  }
}

async function readApiKey() {
  let raw;
  try {
    raw = await fs.readFile(KEY_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `配置缺失: 密钥文件 ${KEY_FILE} 不存在。请创建该文件并写入 OpenRouter API key(单行字符串,建议 chmod 600)。`
      );
    }
    throw new Error(`读取密钥文件失败 (${KEY_FILE}): ${err.message}`);
  }
  try {
    const stat = await fs.stat(KEY_FILE);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      process.stderr.write(
        `[claude-md-guard] 警告: 密钥文件 ${KEY_FILE} 权限为 ${mode.toString(8)},其他用户可读,建议执行 chmod 600 ${KEY_FILE}。\n`
      );
    }
  } catch {
    // stat 失败不影响主流程
  }
  const key = raw.trim();
  if (!key) {
    throw new Error(`配置错误: 密钥文件 ${KEY_FILE} 内容为空,请写入 OpenRouter API key。`);
  }
  return key;
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

async function callJudge(assistantText, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const body = {
    model: JUDGE_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是发言合规检查器。给你一段来自 AI 助手的发言原文,只需要判断该发言的开头(即第一句话的起始位置)是否清楚地提到了它自己的具体模型名称——例如 Claude、Opus、Sonnet、Haiku、GPT、DeepSeek、Gemini、Grok、Qwen 等具体的模型标识,或类似 "Opus 4.7" 这样的版本号形式。判断只看开头,不看后续内容;只要开头明确出现了具体模型名称就算合规。仅输出严格的 JSON 对象:{"compliant": true|false, "reason": "简短说明"}。禁止 Markdown、代码块、任何额外说明文字。',
      },
      {
        role: 'user',
        content:
          '助手发言原文(用 --- 包裹):\n\n---\n' +
          assistantText +
          '\n---\n\n请判断该发言的开头(第一句话)是否清楚地提到了具体的模型名称。',
      },
    ],
  };

  let resp;
  try {
    resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new Error(`调用 OpenRouter 超时(${API_TIMEOUT_MS} ms 内未返回)。`);
    }
    throw new Error(`调用 OpenRouter 请求失败: ${err?.message ?? String(err)}`);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '<无法读取响应体>');
    throw new Error(`OpenRouter 返回 HTTP ${resp.status}: ${bodyText.slice(0, 500)}`);
  }

  let respJson;
  try {
    respJson = await resp.json();
  } catch (err) {
    throw new Error(`OpenRouter 响应无法解析为 JSON: ${err?.message ?? String(err)}`);
  }

  const content = respJson?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(
      `OpenRouter 响应结构异常,未找到 choices[0].message.content 文本: ${JSON.stringify(respJson).slice(0, 500)}`
    );
  }

  let verdict;
  try {
    verdict = JSON.parse(content);
  } catch {
    const extracted = extractJsonObject(content);
    if (!extracted) {
      throw new Error(`判断模型未返回有效 JSON: ${content.slice(0, 500)}`);
    }
    try {
      verdict = JSON.parse(extracted);
    } catch (err) {
      throw new Error(
        `判断模型响应中提取的 JSON 仍无法解析: ${err?.message ?? String(err)},原文: ${content.slice(0, 500)}`
      );
    }
  }

  if (typeof verdict?.compliant !== 'boolean') {
    throw new Error(
      `判断模型返回缺少 compliant 布尔字段: ${JSON.stringify(verdict).slice(0, 500)}`
    );
  }
  return {
    compliant: verdict.compliant,
    reason: typeof verdict.reason === 'string' ? verdict.reason : '',
  };
}

async function main() {
  const stdinRaw = await readStdin();
  let input;
  try {
    input = JSON.parse(stdinRaw);
  } catch (err) {
    emitBlock(`Hook 输入 JSON 解析失败: ${err?.message ?? String(err)}`);
    return;
  }

  const sessionId = input?.session_id;
  const transcriptPath = input?.transcript_path;
  if (!sessionId || !transcriptPath) {
    emitBlock('Hook 输入缺少 session_id 或 transcript_path 字段,无法定位会话与消息记录。');
    return;
  }

  const messages = await loadTranscriptTail(transcriptPath);
  const latestUserUuid = findLatestUserUuid(messages);
  if (!latestUserUuid) {
    emitAllow();
    return;
  }

  const state = await readState(sessionId);
  if (state.lastPassedUserUuid === latestUserUuid) {
    emitAllow();
    return;
  }

  const assistantText = findFirstAssistantTextAfter(messages, latestUserUuid);
  if (!assistantText) {
    emitAllow();
    return;
  }

  const apiKey = await readApiKey();
  const verdict = await callJudge(assistantText, apiKey);
  if (verdict.compliant) {
    await writeState(sessionId, { lastPassedUserUuid: latestUserUuid });
    emitAllow();
    return;
  }

  emitBlock(
    `本轮回复的开头未清晰声明模型身份。要求:在回应用户的第一句话开头,写出当前正在使用的具体模型名称(例如 "Claude Opus 4.7 " 之类)。判断模型给出的理由: ${
      verdict.reason || '(未提供)'
    }`
  );
}

main().catch(err => {
  emitBlock(`Hook 执行异常: ${err?.message ?? String(err)}`);
});
