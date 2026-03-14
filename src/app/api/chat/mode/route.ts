import { NextRequest, NextResponse } from 'next/server';
import type { PermissionMode } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, mode } = await request.json();

    if (!sessionId || !mode) {
      return NextResponse.json({ error: 'sessionId and mode are required' }, { status: 400 });
    }

    // In CLI mode, permission mode is set per-invocation via --permission-mode flag.
    // Mid-conversation mode changes are not supported — the mode will take effect
    // on the next message. Return success so the UI state updates accordingly.
    const _permissionMode: PermissionMode = mode === 'code' ? 'acceptEdits' : 'plan';
    return NextResponse.json({ applied: true });
  } catch (error) {
    console.error('[mode] Failed to switch mode:', error);
    return NextResponse.json({ applied: false, error: String(error) });
  }
}
