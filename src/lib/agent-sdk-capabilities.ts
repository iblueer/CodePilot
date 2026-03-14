/**
 * Agent SDK Capabilities Cache — simplified for CLI mode.
 *
 * In CLI mode, we don't have SDK Query instances to query for models,
 * commands, account info, etc. Instead we provide a simplified cache
 * that stores information received from CLI init messages.
 */

// ==========================================
// Cache structure
// ==========================================

interface ModelInfo {
  id: string;
  name: string;
  provider?: string;
}

interface SlashCommand {
  name: string;
  description?: string;
}

interface AccountInfo {
  account_name?: string;
  plan?: string;
}

interface McpServerStatus {
  name: string;
  status: string;
}

interface ProviderCapabilityCache {
  models: ModelInfo[];
  commands: SlashCommand[];
  account: AccountInfo | null;
  mcpStatus: McpServerStatus[];
  loadedPlugins: Array<{ name: string; path: string }>;
  capturedAt: number;
  sessionId: string;
}

const GLOBAL_KEY = '__agentSdkCapabilities__' as const;

/** Returns the per-provider cache Map. */
function getCacheMap(): Map<string, ProviderCapabilityCache> {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, ProviderCapabilityCache>();
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, ProviderCapabilityCache>;
}

function getOrCreateCache(providerId: string): ProviderCapabilityCache {
  const map = getCacheMap();
  let cache = map.get(providerId);
  if (!cache) {
    cache = {
      models: [],
      commands: [],
      account: null,
      mcpStatus: [],
      loadedPlugins: [],
      capturedAt: 0,
      sessionId: '',
    };
    map.set(providerId, cache);
  }
  return cache;
}

// ==========================================
// Capture (no-op in CLI mode)
// ==========================================

/**
 * Capture capabilities — no-op in CLI mode since we don't have
 * SDK Query instances. The init message from the CLI provides
 * limited info (model, tools, mcp_servers) which is captured
 * directly in the stream handler.
 */
export async function captureCapabilities(
  _sessionId: string,
  _conversation: unknown,
  _providerId: string = 'env',
): Promise<void> {
  // No-op in CLI mode
}

// ==========================================
// Read cached data (scoped by provider)
// ==========================================

export function getCachedModels(providerId: string = 'env'): ModelInfo[] {
  return getOrCreateCache(providerId).models;
}

export function getCachedCommands(providerId: string = 'env'): SlashCommand[] {
  return getOrCreateCache(providerId).commands;
}

export function getCachedAccountInfo(providerId: string = 'env'): AccountInfo | null {
  return getOrCreateCache(providerId).account;
}

export function getCachedMcpStatus(providerId: string = 'env'): McpServerStatus[] {
  return getOrCreateCache(providerId).mcpStatus;
}

export function getCachedPlugins(providerId: string = 'env'): Array<{ name: string; path: string }> {
  return getOrCreateCache(providerId).loadedPlugins;
}

export function setCachedPlugins(providerId: string, plugins: Array<{ name: string; path: string }>): void {
  const cache = getOrCreateCache(providerId);
  cache.loadedPlugins = plugins;
}

export function getCapabilityCacheAge(providerId: string = 'env'): number {
  const { capturedAt } = getOrCreateCache(providerId);
  return capturedAt === 0 ? Infinity : Date.now() - capturedAt;
}

// ==========================================
// Refresh (no-op in CLI mode)
// ==========================================

/**
 * Refresh MCP server status — returns cached data in CLI mode
 * since we can't query the child process mid-conversation.
 */
export async function refreshMcpStatus(_sessionId: string, providerId: string = 'env'): Promise<McpServerStatus[]> {
  return getOrCreateCache(providerId).mcpStatus;
}
