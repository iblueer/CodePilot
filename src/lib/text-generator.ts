import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { resolveProvider as resolveProviderUnified, toAiSdkConfig } from './provider-resolver';

export interface StreamTextParams {
  providerId: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

/**
 * Stream text from the user's current provider.
 * Returns an async iterable of text chunks.
 *
 * Provider resolution is fully delegated to the unified resolver.
 * No fallback logic here — the resolver's chain (explicit → session → global default → env)
 * is the single source of truth, matching the Claude Code SDK path.
 */
export async function* streamTextFromProvider(params: StreamTextParams): AsyncIterable<string> {
  const resolved = resolveProviderUnified({ providerId: params.providerId });

  if (!resolved.hasCredentials && !resolved.provider) {
    throw new Error('No text generation provider available. Please configure a provider in Settings.');
  }

  const config = toAiSdkConfig(resolved, params.model);

  // Inject process env if needed (bedrock/vertex)
  for (const [k, v] of Object.entries(config.processEnvInjections)) {
    process.env[k] = v;
  }

  // Build headers object for SDK clients (only if non-empty)
  const hasHeaders = config.headers && Object.keys(config.headers).length > 0;

  let model;
  switch (config.sdkType) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = anthropic(config.modelId);
      break;
    }
    case 'openai': {
      const openai = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = openai(config.modelId);
      break;
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = google(config.modelId);
      break;
    }
    case 'bedrock': {
      // Auth via process.env (AWS_REGION, AWS_ACCESS_KEY_ID, etc.) — already injected above
      const bedrock = createAmazonBedrock({
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = bedrock(config.modelId);
      break;
    }
    case 'vertex': {
      // Anthropic-on-Vertex: auth via process.env (CLOUD_ML_REGION, GOOGLE_APPLICATION_CREDENTIALS, etc.)
      const vertex = createVertexAnthropic({
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      model = vertex(config.modelId);
      break;
    }
  }

  const result = streamText({
    model: model!,
    system: params.system,
    prompt: params.prompt,
    maxOutputTokens: params.maxTokens || 4096,
    abortSignal: params.abortSignal || AbortSignal.timeout(120_000),
  });

  for await (const chunk of result.textStream) {
    yield chunk;
  }
}

/**
 * Generate complete text (non-streaming) from the user's current provider.
 * Useful when you need the full response as a string.
 */
export async function generateTextFromProvider(params: StreamTextParams): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of streamTextFromProvider(params)) {
    chunks.push(chunk);
  }
  return chunks.join('');
}
