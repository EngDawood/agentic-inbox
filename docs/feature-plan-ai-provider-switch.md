# Feature Plan: Switch AI Provider (Workers AI → External Providers)

## Goal

Replace Cloudflare Workers AI with an external AI provider (Groq, Gemini, Mistral, or NVIDIA)
via the Vercel AI SDK, optionally routing traffic through Cloudflare AI Gateway for caching,
logging, and rate limiting.

---

## Current Architecture

Two AI surfaces exist in the codebase:

| File | Binding / SDK | Model | Purpose |
|------|--------------|-------|---------|
| `workers/agent/index.ts` | `createWorkersAI` (workers-ai-provider) | `@cf/moonshotai/kimi-k2.5` | Chat agent + auto-draft replies |
| `workers/lib/ai.ts` | `env.AI.run(...)` (Workers AI binding directly) | `@cf/meta/llama-3.1-8b-instruct-fast` | Prompt injection scanner |
| `workers/lib/ai.ts` | `env.AI.run(...)` | `@cf/meta/llama-4-scout-17b-16e-instruct` | Draft verifier |

Both surfaces must be updated when switching providers.

---

## Option A — Direct External Provider (Vercel AI SDK)

Switch the agent and `ai.ts` helpers to call a provider directly using an SDK package.
No AI Gateway involved — simplest path.

### Packages

```bash
pnpm add @ai-sdk/groq       # Groq
pnpm add @ai-sdk/google     # Google Gemini
pnpm add @ai-sdk/mistral    # Mistral
# NVIDIA: use @ai-sdk/openai with a custom baseURL
```

### Changes — `workers/agent/index.ts`

```ts
// Before
import { createWorkersAI } from "workers-ai-provider";
const workersai = createWorkersAI({ binding: env.AI });
model: workersai("@cf/moonshotai/kimi-k2.5")

// After (Groq example)
import { createGroq } from "@ai-sdk/groq";
const groq = createGroq({ apiKey: env.GROQ_API_KEY });
model: groq("llama-3.3-70b-versatile")
```

### Changes — `workers/lib/ai.ts`

`isPromptInjection` and `verifyDraft` use `env.AI.run(...)` which is a Workers AI-only API.
Replace with `generateText` from the Vercel AI SDK:

```ts
import { generateText } from "ai";
import { createGroq } from "@ai-sdk/groq";

export async function isPromptInjection(
  env: { GROQ_API_KEY: string },
  bodyHtml: string | null | undefined,
): Promise<boolean> {
  const groq = createGroq({ apiKey: env.GROQ_API_KEY });
  const { text } = await generateText({
    model: groq("llama-3.1-8b-instant"),   // fast, cheap model for security scan
    messages: [
      { role: "system", content: INJECTION_PROMPT },
      { role: "user", content: plainText },
    ],
    maxTokens: 10,
    temperature: 0,
  });
  return text.trim().toUpperCase().includes("YES");
}
```

`verifyDraft` follows the same pattern using a more capable model.

### Env / Secrets

Add the API key to `wrangler.toml` as a secret reference and `.dev.vars`:

```toml
# wrangler.toml — remove [ai] binding, add secret
# (no toml entry needed for secrets — set via `wrangler secret put GROQ_API_KEY`)
```

```bash
# .dev.vars
GROQ_API_KEY=gsk_...
```

Also remove the `AI` binding from `wrangler.toml` and `workers/types.ts` once fully migrated.

---

## Option B — External Provider via AI Gateway

Same provider SDKs as Option A, but override the `baseURL` to route through
Cloudflare AI Gateway. Adds caching, request logs, rate limits, and spend tracking
in the Cloudflare dashboard without changing model behavior.

```ts
import { createGroq } from "@ai-sdk/groq";

const groq = createGroq({
  apiKey: env.GROQ_API_KEY,
  baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_NAME}/groq`,
});
```

Set `CF_ACCOUNT_ID` and `CF_GATEWAY_NAME` as Worker env vars (not secrets).

### Supported Providers in AI Gateway

| Provider | Gateway path suffix |
|----------|-------------------|
| Groq | `/groq` |
| Google AI Studio (Gemini) | `/google-ai-studio` |
| Mistral | `/mistral` |
| NVIDIA | `/nvidia` |
| OpenAI | `/openai` |

---

## Option C — Keep Workers AI, Add AI Gateway Observability

If staying on Workers AI models is acceptable, just route the existing binding
through AI Gateway for logging:

```ts
const workersai = createWorkersAI({
  binding: env.AI,
  gateway: {
    id: env.CF_GATEWAY_NAME,   // gateway name in your Cloudflare account
    skipCache: false,
    cacheTtl: 3600,
  },
});
```

No provider change, no new API keys — just adds caching and dashboard visibility.

---

## Recommended Model Mapping

| Current Workers AI model | Suggested replacement | Provider |
|--------------------------|----------------------|----------|
| `@cf/moonshotai/kimi-k2.5` (chat agent) | `moonshotai/moonshot-v1-8k` or `llama-3.3-70b-versatile` | Groq |
| `@cf/meta/llama-3.1-8b-instruct-fast` (injection scan) | `llama-3.1-8b-instant` | Groq |
| `@cf/meta/llama-4-scout-17b-16e-instruct` (draft verifier) | `gemini-2.0-flash` or `mistral-small-latest` | Gemini / Mistral |

---

## Migration Checklist

- [ ] Install provider SDK package (`@ai-sdk/groq`, `@ai-sdk/google`, etc.)
- [ ] Add API key(s) via `wrangler secret put` and `.dev.vars`
- [ ] Add `CF_ACCOUNT_ID` + `CF_GATEWAY_NAME` to `wrangler.toml` vars (Option B only)
- [ ] Update `workers/agent/index.ts` — replace `createWorkersAI` + model string
- [ ] Update `workers/lib/ai.ts` — replace `env.AI.run(...)` calls in both functions
- [ ] Update `workers/types.ts` — remove `AI: Ai` from `Env`, add new key types
- [ ] Remove `[ai]` binding from `wrangler.toml` (if fully off Workers AI)
- [ ] Deploy and smoke-test: send a test email, verify auto-draft triggers
- [ ] Verify injection scanner still returns YES/NO correctly

---

## Files to Modify

```
workers/agent/index.ts      — model factory swap (2 call sites)
workers/lib/ai.ts           — replace ai.run() in isPromptInjection + verifyDraft
workers/types.ts            — update Env interface
wrangler.toml               — add/remove bindings and vars
.dev.vars / .dev.vars.example
```
