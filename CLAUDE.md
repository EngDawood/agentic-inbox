# CLAUDE.md — agentic-inbox (engdawood.com fork)

This is a personal fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) customized for `engdawood.com`. The changes were made to run entirely on the **Cloudflare free tier** — the upstream requires Cloudflare Email Service for outbound email, which needs a paid plan.

| Feature | Upstream | This fork |
|---------|----------|-----------|
| Outbound email | Cloudflare `send_email` binding (paid) | Resend API (free tier available) |
| Inbound routing | Per-address mailboxes | Catchall mailbox for `*@engdawood.com` |
| Package manager | npm | pnpm |

## Key Customizations

### Outbound Email: Resend API (not Cloudflare Email Service)
The upstream uses a `send_email` Worker binding (requires Cloudflare Email Service, paid plan).
This fork replaces it with the [Resend API](https://resend.com) via `RESEND_API_KEY` secret.

- Implementation: `workers/email-sender.ts`
- The `from` field **must be a plain string** for Resend — never pass `{email, name}` object.
- Normalize before calling Resend:
  ```typescript
  const fromStr = typeof params.from === "string"
      ? params.from
      : `${params.from.name} <${params.from.email}>`;
  ```

### Catchall Mailbox
`CATCHALL_MAILBOX=inbox@engdawood.com` is set as an env var in `wrangler.jsonc`.
All `*@engdawood.com` inbound email is caught by Cloudflare Email Routing and routed to this mailbox if no specific mailbox exists for the recipient address.

Catchall logic lives in `receiveEmail()` in `workers/index.ts`:
- If the recipient mailbox doesn't exist, fall back to `CATCHALL_MAILBOX`.

### Correct Reply-From (getEffectiveFromEmail)
When replying from a catchall mailbox, the reply-from should match the original recipient address, not the catchall address itself.

Function `getEffectiveFromEmail(original, mailboxEmail)` in `app/hooks/useComposeForm.ts`:
- Inspects `original.recipient` to find an address on the same domain as the mailbox
- Returns that address as the effective from address

### EMAIL_ADDRESSES — JSON-type Binding
`EMAIL_ADDRESSES` is configured as a **JSON-type** binding in the Cloudflare dashboard (value: `[]`).
It arrives in the Worker as an actual `string[]` array, NOT a JSON string.

**Never call `JSON.parse()` directly on it** — that would call `JSON.parse([])` which stringifies the array to `""` then throws `SyntaxError: Unexpected end of JSON input`.

Use the `parseEmailAddresses()` helper defined in `workers/index.ts`:
```typescript
function parseEmailAddresses(val: string | string[]): string[] {
    if (Array.isArray(val)) return val;
    if (!val) return [];
    return JSON.parse(val) as string[];
}
```

### Duplicate Email Dedup (message_id)
Cloudflare Email Routing may deliver the same email twice (retry on slow processing, or two matching rules).
`createEmail` in `workers/durableObject/index.ts` deduplicates on `message_id` before inserting:

```typescript
if (email.message_id) {
    const existing = this.db.select(...).where(eq(schema.emails.message_id, email.message_id)).get();
    if (existing) return; // skip duplicate
}
```

If an inbound email has no `Message-ID` header, dedup is skipped (rare but possible for malformed emails).

### Sender Validation — Domain Match, Not Exact Address
`validateSender()` in `workers/lib/email-helpers.ts` was originally an exact match (`from === mailboxId`).
This broke catchall replies where `from` is `support@engdawood.com` but the mailbox is `inbox@engdawood.com`.

**Fixed:** now checks that `from` domain matches the mailbox domain (`@engdawood.com === @engdawood.com`).
Any address on the same domain as the mailbox is allowed as the sender.

### AI Agent Reply-From Limitation
AI agent tools in `workers/lib/tools.ts` always send from `mailboxId` directly.
They do NOT use `getEffectiveFromEmail` — no access to the original recipient context.
**Known limitation:** AI-drafted replies from a catchall mailbox always send from `inbox@engdawood.com`, not from the original recipient address (e.g. `support@engdawood.com`).

### CATCHALL_MAILBOX in Env Type
`CATCHALL_MAILBOX` is declared as `CATCHALL_MAILBOX?: string` in `workers/types.ts`.
Use `env.CATCHALL_MAILBOX` directly — no `(env as any)` cast needed.

## Durable Object Migrations — CRITICAL

All three DOs (`MailboxDO`, `EmailAgent`, `EmailMCP`) are consolidated under a **single `v1` migration tag** in `wrangler.jsonc`:

```json
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["EmailAgent", "EmailMCP", "MailboxDO"] }]
```

**NEVER split this back into v1/v2/v3.** Cloudflare will reject the deploy with error 10074:
> "Cannot apply new-sqlite-class migration to class 'EmailAgent' that is already depended on by existing Durable Objects"

The deployed worker already has these DOs initialized under v1. Do not change the migration structure.

## Auth (Cloudflare Access)

In production, the worker validates Cloudflare Access JWTs. Two secrets must be set:
- `POLICY_AUD` — from the Cloudflare Access modal for this Worker
- `TEAM_DOMAIN` — your Access team URL or `.../cdn-cgi/access/certs` URL

These are not needed for local development (`wrangler dev`).

## Git Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | cloudflare/agentic-inbox | Upstream — **pull only, never push** |
| `mine` | EngDawood/agentic-inbox | Personal fork — push here |

Push: `git push mine main`

## Package Manager

Use **pnpm** (not npm). Run `pnpm install`, `pnpm run dev`, `pnpm run deploy`.

## Files Never to Commit

- `CLAUDE.md` (this file)
- `.vscode/`
