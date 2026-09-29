import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { when } from '../format';
import type { NewToken } from '../types';
import { useLoad } from '../useLoad';

export function Settings() {
  const [params] = useSearchParams();
  const welcome = params.get('welcome') === '1';
  const me = useLoad(() => api.me(), []);
  const tokens = useLoad(() => api.tokens(), []);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [agentName, setAgentName] = useState('Claude Code');
  const [created, setCreated] = useState<NewToken | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me.data) return;
    setName(me.data.household.name);
    setTimezone(welcome ? Intl.DateTimeFormat().resolvedOptions().timeZone : me.data.household.timezone);
  }, [me.data, welcome]);

  if (me.error) return <ErrorBox error={me.error} />;
  if (!me.data || !tokens.data) return <p className="muted">Loading…</p>;
  const mcpUrl = tokens.data.mcp_url;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }
  const saveHousehold = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      me.setData(await api.updateHousehold({ name, timezone }));
      setMessage('Saved.');
    });
  };
  const createToken = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setCreated(await api.createToken(agentName));
      tokens.reload();
    });
  };
  const revoke = (id: string) =>
    run(async () => {
      await api.revokeToken(id);
      if (created?.connection_id === id) setCreated(null);
      tokens.reload();
    });

  return (
    <div>
      <header>
        {welcome ? (
          <>
            <h1>Your household is ready</h1>
            <p className="muted">Name it, check the timezone, then connect an agent. You'll mostly use Buttery by talking to Claude, Codex or another assistant.</p>
          </>
        ) : (
          <h1>Settings</h1>
        )}
      </header>
      {message && (
        <div className="banner" role="status">
          {message}
        </div>
      )}

      <h2>Household</h2>
      <form className="card edit" onSubmit={saveHousehold}>
        <label>
          Household name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Timezone (used for expiry dates)
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>
            Save household
          </button>
        </div>
      </form>

      <h2>Connect Claude (web, desktop, phone)</h2>
      <div className="card">
        <p>
          In Claude, open Settings → Connectors → Add custom connector, and paste:
        </p>
        <div className="raw">{mcpUrl}</div>
        <p className="muted small">Sign in with this same account when Claude asks.</p>
      </div>

      <h2>Connect a command-line agent</h2>
      <form className="card edit" onSubmit={createToken}>
        <label>
          Agent name
          <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Claude Code, Codex, agentdock…" required />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>
            Create token
          </button>
        </div>
      </form>
      {created && (
        <div className="card" data-testid="new-token">
          <p>
            <strong>Copy this token now</strong>. It won't be shown again.
          </p>
          <div className="raw" data-testid="token-value">
            {created.token}
          </div>
          <p className="muted small">Claude Code:</p>
          <div className="raw">{`claude mcp add --transport http buttery ${created.mcp_url} --header "Authorization: Bearer ${created.token}"`}</div>
        </div>
      )}

      <h2>Active tokens</h2>
      {tokens.data.tokens.length === 0 ? (
        <p className="muted">No tokens yet.</p>
      ) : (
        <ul className="cards">
          {tokens.data.tokens.map((t) => (
            <li key={t.connection_id} className="card" data-testid="token-row">
              <div className="title-row">
                <strong>{t.client_name}</strong>
                <span className="badge">{t.token_prefix}…</span>
              </div>
              <div className="meta">
                Created {when(t.created_at)} · {t.last_used_at ? `last used ${when(t.last_used_at)}` : 'never used'}
              </div>
              <div className="actions">
                <button onClick={() => revoke(t.connection_id)} disabled={busy}>
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
