import { toAppError } from '../errors';

export function toolResult(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function toolError(err: unknown) {
  const e = toAppError(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message, details: e.details }) }],
  };
}

export function withErrors<A>(fn: (args: A) => Promise<object>) {
  return async (args: A) => {
    try {
      return toolResult((await fn(args)) as Record<string, unknown>);
    } catch (err) {
      return toolError(err);
    }
  };
}
