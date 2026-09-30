import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api';

// Why someone landed here instead of on the page they wanted.
const REASONS: Record<string, string> = {
  outside_link: 'That link only opens the page your assistant shared. Sign in to see the rest.',
  link_expired: 'That link has expired. Ask your assistant for a new one, or sign in.',
  rate_limited: 'Too many tries from this network. Wait a few minutes, or sign in.',
};

/** Account sign-in only. Tokens are for agents and CLIs; people reach single pages through their assistant's links. */
export function Login() {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/inventory';
  const reason = REASONS[params.get('reason') ?? ''];
  const [config, setConfig] = useState<{ authkit: boolean; signup: boolean } | null>(null);

  useEffect(() => {
    api.authConfig().then(setConfig, () => setConfig({ authkit: false, signup: false }));
  }, []);

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
      {config?.authkit && (
        <a className="button primary" href={`/auth/authkit?next=${encodeURIComponent(next)}`}>
          Continue with your account
        </a>
      )}
      {config?.signup && (
        <a className="button" href={`/auth/authkit?mode=sign-up&next=${encodeURIComponent(next)}`}>
          Create your household
        </a>
      )}
      {config && !config.authkit && (
        <p className="muted" data-testid="no-account-sign-in">
          Account sign-in isn't set up on this server. Ask your assistant for a link to the page you need.
        </p>
      )}
    </main>
  );
}
