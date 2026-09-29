import type { Decision, InventoryResponse, ItemResponse, Me, NewToken, ProposalView, ResolveResponse, TokenRow, UndoResponse } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach Buttery. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path.startsWith('/api/')) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText, data.details);
  return data as T;
}

export type ItemActivityKind = 'used' | 'finished' | 'discarded' | 'froze' | 'thawed' | 'opened' | 'moved';

export const newKey = () => crypto.randomUUID();

export const api = {
  authConfig: () => request<{ authkit: boolean; signup: boolean }>('GET', '/auth/config'),
  tokenLogin: (token: string, next: string) => request<{ ok: true; next: string }>('POST', '/auth/token-login', { token, next }),
  proposal: (id: string) => request<ProposalView>('GET', `/api/proposals/${id}`),
  resolve: (id: string, body: { decisions: Decision[]; accept_remaining: boolean; apply: boolean; idempotency_key: string; confirm_possible_duplicate?: boolean }) =>
    request<ResolveResponse>('POST', `/api/proposals/${id}/resolve`, body),
  inventory: (location?: string) => request<InventoryResponse>('GET', `/api/inventory${location ? `?location=${encodeURIComponent(location)}` : ''}`),
  item: (id: string) => request<ItemResponse>('GET', `/api/items/${id}`),
  itemActivity: (id: string, body: { kind: ItemActivityKind; fraction?: number; to_location?: string; idempotency_key: string }) =>
    request<{ change_set_id: string | null; applied: Array<{ kind: string; summary: string }>; unresolved: Array<{ reason: string }> }>('POST', `/api/items/${id}/activity`, body),
  undo: (changeSetId: string, key: string) => request<UndoResponse>('POST', `/api/change-sets/${changeSetId}/undo`, { idempotency_key: key }),
  me: () => request<Me>('GET', '/api/me'),
  updateHousehold: (body: { name?: string; timezone?: string }) => request<Me>('POST', '/api/household', body),
  tokens: () => request<{ tokens: TokenRow[]; mcp_url: string }>('GET', '/api/tokens'),
  createToken: (client_name: string) => request<NewToken>('POST', '/api/tokens', { client_name }),
  revokeToken: (id: string) => request<{ ok: true }>('POST', `/api/tokens/${id}/revoke`, {}),
};
