// Mocked HTTP layer: a fetch that plays back chat-completion responses in order and
// records every request body, so tests exercise the real OpenAI client and engine.

export type Reply =
  | { content: string; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { status: number; error: string }
  | { hang: true }
  | { networkError: string };

export interface MockFetch {
  fetch: typeof fetch;
  requests: { url: string; headers: Headers; body: any }[];
}

export function json(value: unknown): Reply {
  return { content: JSON.stringify(value) };
}

export function mockFetch(replies: Reply[]): MockFetch {
  const queue = [...replies];
  const requests: MockFetch['requests'] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
    const reply = queue.shift();
    if (!reply) throw new Error('mockFetch: no reply queued');
    if ('hang' in reply) {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
      });
    }
    if ('networkError' in reply) throw new TypeError(reply.networkError);
    if ('status' in reply) {
      return new Response(JSON.stringify({ error: { message: reply.error } }), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: reply.content }, finish_reason: 'stop' }],
        usage: { ...(reply.usage ?? { prompt_tokens: 100, completion_tokens: 20 }), total_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch: fetchImpl as typeof fetch, requests };
}

export const FIXED_NOW = () => new Date('2026-09-29T12:00:00.000Z');
