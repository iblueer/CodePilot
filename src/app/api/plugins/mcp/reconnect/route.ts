import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, serverName } = await request.json();

    if (!sessionId || !serverName) {
      return NextResponse.json({ error: 'sessionId and serverName are required' }, { status: 400 });
    }

    // MCP server reconnection requires SDK Query methods not available in CLI mode.
    // MCP servers are managed by Claude Code's own config (~/.claude/settings.json).
    return NextResponse.json({
      success: false,
      error: 'MCP server reconnection is not supported in CLI mode. Restart the session to reconnect.',
    });
  } catch (error) {
    console.error('[mcp/reconnect] Failed to reconnect MCP server:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
