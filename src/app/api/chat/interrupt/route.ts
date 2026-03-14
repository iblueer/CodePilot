import { NextRequest, NextResponse } from 'next/server';
import { getConversation } from '@/lib/conversation-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const conversation = getConversation(sessionId);
    if (!conversation) {
      return NextResponse.json({ interrupted: false });
    }

    // In CLI mode, send SIGINT to the child process to interrupt it
    conversation.kill('SIGINT');

    return NextResponse.json({ interrupted: true });
  } catch (error) {
    console.error('[interrupt] Failed to interrupt:', error);
    return NextResponse.json({ interrupted: false, error: String(error) });
  }
}
