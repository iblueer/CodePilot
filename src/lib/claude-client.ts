import { spawn, type ChildProcess } from 'child_process';
import readline from 'readline';
import type {
  ClaudeStreamOptions,
  SSEEvent,
  TokenUsage,
  FileAttachment,
  CliAssistantMessage,
  CliResultMessage,
  CliSystemMessage,
  CliUserMessage,
} from '@/types';
import { isImageFile } from '@/types';
import { registerConversation, unregisterConversation, getConversation } from './conversation-registry';
import { getSetting, updateSdkSessionId } from './db';
import { findClaudeBinary, findGitBash, getExpandedPath, invalidateClaudePathCache } from './platform';
import { notifyGeneric } from './telegram-bot';
import os from 'os';
import fs from 'fs';
import path from 'path';

/**
 * Sanitize a string for use as an environment variable value.
 * Removes null bytes and control characters that cause spawn EINVAL.
 */
function sanitizeEnvValue(value: string): string {

  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Sanitize all values in an env record so child_process.spawn won't
 * throw EINVAL due to invalid characters or non-string values.
 * On Windows, spawn is strict: every env value MUST be a string.
 * Spreading process.env can include undefined values which cause EINVAL.
 */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      clean[key] = sanitizeEnvValue(value);
    }
  }
  return clean;
}

let cachedClaudePath: string | null | undefined;

function findClaudePath(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath || undefined;
  const found = findClaudeBinary();
  cachedClaudePath = found ?? null;
  return found;
}

/**
 * Invalidate the cached Claude binary path in this module AND in platform.ts.
 * Must be called after installation so the next CLI call picks up the new binary.
 */
export function invalidateClaudeClientCache(): void {
  cachedClaudePath = undefined; // reset to "not yet looked up"
  invalidateClaudePathCache();  // also reset the 60s TTL cache in platform.ts
}

/**
 * Format an SSE line from an event object
 */
function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Clean ANSI escape codes, OSC sequences, and control characters from stderr.
 */
function cleanStderr(data: string): string {
  return data
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC sequences
    .replace(/\x1B\([A-Z]/g, '')               // Character set selection
    .replace(/\x1B[=>]/g, '')                   // Keypad mode
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Control chars (keep \t \n \r)
    .replace(/\r\n/g, '\n')                    // Normalize CRLF
    .replace(/\r/g, '\n')                      // Convert remaining CR to LF
    .replace(/\n{3,}/g, '\n\n')                // Collapse multiple blank lines
    .trim();
}

/**
 * Get file paths for non-image attachments. If the file already has a
 * persisted filePath (written by the uploads route), reuse it. Otherwise
 * fall back to writing the file to .codepilot-uploads/.
 */
function getUploadedFilePaths(files: FileAttachment[], workDir: string): string[] {
  const paths: string[] = [];
  let uploadDir: string | undefined;
  for (const file of files) {
    if (file.filePath) {
      paths.push(file.filePath);
    } else {
      // Fallback: write file to disk (should not happen in normal flow)
      if (!uploadDir) {
        uploadDir = path.join(workDir, '.codepilot-uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
      }
      const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
      const buffer = Buffer.from(file.data, 'base64');
      fs.writeFileSync(filePath, buffer);
      paths.push(filePath);
    }
  }
  return paths;
}

/**
 * Build a context-enriched prompt by prepending conversation history.
 * Used when CLI session resume is unavailable or fails.
 */
function buildPromptWithHistory(
  prompt: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history || history.length === 0) return prompt;

  const lines: string[] = [
    '<conversation_history>',
    '(This is a summary of earlier conversation turns for context. Tool calls shown here were already executed — do not repeat them or output their markers as text.)',
  ];
  for (const msg of history) {
    // For assistant messages with tool blocks (JSON arrays), extract only the text portions.
    // Tool-use and tool-result blocks are omitted to avoid Claude parroting them as plain text.
    let content = msg.content;
    if (msg.role === 'assistant' && content.startsWith('[')) {
      try {
        const blocks = JSON.parse(content);
        const parts: string[] = [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) parts.push(b.text);
          // Skip tool_use and tool_result — they were already executed
        }
        content = parts.length > 0 ? parts.join('\n') : '(assistant used tools)';
      } catch {
        // Not JSON, use as-is
      }
    }
    lines.push(`${msg.role === 'user' ? 'Human' : 'Assistant'}: ${content}`);
  }
  lines.push('</conversation_history>');
  lines.push('');
  lines.push(prompt);
  return lines.join('\n');
}

/**
 * Build the environment for the Claude Code CLI subprocess.
 * Inherits process.env (which includes user shell env from Electron's
 * loadUserShellEnv), ensuring the CLI can read its own settings normally.
 */
function buildCliEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Ensure HOME/USERPROFILE are set so Claude Code can find ~/.claude/
  if (!env.HOME) env.HOME = os.homedir();
  if (!env.USERPROFILE) env.USERPROFILE = os.homedir();

  // Ensure CLI subprocess has expanded PATH (consistent with Electron mode)
  env.PATH = getExpandedPath();

  // Remove CLAUDECODE env var to prevent "nested session" detection.
  // When CodePilot is launched from within a Claude Code CLI session
  // (e.g. during development), the child process inherits this variable
  // and the CLI refuses to start.
  delete env.CLAUDECODE;

  // On Windows, auto-detect Git Bash if not already configured
  if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashPath = findGitBash();
    if (gitBashPath) {
      env.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
    }
  }

  return env;
}

/**
 * Build CLI arguments for the Claude Code subprocess.
 */
function buildCliArgs(params: {
  model?: string;
  resumeSessionId?: string;
  skipPermissions: boolean;
  permissionMode?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  thinking?: ClaudeStreamOptions['thinking'];
  effort?: ClaudeStreamOptions['effort'];
}): string[] {
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  if (params.model) {
    args.push('--model', params.model);
  }

  if (params.resumeSessionId) {
    args.push('--resume', params.resumeSessionId);
  }

  if (params.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else if (params.permissionMode) {
    // Map CodePilot permission modes to CLI modes
    let cliMode = params.permissionMode;
    if (cliMode === 'code') cliMode = 'acceptEdits';
    args.push('--permission-mode', cliMode);
  }

  if (!params.skipPermissions && params.allowedTools && params.allowedTools.length > 0) {
    args.push('--allowedTools', params.allowedTools.join(','));
  }

  if (params.systemPrompt) {
    // Use preset+append so Claude Code keeps its default system prompt
    args.push('--system-prompt', JSON.stringify({
      type: 'preset',
      preset: 'claude_code',
      append: params.systemPrompt,
    }));
  }

  if (params.maxTurns) {
    args.push('--max-turns', String(params.maxTurns));
  }

  if (params.thinking) {
    if (params.thinking.type === 'enabled') {
      args.push('--thinking');
      if ('budgetTokens' in params.thinking && params.thinking.budgetTokens) {
        args.push('--thinking-budget', String(params.thinking.budgetTokens));
      }
    }
  }

  if (params.effort) {
    args.push('--effort', params.effort);
  }

  return args;
}

/**
 * Lightweight text generation via the Claude Code CLI subprocess.
 * Uses direct CLI invocation without sessions, MCP, permissions,
 * or conversation history. Suitable for simple tasks like
 * generating tool descriptions.
 */
export async function generateTextViaSdk(params: {
  providerId?: string;
  model?: string;
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const claudePath = findClaudePath();
  if (!claudePath) {
    throw new Error('Claude Code CLI not found');
  }

  const args = buildCliArgs({
    model: params.model,
    skipPermissions: true,
    systemPrompt: params.system,
    maxTurns: 1,
  });

  // Append prompt as positional argument
  args.push(params.prompt);

  const childEnv = buildCliEnv();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(claudePath, args, {
      cwd: os.homedir(),
      env: sanitizeEnv(childEnv) as NodeJS.ProcessEnv,
      stdio: 'pipe',
    });

    let resultText = '';
    const rl = readline.createInterface({ input: child.stdout! });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'result' && msg.result) {
          resultText = msg.result;
        }
      } catch { /* ignore non-JSON lines */ }
    });

    // Auto-timeout after 60s to prevent indefinite hangs
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('CLI query timed out after 60s'));
    }, 60_000);

    if (params.abortSignal) {
      params.abortSignal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (resultText) {
        resolve(resultText);
      } else {
        reject(new Error(`CLI returned no result (exit code: ${code})`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.stdin?.end();
  });
}

export function streamClaude(options: ClaudeStreamOptions): ReadableStream<string> {
  const {
    prompt,
    sessionId,
    sdkSessionId,
    model,
    systemPrompt,
    workingDirectory,
    abortController,
    permissionMode,
    files,
    toolTimeoutSeconds = 0,
    conversationHistory,
    onRuntimeStatusChange,
    imageAgentMode,
    bypassPermissions: sessionBypassPermissions,
    allowedTools: optionAllowedTools,
    thinking,
    effort,
    autoTrigger,
  } = options;

  return new ReadableStream<string>({
    async start(controller) {
      try {
        const claudePath = findClaudePath();
        if (!claudePath) {
          throw new Error('Claude Code CLI not found. Please ensure Claude Code is installed and available in your PATH.');
        }

        // Check if dangerously_skip_permissions is enabled globally or per-session
        const globalSkip = getSetting('dangerously_skip_permissions') === 'true';
        const skipPermissions = globalSkip || !!sessionBypassPermissions;

        // Determine if we should resume
        let shouldResume = !!sdkSessionId;
        if (shouldResume && workingDirectory && !fs.existsSync(workingDirectory)) {
          console.warn(`[claude-client] Working directory "${workingDirectory}" does not exist, skipping resume`);
          shouldResume = false;
          if (sessionId) {
            try { updateSdkSessionId(sessionId, ''); } catch { /* best effort */ }
          }
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({
              notification: true,
              title: 'Session fallback',
              message: 'Original working directory no longer exists. Starting fresh conversation.',
            }),
          }));
        }

        // Retry loop: if resume fails (e.g. old SDK session ID), retry without resume
        for (let attempt = 0; attempt < 2; attempt++) {
        const isRetry = attempt > 0;
        if (isRetry) {
          shouldResume = false;
          console.log('[claude-client] Retrying without --resume after resume failure');
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({
              notification: true,
              title: 'Session restart',
              message: 'Previous session not found. Starting fresh conversation.',
            }),
          }));
        }

        // Build the final prompt with file attachments and optional history
        const finalPrompt = buildFinalPrompt(!shouldResume);

        // Resolve allowed tools: use option override, or read from settings
        let allowedTools: string[] | undefined = optionAllowedTools;
        if (!skipPermissions && !allowedTools) {
          const raw = getSetting('allowed_tools');
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed) && parsed.length > 0) {
                allowedTools = parsed;
              }
            } catch { /* ignore malformed */ }
          }
        }

        // Build CLI args
        const cliArgs = buildCliArgs({
          model,
          resumeSessionId: shouldResume ? sdkSessionId : undefined,
          skipPermissions,
          permissionMode: skipPermissions ? undefined : permissionMode,
          allowedTools: skipPermissions ? undefined : allowedTools,
          systemPrompt,
          thinking,
          effort,
        });

        // Append prompt as positional argument
        cliArgs.push(finalPrompt);

        // Build env — inherit process.env so CLI reads its own settings
        const childEnv = buildCliEnv();

        const workDir = workingDirectory || os.homedir();

        console.log('[claude-client] Spawning Claude CLI:', claudePath, 'args (excluding prompt):', cliArgs.slice(0, -1).join(' '));

        let child: ChildProcess;
        try {
          child = spawn(claudePath, cliArgs, {
            cwd: workDir,
            env: sanitizeEnv(childEnv) as NodeJS.ProcessEnv,
            stdio: 'pipe',
          });
        } catch (spawnErr) {
          throw new Error(`Failed to spawn Claude Code CLI: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`);
        }

        // Close stdin immediately — prompt is passed as CLI arg
        child.stdin?.end();

        registerConversation(sessionId, child);

        // Handle abort — kill child process
        const onAbort = () => {
          if (child.exitCode === null) {
            child.kill('SIGTERM');
          }
        };
        abortController?.signal.addEventListener('abort', onAbort, { once: true });

        // Handle process-level spawn errors (e.g. ENOENT async)
        let spawnError: Error | null = null;
        child.on('error', (err) => {
          spawnError = err;
        });

        // Telegram notification context for hooks
        const telegramOpts = {
          sessionId,
          sessionTitle: undefined as string | undefined,
          workingDirectory,
        };

        // Handle stderr — emit as tool_output
        child.stderr?.on('data', (chunk: Buffer) => {
          const data = chunk.toString();
          console.log(`[stderr] received ${data.length} bytes, first 200 chars:`, data.slice(0, 200).replace(/[\x00-\x1F\x7F]/g, '?'));
          const cleaned = cleanStderr(data);
          if (cleaned) {
            controller.enqueue(formatSSE({
              type: 'tool_output',
              data: cleaned,
            }));
          }
        });

        // Parse NDJSON from stdout
        const rl = readline.createInterface({ input: child.stdout! });
        let tokenUsage: TokenUsage | null = null;
        // Track pending TodoWrite tool_use_ids so we can sync after successful execution
        const pendingTodoWrites = new Map<string, Array<{ content: string; status: string; activeForm?: string }>>();
        // Track tool_progress for timeout detection
        let resumeFailed = false;

        try {
          for await (const line of rl) {
            if (abortController?.signal.aborted) break;

            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(line);
            } catch {
              continue; // skip non-JSON lines
            }

            const msgType = msg.type as string;

            switch (msgType) {
              case 'system': {
                const sysMsg = msg as unknown as CliSystemMessage;
                if (sysMsg.subtype === 'init') {
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify({
                      session_id: sysMsg.session_id,
                      model: sysMsg.model,
                      requested_model: model,
                      tools: sysMsg.tools,
                      mcp_servers: sysMsg.mcp_servers,
                      permission_mode: sysMsg.permission_mode,
                    }),
                  }));
                } else if (sysMsg.subtype === 'status') {
                  // Permission mode changes
                  const statusMsg = msg as { permissionMode?: string };
                  if (statusMsg.permissionMode) {
                    controller.enqueue(formatSSE({
                      type: 'mode_changed',
                      data: statusMsg.permissionMode,
                    }));
                  }
                } else if ((msg as { subtype?: string }).subtype === 'task_notification') {
                  // Agent task completed/failed/stopped
                  const taskMsg = msg as { status: string; summary: string; task_id: string };
                  const title = taskMsg.status === 'completed' ? 'Task completed' : `Task ${taskMsg.status}`;
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify({
                      notification: true,
                      title,
                      message: taskMsg.summary || '',
                    }),
                  }));
                  notifyGeneric(title, taskMsg.summary || '', telegramOpts).catch(() => {});
                }
                break;
              }

              case 'assistant': {
                const assistantMsg = msg as unknown as CliAssistantMessage;
                // Process content blocks from the assistant message
                // Note: with --include-partial-messages, text was already streamed via
                // stream_event/content_block_delta. Skip text blocks here to avoid duplication.
                // Only process tool_use blocks from the complete assistant message.
                if (assistantMsg.message?.content) {
                  for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                      controller.enqueue(formatSSE({
                        type: 'tool_use',
                        data: JSON.stringify({
                          id: block.id,
                          name: block.name,
                          input: block.input,
                        }),
                      }));

                      // Track TodoWrite calls — sync deferred until tool_result confirms success
                      if (block.name === 'TodoWrite') {
                        try {
                          const toolInput = block.input as {
                            todos?: Array<{ content: string; status: string; activeForm?: string }>;
                          };
                          if (toolInput?.todos && Array.isArray(toolInput.todos)) {
                            pendingTodoWrites.set(block.id, toolInput.todos);
                          }
                        } catch (e) {
                          console.warn('[claude-client] Failed to parse TodoWrite input:', e);
                        }
                      }
                    }
                  }
                }
                break;
              }

              case 'user': {
                const userMsg = msg as unknown as CliUserMessage;
                if (userMsg.message?.content && Array.isArray(userMsg.message.content)) {
                  for (const block of userMsg.message.content) {
                    if (block.type === 'tool_result') {
                      const resultContent = typeof block.content === 'string'
                        ? block.content
                        : String(block.content ?? '');
                      controller.enqueue(formatSSE({
                        type: 'tool_result',
                        data: JSON.stringify({
                          tool_use_id: block.tool_use_id,
                          content: resultContent,
                          is_error: block.is_error || false,
                        }),
                      }));

                      // Deferred TodoWrite sync
                      if (!block.is_error && pendingTodoWrites.has(block.tool_use_id)) {
                        const todos = pendingTodoWrites.get(block.tool_use_id)!;
                        pendingTodoWrites.delete(block.tool_use_id);
                        controller.enqueue(formatSSE({
                          type: 'task_update',
                          data: JSON.stringify({
                            session_id: sessionId,
                            todos: todos.map((t, i) => ({
                              id: String(i),
                              content: t.content,
                              status: t.status,
                              activeForm: t.activeForm || '',
                            })),
                          }),
                        }));
                      }
                    }
                  }
                }

                // Emit rewind_point for file checkpointing
                if (
                  (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id === null &&
                  !autoTrigger &&
                  (msg as { uuid?: string }).uuid
                ) {
                  controller.enqueue(formatSSE({
                    type: 'rewind_point',
                    data: JSON.stringify({ userMessageId: (msg as { uuid: string }).uuid }),
                  }));
                }
                break;
              }

              case 'content_block_delta': {
                const delta = (msg as { delta?: { type?: string; text?: string } }).delta;
                if (delta?.type === 'text_delta' && delta.text) {
                  controller.enqueue(formatSSE({ type: 'text', data: delta.text }));
                }
                break;
              }

              case 'stream_event': {
                // --include-partial-messages wraps API events in { type: 'stream_event', event: {...} }
                const innerEvent = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
                if (innerEvent?.type === 'content_block_delta') {
                  const delta = innerEvent.delta;
                  if (delta?.type === 'text_delta' && delta.text) {
                    controller.enqueue(formatSSE({ type: 'text', data: delta.text }));
                  }
                }
                // Other stream_event types (message_start, content_block_start/stop, message_stop) are informational
                break;
              }

              case 'tool_progress': {
                const progressMsg = msg as {
                  tool_use_id?: string;
                  tool_name?: string;
                  elapsed_time_seconds?: number;
                };
                controller.enqueue(formatSSE({
                  type: 'tool_output',
                  data: JSON.stringify({
                    _progress: true,
                    tool_use_id: progressMsg.tool_use_id,
                    tool_name: progressMsg.tool_name,
                    elapsed_time_seconds: progressMsg.elapsed_time_seconds,
                  }),
                }));
                // Auto-timeout: abort if tool runs longer than configured threshold
                if (
                  toolTimeoutSeconds > 0 &&
                  progressMsg.elapsed_time_seconds &&
                  progressMsg.elapsed_time_seconds >= toolTimeoutSeconds
                ) {
                  controller.enqueue(formatSSE({
                    type: 'tool_timeout',
                    data: JSON.stringify({
                      tool_name: progressMsg.tool_name,
                      elapsed_seconds: Math.round(progressMsg.elapsed_time_seconds),
                    }),
                  }));
                  child.kill('SIGTERM');
                }
                break;
              }

              case 'result': {
                const resultMsg = msg as unknown as CliResultMessage;
                // Detect resume failure (old SDK session ID not found by CLI)
                const errors = (msg as { errors?: string[] }).errors;
                if (
                  resultMsg.is_error &&
                  shouldResume &&
                  !isRetry &&
                  errors?.some((e: string) => e.includes('No conversation found'))
                ) {
                  resumeFailed = true;
                  // Clear stale session ID
                  if (sessionId) {
                    try { updateSdkSessionId(sessionId, ''); } catch { /* best effort */ }
                  }
                  break; // Don't emit this error result to the client — we'll retry
                }
                tokenUsage = {
                  input_tokens: resultMsg.usage?.input_tokens || 0,
                  output_tokens: resultMsg.usage?.output_tokens || 0,
                  cache_read_input_tokens: resultMsg.usage?.cache_read_input_tokens || 0,
                  cache_creation_input_tokens: resultMsg.usage?.cache_creation_input_tokens || 0,
                  cost_usd: resultMsg.total_cost_usd,
                };
                controller.enqueue(formatSSE({
                  type: 'result',
                  data: JSON.stringify({
                    subtype: resultMsg.subtype,
                    is_error: resultMsg.is_error,
                    num_turns: resultMsg.num_turns,
                    duration_ms: resultMsg.total_duration_ms,
                    usage: tokenUsage,
                    session_id: resultMsg.session_id,
                  }),
                }));
                // Notify on conversation-level errors
                if (resultMsg.is_error) {
                  const errTitle = 'Conversation error';
                  const errMsg = resultMsg.subtype || 'The conversation ended with an error';
                  controller.enqueue(formatSSE({
                    type: 'status',
                    data: JSON.stringify({ notification: true, title: errTitle, message: errMsg }),
                  }));
                  notifyGeneric(errTitle, errMsg, telegramOpts).catch(() => {});
                }
                break;
              }

              default: {
                if (msgType === 'keep_alive') {
                  controller.enqueue(formatSSE({ type: 'keep_alive', data: '' }));
                }
                break;
              }
            }
          }
        } catch (iterError) {
          // If this was a resume attempt and it failed, retry without resume
          if (shouldResume && !resumeFailed) {
            resumeFailed = true;
            console.warn('[claude-client] Resume may have failed:', iterError);
          }
          // Otherwise this is a genuine stream error
          if (!abortController?.signal.aborted) {
            throw iterError;
          }
        }

        // Wait for process to fully exit
        const exitCode = await new Promise<number | null>((resolve) => {
          if (child.exitCode !== null) {
            resolve(child.exitCode);
          } else {
            child.on('close', (code) => resolve(code));
          }
        });

        // Clean up abort listener
        abortController?.signal.removeEventListener('abort', onAbort);

        // Check for spawn errors
        if (spawnError) {
          throw spawnError;
        }

        // If process exited with error and we haven't consumed any result,
        // treat it as an error
        if (exitCode !== null && exitCode !== 0 && !abortController?.signal.aborted) {
          console.warn(`[claude-client] Claude CLI exited with code ${exitCode}`);
          // If resume failed, retry without resume
          if (resumeFailed && !isRetry) {
            continue; // retry loop
          }
        }

        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
        break; // success — exit retry loop
        } // end retry loop
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Unknown error';
        // Log full error details for debugging
        console.error('[claude-client] Stream error:', {
          message: rawMessage,
          stack: error instanceof Error ? error.stack : undefined,
          code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        });

        let errorMessage = rawMessage;

        // Provide more specific error messages based on error type
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || rawMessage.includes('ENOENT') || rawMessage.includes('spawn')) {
            errorMessage = `Claude Code CLI not found. Please ensure Claude Code is installed and available in your PATH.\n\nOriginal error: ${rawMessage}`;
          } else if (rawMessage.includes('exited with code 1') || rawMessage.includes('exit code 1')) {
            errorMessage = `Claude Code process exited with an error. This is often caused by:\n• Invalid or missing API Key\n• Incorrect Base URL configuration\n• Network connectivity issues\n\nOriginal error: ${rawMessage}`;
          } else if (rawMessage.includes('exited with code')) {
            errorMessage = `Claude Code process crashed unexpectedly.\n\nOriginal error: ${rawMessage}`;
          } else if (code === 'ECONNREFUSED' || rawMessage.includes('ECONNREFUSED') || rawMessage.includes('fetch failed')) {
            errorMessage = `Cannot connect to API endpoint. Please check your network connection and Base URL configuration.\n\nOriginal error: ${rawMessage}`;
          } else if (rawMessage.includes('401') || rawMessage.includes('Unauthorized') || rawMessage.includes('authentication')) {
            errorMessage = `Authentication failed. Please verify your API Key is correct and has not expired.\n\nOriginal error: ${rawMessage}`;
          } else if (rawMessage.includes('403') || rawMessage.includes('Forbidden')) {
            errorMessage = `Access denied. Your API Key may not have permission for this operation.\n\nOriginal error: ${rawMessage}`;
          } else if (rawMessage.includes('429') || rawMessage.includes('rate limit') || rawMessage.includes('Rate limit')) {
            errorMessage = `Rate limit exceeded. Please wait a moment before retrying.\n\nOriginal error: ${rawMessage}`;
          }
        }

        controller.enqueue(formatSSE({ type: 'error', data: errorMessage }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));

        // Always clear sdk_session_id on crash so the next message starts fresh.
        if (sessionId) {
          try {
            updateSdkSessionId(sessionId, '');
            console.warn('[claude-client] Cleared stale sdk_session_id for session', sessionId);
          } catch {
            // best effort
          }
        }

        controller.close();
      } finally {
        unregisterConversation(sessionId);
      }

      /**
       * Build the final prompt with file attachments and optional conversation history.
       * When resuming, the CLI has full context so we send the raw prompt.
       * When NOT resuming, prepend DB history for context.
       */
      function buildFinalPrompt(useHistory: boolean): string {
        const basePrompt = useHistory
          ? buildPromptWithHistory(prompt, conversationHistory)
          : prompt;

        if (!files || files.length === 0) return basePrompt;

        const workDir = workingDirectory || os.homedir();

        // Save all files (images and non-images) to disk and reference in prompt
        const imageFiles = files.filter(f => isImageFile(f.type));
        const nonImageFiles = files.filter(f => !isImageFile(f.type));

        let textPrompt = basePrompt;

        if (nonImageFiles.length > 0) {
          const savedPaths = getUploadedFilePaths(nonImageFiles, workDir);
          const fileReferences = savedPaths
            .map((p, i) => `[User attached file: ${p} (${nonImageFiles[i].name})]`)
            .join('\n');
          textPrompt = `${fileReferences}\n\nPlease read the attached file(s) above using your Read tool, then respond to the user's message:\n\n${basePrompt}`;
        }

        if (imageFiles.length > 0) {
          // In CLI mode, save images to disk and reference in prompt.
          // Claude Code can view images from disk using its Read tool.
          if (!imageAgentMode) {
            const imagePaths = getUploadedFilePaths(imageFiles, workDir);
            const imageReferences = imagePaths
              .map((p, i) => `[User attached image: ${p} (${imageFiles[i].name})]`)
              .join('\n');
            textPrompt = `${imageReferences}\n\n${textPrompt}`;
          } else {
            // In image agent mode, save images and let the agent read them
            const imagePaths = getUploadedFilePaths(imageFiles, workDir);
            const imageReferences = imagePaths
              .map((p, i) => `[User attached image: ${p} (${imageFiles[i].name})]`)
              .join('\n');
            textPrompt = `${imageReferences}\n\n${textPrompt}`;
          }
        }

        return textPrompt;
      }
    },

    cancel() {
      const child = getConversation(sessionId);
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
      }
      abortController?.abort();
    },
  });
}
