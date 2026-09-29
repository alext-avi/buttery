import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';

const REASONS: Record<string, string> = {
  expired: 'That sign-in link has expired or was already used. Ask your assistant for a new one.',
  rate_limited: 'Too many tries. Wait a few minutes and try again.',
};

export function Login() {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/inventory';
  const reason = REASONS[params.get('reason') ?? ''];
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authkit, setAuthkit] = useState(false);
  const [signup, setSignup] = useState(false);

  useEffect(() => {
    api.authConfig().then(
      (c) => {
        setAuthkit(c.authkit);
        setSignup(c.signup);
      },
      () => {},
    );
  }, []);

  function signIn(call: () => Promise<{ next: string }>, setError: (m: string | null) => void) {
    return async (e: FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        window.location.assign((await call()).next);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not sign in');
        setBusy(false);
      }
    };
  }

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

      <form onSubmit={signIn(() => api.codeLogin(code, next), setCodeError)}>
        <label>
          Enter the code from your assistant
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            autoCorrect="off"
            spellCheck={false}
            maxLength={12}
            required
          />
        </label>
        {codeError && (
          <p className="error" role="alert">
            {codeError}
          </p>
        )}
        <button className="primary" disabled={busy}>
          Sign in
        </button>
        <p className="muted small">Ask Claude, or whichever assistant you use with Buttery, for a sign-in code.</p>
      </form>

      {authkit && (
        <a className="button" href={`/auth/authkit?next=${encodeURIComponent(next)}`}>
          Continue with your account
        </a>
      )}
      {signup && (
        <a className="button" href={`/auth/authkit?mode=sign-up&next=${encodeURIComponent(next)}`}>
          Create your household
        </a>
      )}
      <details className="token-login">
        <summary>Use a token instead</summary>
        <form onSubmit={signIn(() => api.tokenLogin(token, next), setTokenError)}>
          <label>
            Access token
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
          </label>
          {tokenError && (
            <p className="error" role="alert">
              {tokenError}
            </p>
          )}
          <button disabled={busy}>Sign in with token</button>
        </form>
      </details>
    </main>
  );
}
