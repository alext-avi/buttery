# Agent-minted login codes

Implements [alext-avi/buttery#2](https://github.com/alext-avi/buttery/issues/2), with one change agreed on 2026-09-29: instead of the server
rewriting every link in MCP responses into `/l/<code>?to=…`, the agent mints one code and appends it as a `login` URL parameter to any
Buttery page link. The same code is what a person types on another device.

## Goal

Nobody signs in to the web app by pasting a `btr_` token. The agent is already authenticated, so it vouches for the person: every link it
hands over signs the browser in, and for another device it hands over a short code to type.

Success looks like: tap a review link from Claude on a phone that has never used Buttery, and land on that review, signed in, with a clean
URL.

## How it works

1. The agent calls the MCP tool `get_login_code`. The server mints a code such as `Q7X4-KM9P` tied to the calling connection.
2. The agent appends `login=Q7X4-KM9P` to every Buttery page link in that message (`?login=` or `&login=`).
3. A browser opens `https://…/review/abc?login=Q7X4-KM9P`. Before the page is served, a middleware redeems the code, sets the normal
   session cookie, strips the parameter and redirects to `https://…/review/abc`.
4. On another device, the person opens `/login` and types the code into the code box.

AuthKit sign-in, self-serve sign-up and token paste stay as fallbacks.

## Data model

### `login_codes` (new table)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `code_hash` | text unique not null | HMAC-SHA-256 of the normalized code, keyed by `SESSION_SECRET` |
| `household_id` | uuid not null → households | |
| `user_id` | uuid not null → users | |
| `connection_id` | uuid not null → connections | The MCP connection that minted it |
| `uses` | int not null default 0 | |
| `max_uses` | int not null default 3 | |
| `expires_at` | timestamptz not null | |
| `created_at` | timestamptz not null default now() | |

HMAC rather than plain SHA-256 because the code is short: a leaked table of plain hashes could be brute-forced offline. The ticket's
"stored as hashes" still holds.

### `connections.parent_connection_id` (new nullable column → connections)

A web connection created by redeeming a code, or by pasting a token, records the connection that vouched for it. A code redemption
reuses one web connection per `(user, household, parent)`, named `Web (link from <parent client name>)`. Token paste uses
`Web (token for <client name>)` with the PAT as parent. AuthKit sign-in keeps today's parentless `Web` connection.

### Revocation

Nothing is cascaded by writes. Checks happen at use time:

- **Redeeming a code** requires its minting connection to be unrevoked.
- **Resolving a session** (`principalFromSession`) requires the session's connection and, if set, its parent to be unrevoked.

So revoking a token immediately kills its unused codes and every browser session created from them or from pasting it. This also fixes
deferred minor M7 (token-paste sessions surviving revocation).

## Codes

- **Format.** 8 characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789` (no 0/O, 1/I/L, U), shown as `XXXX-XXXX`. About 6.6 × 10¹¹
  possibilities. Input is normalized: uppercase, dashes and spaces removed.
- **Lifetime.** `LOGIN_CODE_TTL_MINUTES`, default 10.
- **Uses.** Up to 3, because chat apps' link previews can fetch a link before the person taps it.
- **Redemption.** One atomic statement:
  `UPDATE login_codes SET uses = uses + 1 WHERE code_hash = $1 AND uses < max_uses AND expires_at > now() RETURNING …`,
  joined to an unrevoked minting connection. Concurrent taps cannot exceed the limit.
- **Already signed in.** If the request already has a valid session for the same user and household as the code, the parameter is
  stripped and no use is spent. One code can therefore go on every link in a message.
- **Stale code, already signed in.** An invalid or expired code in a browser that already has a valid session is stripped and the page
  opens, so an old link in the chat doesn't bounce anyone to the login screen. The failure still counts toward the rate limit.
- **Other household.** A code for household A in a browser signed in to household B spends a use and replaces the session with A. The code
  only ever grants its own household.

## Where the code is redeemed

### `login` parameter middleware

It runs on `GET` requests for web pages only: every path except `/api`, `/auth/`, `/mcp`, `/.well-known`, `/healthz` (the existing `RESERVED` list in `http/web.ts`) and the static `/assets`.


- **Valid code:** set the session cookie, then `302` to the same path and query with `login` removed.
- **Invalid, expired or used-up code:** `302` to `/login?reason=expired&next=<same path and query without login>`.
- **Rate-limited:** `302` to `/login?reason=rate_limited&next=…`.
- **Redirect targets:** every target goes through the existing `safeNext`.
- **Never JSON:** it always answers with a redirect.

### `POST /auth/code-login`

For the typed code: `{ code, next? }`, then `{ ok, next }`, or `401 invalid_code` / `429 rate_limited`. Same redemption and rate limit.

### Rate limit

Failed redemptions are limited to 10 per client IP per 10 minutes, shared by both entry points. Successful ones don't count.

- **Storage.** It is in memory, which is fine for today's single instance. Running more than one instance would need a shared store; the
  spec notes this rather than building it.
- **Client IP.** It comes from the socket, and with `TRUST_PROXY=true` (needed behind the Caddy proxy on the Vultr demo) the last `X-Forwarded-For` entry is used:
  the one the trusted proxy appended. Earlier entries can be forged by the client.

### Leak hygiene

- The redirect happens before any page renders, so no script or `Referer` sees the code.
- There is no request logger today. Any logger added later must mask the `login` parameter.

## MCP

### `get_login_code` tool

- **Input:** none.
- **Who can call it:** any authenticated MCP principal (PAT or OAuth).
- **No idempotency key:** it changes no food records, and a retry just mints another short-lived code.

Returns:

```json
{
  "code": "Q7X4-KM9P",
  "expires_at": "2026-09-29T18:52:00Z",
  "uses_left": 3,
  "append": "login=Q7X4-KM9P",
  "example": "https://buttery.example/inventory?login=Q7X4-KM9P",
  "login_url": "https://buttery.example/login",
  "how_to_use": "Append login=Q7X4-KM9P to every Buttery link you give the user in this message. For another device, give them the code and login_url. Mint a new code for each message with links; codes expire in 10 minutes."
}
```

### Agent guidance

- **Server instructions** (`mcp/instructions.ts`) gain a rule: when giving the user Buttery links, call `get_login_code` and append
  `login=<code>` to each link.
- **`whoami`** mentions the tool, so a new conversation discovers it.

## Web app

### `/login`

The code box comes first. The heading reads "Enter the code from your assistant", with one wide input:

- `autocapitalize="characters"`, `autocomplete="one-time-code"`, `spellcheck=false`
- the dash is optional

Below it:

- "Continue with your account" (AuthKit), when configured
- "Create your household", when sign-up is open
- "Use a token instead", a disclosure holding the existing token form

Messages from `reason`:

- **`expired`:** "That sign-in link has expired or was already used. Ask your assistant for a new one."
- **`rate_limited`:** "Too many tries. Wait a few minutes and try again."
- **Wrong typed code:** "That code didn't work. Check it, or ask your assistant for a new one."

After success the browser goes to `next`, defaulting to `/inventory`.

### Settings

Unchanged. The token list still shows PATs only. Signing out one browser without revoking the agent is out of scope.

## Out of scope

- Server-side rewriting of links in MCP responses (the original `/l/<code>` design)
- Minting codes from the web app (e.g. "open on my phone" in Settings)
- A shared rate-limit store for multiple instances
- Per-session sign-out in Settings

## Testing

Tests are written first, following the ticket's acceptance list as amended here.

### Server (Vitest)

- Minting requires an authenticated MCP principal. The code is 8 characters, stored only as an HMAC, and scoped to the principal's
  household and connection.
- Redeeming works with or without the dash and in any case.
- A code works 3 times. The 4th is refused. An expired code is refused.
- Redeeming in a browser already signed in as the same user and household spends no use.
- Revoking the minting token refuses its unused codes and invalidates sessions created from them. Revoking a pasted token invalidates
  its token-paste sessions (M7).
- A household A code never yields a session that can read household B.
- The `login` middleware strips the parameter, keeps other query parameters, and never redirects off-site. It covers backslash, tab and
  `//` in the path or `next`.
- The 11th failed attempt from one IP within 10 minutes is rate-limited. Successful attempts don't count.
- `/api`, `/auth`, `/mcp` and asset paths ignore `login`.
- `get_login_code` through MCP returns the documented shape.

### Phone e2e (Playwright)

- A fresh browser (no cookies) opens `/review/<id>?login=<code>`, lands on the review signed in, and the URL has no `login`.
- An expired code lands on `/login` showing the expired message.
- Typing a code on `/login` signs in and goes to `next`.

### Manual

- `get_login_code` from Claude Code against the local server, and the typed code signs in on `/login`.

## Follow-up to the ticket

Update #2's "Links in MCP responses are signed" acceptance item to: "Agents append a minted code as `login=`. Any page URL with a
valid `login` signs in and cleans the URL."
