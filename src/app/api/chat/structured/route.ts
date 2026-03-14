import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import readline from 'readline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt, outputFormat, options } = body;

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    // Validate outputFormat: must be { type: 'json_schema', schema: { ... } }
    if (
      !outputFormat ||
      typeof outputFormat !== 'object' ||
      outputFormat.type !== 'json_schema' ||
      !outputFormat.schema ||
      typeof outputFormat.schema !== 'object'
    ) {
      return NextResponse.json(
        { error: 'outputFormat must be { type: "json_schema", schema: { ... } }' },
        { status: 400 },
      );
    }

    // Build a system prompt that instructs Claude to output valid JSON matching the schema
    const schemaStr = JSON.stringify(outputFormat.schema, null, 2);
    const structuredPrompt = `${prompt}\n\nIMPORTANT: You MUST respond with ONLY a valid JSON object matching this JSON schema. No markdown, no explanation, just the JSON.\n\nSchema:\n${schemaStr}`;

    // Build CLI args
    const args = ['--print', structuredPrompt, '--output-format', 'stream-json', '--verbose'];
    if (options?.model) {
      args.push('--model', options.model);
    }

    const child = spawn('claude', args, {
      cwd: options?.cwd || process.cwd(),
      env: process.env as NodeJS.ProcessEnv,
      stdio: 'pipe',
    });

    let resultText = '';

    const rl = readline.createInterface({ input: child.stdout! });

    await new Promise<void>((resolve, reject) => {
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant') {
            // Extract text from assistant message content blocks
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  resultText += block.text;
                }
              }
            }
          } else if (msg.type === 'result' && msg.subtype === 'success') {
            if (msg.result) {
              resultText = msg.result;
            }
          }
        } catch {
          // Skip non-JSON lines
        }
      });

      child.on('error', reject);
      child.on('close', (code) => {
        rl.close();
        if (code !== 0 && !resultText) {
          reject(new Error(`CLI exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });

    // Try to parse the result as JSON
    if (resultText) {
      // Strip markdown code fences if present
      let cleaned = resultText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      try {
        const parsed = JSON.parse(cleaned);
        return NextResponse.json({ result: parsed });
      } catch {
        return NextResponse.json({ result: resultText });
      }
    }

    return NextResponse.json({ result: null });
  } catch (error) {
    console.error('[structured] Structured query failed:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
