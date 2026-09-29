import OpenAI from 'openai';
import type { ReasoningFunction } from './types.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  fn: ReasoningFunction;
  model: string;
  messages: ChatMessage[];
  /** JSON Schema for the expected output (from the Zod output schema). */
  jsonSchema: Record<string, unknown>;
  signal: AbortSignal;
}

export interface CompletionResponse {
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** One model round trip. The engine owns validation, repair, timeouts and fallback. */
export interface Completer {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

const MAX_TOKENS: Record<ReasoningFunction, number> = {
  canonicalizeItems: 4096,
  estimateShelfLife: 1024,
  parseActivity: 1536,
  rankRecipes: 2048,
};

type ResponseMode = 'json_schema' | 'json_object';

export interface CrusoeCompleterOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

/**
 * OpenAI-compatible chat completions against Crusoe Managed Inference.
 * Uses `response_format: json_schema` (Crusoe serves every model with guided decoding). If a model
 * rejects it with a 400, that model is downgraded to `json_object` for the life of the process and
 * the schema is put in the prompt instead.
 */
export function createCrusoeCompleter(options: CrusoeCompleterOptions): Completer {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const modes = new Map<string, ResponseMode>();

  async function send(req: CompletionRequest, mode: ResponseMode): Promise<CompletionResponse> {
    const messages =
      mode === 'json_schema'
        ? req.messages
        : [
            ...req.messages.slice(0, 1).map((m) => ({
              ...m,
              content: `${m.content}\n\nJSON Schema for your response:\n${JSON.stringify(req.jsonSchema)}`,
            })),
            ...req.messages.slice(1),
          ];
    const completion = await client.chat.completions.create(
      {
        model: req.model,
        messages,
        temperature: 0,
        max_tokens: MAX_TOKENS[req.fn],
        response_format:
          mode === 'json_schema'
            ? { type: 'json_schema', json_schema: { name: req.fn, schema: req.jsonSchema } }
            : { type: 'json_object' },
      },
      { signal: req.signal },
    );
    return {
      content: completion.choices[0]?.message?.content ?? '',
      tokensIn: completion.usage?.prompt_tokens ?? null,
      tokensOut: completion.usage?.completion_tokens ?? null,
    };
  }

  return {
    async complete(req) {
      const mode = modes.get(req.model) ?? 'json_schema';
      try {
        return await send(req, mode);
      } catch (error) {
        if (mode === 'json_schema' && isResponseFormatRejection(error)) {
          modes.set(req.model, 'json_object');
          return send(req, 'json_object');
        }
        throw error;
      }
    },
  };
}

function isResponseFormatRejection(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || error.status !== 400) return false;
  return /response_format|json_schema|schema|guided/i.test(error.message);
}
