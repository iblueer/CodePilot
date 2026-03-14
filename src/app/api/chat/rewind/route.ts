import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, userMessageId } = await request.json();

    if (!sessionId || !userMessageId) {
      return NextResponse.json({ error: 'sessionId and userMessageId are required' }, { status: 400 });
    }

    // File rewind requires SDK Query.rewindFiles() which is not available in CLI mode.
    // Return a not-supported response.
    return NextResponse.json({
      canRewind: false,
      error: 'File rewind is not supported in CLI mode',
    });
  } catch (error) {
    console.error('[rewind] Failed to rewind:', error);
    return NextResponse.json({ canRewind: false, error: String(error) });
  }
}
