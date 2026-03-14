import type { ChildProcess } from 'child_process';

const globalKey = '__activeConversations__' as const;

function getMap(): Map<string, ChildProcess> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, ChildProcess>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, ChildProcess>;
}

export function registerConversation(sessionId: string, conversation: ChildProcess): void {
  getMap().set(sessionId, conversation);
}

export function unregisterConversation(sessionId: string): void {
  getMap().delete(sessionId);
}

export function getConversation(sessionId: string): ChildProcess | undefined {
  return getMap().get(sessionId);
}
