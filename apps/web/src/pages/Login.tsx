import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';

export function Login() {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/inventory';
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authkit, setAuthkit] = useState(false);

  useEffect(() => {
    api.authConfig().then((c) => setAuthkit(c.authkit), () => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.tokenLogin(token, next);
      window.location.assign(r.next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>Buttery</h1>
      <p className="muted">Sign in to review and correct your household's food.</p>
      {authkit && (
        <a className="button primary" href={`/auth/authkit?next=${encodeURIComponent(next)}`}>
          Continue with your account
        </a>
      )}
      <form onSubmit={submit}>
        <label>
          Access token
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="btr_…" required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className={authkit ? '' : 'primary'} disabled={busy}>
          Sign in
        </button>
      </form>
      <p className="muted small">
        Create a token with <code>npm run token:create</code>.
      </p>
    </main>
  );
}
