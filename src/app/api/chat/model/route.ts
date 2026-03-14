import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, model } = await request.json();

    if (!sessionId || !model) {
      return NextResponse.json({ error: 'sessionId and model are required' }, { status: 400 });
    }

    // In CLI mode, model is set per-invocation via --model flag.
    // Mid-conversation model changes are not supported — the model will take
    // effect on the next message. Return success so the UI state updates accordingly.
    return NextResponse.json({ applied: true });
  } catch (error) {
    console.error('[model] Failed to set model:', error);
    return NextResponse.json({ applied: false, error: String(error) });
  }
}
