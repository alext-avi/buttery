import { useState } from 'react';
import { useLocation } from 'react-router';
import { api, ApiError } from '../api';

const MESSAGES = {
  expired: 'This link has expired or was already used. Ask your assistant for a new one.',
  rate_limited: 'Too many tries. Wait a few minutes and try again.',
};

/**
 * The one-tap screen for a link an agent shared. The code is spent only when the person taps Open,
 * so a chat app's link preview can't use it up. Opening grants this page only; it doesn't sign them in.
 */
export function OpenLink({ code }: { code: string }) {
  const { pathname } = useLocation();
  const what = pathname.startsWith('/review/') ? 'this receipt' : pathname.startsWith('/items/') ? 'this item' : pathname === '/inventory' ? 'your inventory' : 'this page';
  const [state, setState] = useState<'idle' | 'busy' | keyof typeof MESSAGES>('idle');

  async function open() {
    setState('busy');
    try {
      window.location.replace((await api.openLink(code)).next);
    } catch (e) {
      setState(e instanceof ApiError && e.status === 429 ? 'rate_limited' : 'expired');
    }
  }

  const failed = state === 'expired' || state === 'rate_limited';
  return (
    <section className="open-link">
      <p className="eyebrow">From your assistant</p>
      <h1>Open {what}</h1>
      {failed ? (
        <div className="banner warn" role="alert">
          {MESSAGES[state]}
        </div>
      ) : (
        <p className="muted">This link opens just this page. It doesn't sign you in.</p>
      )}
      {state === 'expired' ? (
        <a className="button" href={`/login?next=${encodeURIComponent(pathname)}`}>
          Sign in instead
        </a>
      ) : (
        <button className="primary" onClick={open} disabled={state === 'busy'}>
          {state === 'busy' ? 'Opening…' : 'Open'}
        </button>
      )}
    </section>
  );
}
