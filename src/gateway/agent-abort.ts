import {
  abortChatRunsForSessionKey,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "./chat-abort.js";

export function isAgentAbortCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.toLowerCase() === "/abort") {
    return true;
  }
  return isChatStopCommandText(trimmed);
}

export type AgentAbortControllerParams = {
  runId: string;
  sessionId: string;
  sessionKey: string;
  timeoutMs: number;
};

export function createAgentAbortController(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
  params: AgentAbortControllerParams,
): { controller: AbortController; signal: AbortSignal } {
  const { runId, sessionId, sessionKey, timeoutMs } = params;
  const now = Date.now();
  const controller = new AbortController();

  chatAbortControllers.set(runId, {
    controller,
    sessionId,
    sessionKey,
    startedAtMs: now,
    expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
  });

  return { controller, signal: controller.signal };
}

export function cleanupAgentAbortController(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
  runId: string,
): void {
  chatAbortControllers.delete(runId);
}

export type HandleAgentAbortParams = {
  sessionKey: string;
  ops: ChatAbortOps;
  stopReason?: string;
};

export type HandleAgentAbortResult = {
  aborted: boolean;
  runIds: string[];
};

export function handleAgentAbort(params: HandleAgentAbortParams): HandleAgentAbortResult {
  const { sessionKey, ops, stopReason } = params;
  return abortChatRunsForSessionKey(ops, {
    sessionKey,
    stopReason: stopReason ?? "abort-command",
  });
}
