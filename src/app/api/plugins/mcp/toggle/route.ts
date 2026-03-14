import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, serverName, enabled } = await request.json();

    if (!sessionId || !serverName || typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'sessionId, serverName, and enabled (boolean) are required' }, { status: 400 });
    }

    // MCP server toggling requires SDK Query methods not available in CLI mode.
    // MCP servers are managed by Claude Code's own config (~/.claude/settings.json).
    return NextResponse.json({
      success: false,
      error: 'MCP server toggling is not supported in CLI mode. Edit ~/.claude/settings.json to configure MCP servers.',
    });
  } catch (error) {
    console.error('[mcp/toggle] Failed to toggle MCP server:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
