/**
 * Agent SDK Agents Registry — simplified for CLI mode.
 *
 * In CLI mode, agent definitions cannot be injected into the subprocess.
 * This module provides a no-op registry to maintain API compatibility
 * with code that references it.
 */

interface AgentDefinition {
  description: string;
  prompt?: string;
  tools?: string[];
  disallowedTools?: string[];
}

const GLOBAL_KEY = '__agentSdkAgents__' as const;

function getRegistry(): Map<string, AgentDefinition> {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, AgentDefinition>();
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, AgentDefinition>;
}

export function registerAgent(name: string, definition: AgentDefinition): void {
  getRegistry().set(name, definition);
}

export function unregisterAgent(name: string): void {
  getRegistry().delete(name);
}

export function getRegisteredAgents(): Record<string, AgentDefinition> {
  const result: Record<string, AgentDefinition> = {};
  for (const [name, def] of getRegistry()) {
    result[name] = def;
  }
  return result;
}

export function getAgent(name: string): AgentDefinition | undefined {
  return getRegistry().get(name);
}

export function hasRegisteredAgents(): boolean {
  return getRegistry().size > 0;
}
