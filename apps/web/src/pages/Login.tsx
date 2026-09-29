import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';

// Why a link from the assistant landed here instead of on its page.
const REASONS: Record<string, string> = {
  link_expired: 'That link has expired. Ask your assistant for a new one, or sign in.',
  rate_limited: 'Too many tries from this network. Wait a few minutes, or sign in.',
};

export function Login() {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/inventory';
  const reason = REASONS[params.get('reason') ?? ''];
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authkit, setAuthkit] = useState(false);
  const [signup, setSignup] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    api.authConfig().then(
      (c) => {
        setAuthkit(c.authkit);
        setSignup(c.signup);
        setConfigLoaded(true);
      },
      () => setConfigLoaded(true),
    );
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

  const tokenForm = (
    <form onSubmit={submit}>
      <label>
        Access token
        <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
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
  );

  return (
    <main className="login">
      <h1>
        buttery<span>.</span>
      </h1>
      {reason ? (
        <div className="banner warn" role="status">
          {reason}
        </div>
      ) : (
        <p className="muted">Sign in to review and correct your household's food.</p>
      )}
      {signup && (
        <a className="button primary" href={`/auth/authkit?mode=sign-up&next=${encodeURIComponent(next)}`}>
          Create your household
        </a>
      )}
      {authkit && (
        <a className={signup ? 'button' : 'button primary'} href={`/auth/authkit?next=${encodeURIComponent(next)}`}>
          Continue with your account
        </a>
      )}
      {configLoaded &&
        (authkit ? (
          <details className="token-login">
            <summary>Sign in with an access token instead</summary>
            {tokenForm}
          </details>
        ) : (
          tokenForm
        ))}
    </main>
  );
}
