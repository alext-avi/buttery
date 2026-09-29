# Page links from agents

Implements [alext-avi/buttery#2](https://github.com/alext-avi/buttery/issues/2), revised on 2026-09-29.

Two decisions changed the ticket's design:

- **Links are page passes, not sign-ins.** The ticket's links signed the browser in. Instead, a link from the agent opens the one page it
  points at, for 24 hours, and nothing else. It never signs the browser in or changes an existing sign-in. Tapping Inventory from a
  receipt link asks for a normal sign-in.
- **Codes don't touch `/login`.** The ticket's typeable codes for another device are dropped, and `/login` is unchanged.

## Goal

Someone can open the receipt, item or inventory page their assistant just linked, with one tap, without pasting a `btr_` token, and
without that link granting anything beyond the page. Their sign-in and household are untouched.

## How it works

1. The agent calls `get_login_code` with a Buttery page URL, for example the `review_url` from `submit_observation`. The server mints a
   one-time code for that page and returns the URL with `login=<code>` attached.
2. The person taps the link. The web app shows a small screen reading "Open this receipt" with an **Open** button. A chat app's link
   preview only loads this screen, so it can't spend the code.
3. Tapping Open posts the code to `POST /auth/open`. The server spends it and sets a 24-hour **page pass** for that page only. The browser
   then loads the clean URL.
4. The page's own API calls work under the pass. Every other page and API call needs a normal sign-in, exactly as before.

If the browser can already see the page (it is signed in to that household, or already holds a pass for it), the `login` parameter is
stripped and the page opens with no Open screen and no code spent.

## Shareable pages and what a pass allows

| Page | Pass kind | API calls the pass allows |
|---|---|---|
| `/review/<proposal>` | `proposal` | `GET /api/proposals/<id>`, `POST /api/proposals/<id>/resolve`, and undo of change sets caused by that proposal |
| `/items/<lot>` | `lot` | `GET /api/items/<id>`, and undo of change sets that touched that lot |
| `/inventory` (any filter) | `inventory` | `GET /api/inventory` |

- **Pages that are never shareable.** `/settings`, `/login` and anything else are refused at minting. Settings holds tokens, so it always
  needs a real sign-in.
- **Household check at minting.** A review or item link must belong to the agent's household.

## Data model

### `login_codes`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `code_hash` | text unique | HMAC-SHA-256 of the normalized code, keyed by `SESSION_SECRET` |
| `path` | text | The page the code opens, e.g. `/review/<id>` |
| `scope_kind` | text | `proposal`, `lot` or `inventory` |
| `scope_id` | uuid null | The proposal or lot id |
| `household_id`, `user_id` | uuid | From the minting connection |
| `connection_id` | uuid → connections | The MCP connection that minted it |
| `uses` / `max_uses` | int | `max_uses` is 1: codes are one-time |
| `expires_at` | timestamptz | Must be opened within `LOGIN_CODE_TTL_MINUTES` (default 10) |

- **Hashing.** HMAC rather than plain SHA-256, because an 8-character code is small enough to brute-force offline from a leaked table.
- **Pruning.** Codes that expired more than a day ago are deleted whenever a new one is minted.

### `connections.parent_connection_id`

A page pass acts as a web connection named `Web (link from <client>)`, whose parent is the minting connection. A token-paste sign-in's
web connection is named `Web (token for <client>)`, with the pasted token as parent. Any request under a web connection is refused if
the connection or its parent is revoked.

## Page pass

- **Storage.** The pass lives in its own signed, httpOnly `btr_pass` cookie, separate from the `btr_session` sign-in cookie. It holds up
  to 10 passes. Each pass records its kind, id, household, user, web connection and expiry (24 hours from opening).
- **How API requests use it.** The web API maps each request to the pass it would need (the table above). If a live pass covers the
  request, that pass's principal serves it. If the browser is also signed in to the same household, the session is used. Otherwise the
  session serves the request as before, or it's refused.
- **It never widens a sign-in.** A pass can't reach settings, tokens, `/api/me` or any other page's data. A browser signed in to
  household B that opens a link for household A keeps its B sign-in, and gains access only to that one A page.

## Code format and guessing

- **Format.** 8 characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789` (no 0/O, 1/I/L, U), shown as `XXXX-XXXX`. About 6.6 × 10¹¹
  possibilities.
- **Spending.** One atomic update: `uses < max_uses AND expires_at > now()`, and the minting connection unrevoked.
- **Rate limit.** Failed `POST /auth/open` attempts are limited to 10 per client per 10 minutes, held in memory, which is fine for one
  instance.
  - IPv4 counts per address, IPv6 per /64 block, and IPv4-mapped IPv6 as IPv4.
  - Page loads with `?login=` never redeem anything, so they never count, and old links in a chat don't use up anyone's budget.
- **Client IP.** It comes from the socket. With `TRUST_PROXY=true`, the last `X-Forwarded-For` entry is used: the one the proxy appended.
  The Vultr demo sets it, because Caddy is in front and the app port is bound to loopback.

## Leak hygiene

- The code stays in the address bar only until Open is tapped, then `location.replace` drops it.
- The Open screen loads nothing cross-origin except fonts, and `strict-origin-when-cross-origin` sends those only the origin.
- There is no request logger today. Any logger added later must mask the `login` parameter.

## MCP

`get_login_code({ url })`:

- **Takes** a Buttery page URL, absolute or a path.
- **Returns** `{ url, expires_at, opens: "once", how_to_use }`.
- **Errors:** `invalid_input` for pages that can't be shared or other hosts, and `not_found` for another household's receipt or item.

The server instructions and `whoami` tell agents to pass each Buttery link through it before sharing, one call per link.

## Web app

- **Open screen.** When a Layout page's URL has `?login=`, the page renders the Open screen instead of its content:
  - the heading "Open this receipt", "Open this item" or "Open your inventory"
  - the line "This link opens just this page. It doesn't sign you in."
  - an **Open** button
- **Failure messages.**
  - **Expired or used:** "This link has expired or was already used. Ask your assistant for a new one." with a "Sign in instead" link.
  - **Rate limited:** "Too many tries. Wait a few minutes and try again."
- **`/login` and Settings** are unchanged. `/login` sits outside the Layout and ignores `login`.

## Out of scope

- Signing a browser in from a code, including the typed code for another device.
- Signing out a single browser or pass from Settings.
- A shared rate-limit store for multiple instances.
- Revoking token-paste sessions created before this change. Those use the old parentless `Web` connection, so revoking their token doesn't
  sign them out.

## Testing

### Server (`test/login-codes.test.ts`)

- **Minting**
  - a one-time code for one page, stored only as an HMAC, with the page scope
  - settings, login, other hosts and other households are refused
- **Opening**
  - a page load with `?login=` spends nothing
  - Open grants that page's reads and writes, and refuses inventory, `/api/me` and tokens
  - a second open is refused, and so is an expired code
  - the Open screen is skipped for a signed-in same-household browser, or one that already has a pass, and no use is spent
- **Scope**
  - a household B sign-in is unchanged, and gains only the A page
  - a receipt pass can undo only that receipt's change sets
  - an item pass covers only that item
- **Revocation**
  - revoking the minting token kills its unused codes and the passes they granted
  - revoking a pasted token signs out the browsers it signed in (M7)
- **Limits and paths**
  - the rate limit groups IPv6 by /64
  - `login` is ignored on `/login`, `/settings`, the API and health paths
  - old codes are pruned
  - `get_login_code` works over MCP and `whoami` mentions it

### Phone e2e (`tests/e2e/05-login-code.spec.ts`)

- A fresh browser opens a review link, sees "Open this receipt", taps Open and lands on the receipt with a clean URL. Tapping Inventory
  then goes to `/login`.
- An expired link shows the expired message and "Sign in instead".

## Follow-up to the ticket

Update #2 to match: links grant a page pass rather than a sign-in, codes are one-time behind an Open tap, and there are no typeable codes
on `/login`.
