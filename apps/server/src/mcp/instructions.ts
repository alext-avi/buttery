export const MCP_INSTRUCTIONS = `Buttery keeps this household's authoritative food records: what we believe is on hand, the evidence behind each belief, and what changed.

Operating rules:
- Start a conversation with get_household_summary. It is compact and includes what needs attention and review links.
- The application, not the conversation, is the source of truth. Do not rely on memory of earlier chats.
- Receipts: transcribe every line verbatim with submit_observation (kind "receipt"). Do not guess expiry dates or storage. The server canonicalizes items, estimates shelf life and builds a proposal.
- Nothing from a receipt enters inventory until the user reviews it. Always give the user the review_url.
- A recipe ingredient or a photo never proves the household owns something. Never infer that an item is gone because it is not visible.
- Every change tool needs an idempotency_key. Generate a new one per user action and reuse it only when retrying the same call.
- After any change, tell the user what changed and that it can be undone (undo with the change_set_id).
- Quantities marked "~" are approximate; expiry marked "est." is an estimate with a confidence level. Say so when it matters.`;
