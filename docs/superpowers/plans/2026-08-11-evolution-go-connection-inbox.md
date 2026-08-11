# Evolution Go — Connection + Inbox (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account connect a WhatsApp number via Evolution Go's QR-code flow (instead of the Meta Cloud API) and use it for the Inbox — send/receive text and media — without changing any existing Meta behavior.

**Architecture:** A `provider` column on `whatsapp_config` picks which credential set is live for an account. A new `src/lib/whatsapp/evolution-api.ts` client mirrors `meta-api.ts`. The four Meta send call-sites gain provider branches (this plan only touches the Inbox one, `send-message.ts` — Automations/Flows/Broadcasts are Plan B). The Meta webhook route's generic "insert message → dispatch to flows/automations/AI/webhooks" tail is extracted into a shared `src/lib/whatsapp/inbound-message.ts` module so a new Evolution Go webhook route can reuse it without duplicating ~300 lines. Settings UI gets a provider selector and a QR-code connect flow.

**Tech Stack:** Next.js 16 (App Router), Supabase/Postgres, TypeScript, Vitest.

**Related:** Spec at `docs/superpowers/specs/2026-08-11-evolution-go-integration-design.md`. Plan B (Automations/Flows/Broadcasts provider branches) follows this plan and depends on it.

## Global Constraints

- Every existing Meta code path must keep behaving identically — prefer adding a new branch over editing an existing one. `src/app/api/whatsapp/webhook/route.test.ts` and every other existing WhatsApp test must keep passing **unmodified** after this plan.
- Evolution Go server is shared infrastructure we operate (not per-account BYO) and is already running. Config: `EVOLUTION_API_BASE_URL`, `EVOLUTION_GLOBAL_API_KEY` (server-only env vars).
- `access_token`-style secrets use the existing GCM encryption in `src/lib/whatsapp/encryption.ts` (`encrypt`/`decrypt`) — the new `evolution_instance_token` column follows the same convention.
- Auth model assumption for Evolution Go (docs don't show a worked example — confirm with a manual curl smoke test against the real server before Task 5): `POST /instance/create` authenticates with the shared `EVOLUTION_GLOBAL_API_KEY`; every other instance-scoped call (`connect`, `qr`, `status`, `logout`, `send/*`) authenticates with that instance's own `token` (returned by create) sent as the `apikey` header. If the real server instead requires the global key **plus** an `instanceId` header for scoped calls, only `instanceAuthHeaders()` in Task 2 needs to change — every call site stays the same.
- Evolution Go has no approved-template concept — out of scope for this plan (Broadcasts is Plan B). No interactive buttons/lists — Evolution Go's API doesn't expose them; out of scope entirely (not just this plan).
- Inbound media from Evolution Go: only handled when the shared server is configured with `WEBHOOK_FILES=false`, so the webhook payload carries a durable `url` field we can store directly as `messages.media_url` (mirrors the Meta proxy URL's simplicity). If the server has `WEBHOOK_FILES=true` (its default) and only sends inline `base64`, Task 4 logs a warning and stores the message with `media_url: null` rather than inventing a storage-upload path — flag this to the user as an infra prerequisite, don't silently build storage plumbing not asked for.

---

### Task 1: Migration — `provider` + Evolution columns on `whatsapp_config`

**Files:**
- Create: `supabase/migrations/039_evolution_provider.sql`

**Interfaces:**
- Produces: `whatsapp_config.provider` (`'meta' | 'evolution'`, default `'meta'`), `whatsapp_config.evolution_instance_id` (text, nullable, unique), `whatsapp_config.evolution_instance_token` (text, nullable, encrypted ciphertext), `whatsapp_config.evolution_instance_name` (text, nullable). Every later task reads/writes these exact column names.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 039_evolution_provider
--
-- Adds Evolution Go (unofficial, QR-code-connected WhatsApp) as a
-- second provider alongside the Meta Cloud API. `whatsapp_config`
-- keeps its one-row-per-account shape (UNIQUE(account_id) from
-- migration 017) — `provider` picks which set of columns is live
-- for that row. Meta's columns (phone_number_id, waba_id,
-- access_token, verify_token, registered_at, ...) are simply
-- unused when provider = 'evolution', and vice versa.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS evolution_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'evolution'));
  END IF;
END $$;

-- Nullable + UNIQUE is fine in Postgres (multiple NULLs allowed) —
-- same pattern as phone_number_id's constraint in migration 013.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_evolution_instance_id_key'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_evolution_instance_id_key
      UNIQUE (evolution_instance_id);
  END IF;
END $$;

COMMENT ON COLUMN whatsapp_config.provider IS
  'Which WhatsApp connection this account uses. ''meta'' (default) reads phone_number_id/waba_id/access_token/verify_token. ''evolution'' reads evolution_instance_id/evolution_instance_token/evolution_instance_name instead.';

COMMENT ON COLUMN whatsapp_config.evolution_instance_token IS
  'Per-instance token returned by Evolution Go on POST /instance/create, encrypted the same way as access_token (see src/lib/whatsapp/encryption.ts). Sent as the `apikey` header on every instance-scoped Evolution Go call.';
```

- [ ] **Step 2: Apply locally and verify idempotency**

Run: `supabase migration up` (or your project's usual local-DB apply command — check `package.json`/README for the exact one if `supabase` CLI isn't linked yet).
Expected: migration applies with no errors. Re-running it (or re-running `supabase db reset`) must not error — that's what makes it safe to ship (matches the "idempotent" convention every other migration in this repo follows).

- [ ] **Step 3: Confirm column shape**

Run: `psql "$DATABASE_URL" -c "\d whatsapp_config"` (or equivalent via the Supabase Studio table editor).
Expected: `provider` present, `NOT NULL DEFAULT 'meta'`; `evolution_instance_id`, `evolution_instance_token`, `evolution_instance_name` present, nullable.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/039_evolution_provider.sql
git commit -m "feat(whatsapp): add provider column and Evolution Go fields to whatsapp_config"
```

---

### Task 2: Evolution Go API client

**Files:**
- Create: `src/lib/whatsapp/evolution-api.ts`
- Test: `src/lib/whatsapp/evolution-api.test.ts`

**Interfaces:**
- Consumes: `process.env.EVOLUTION_API_BASE_URL`, `process.env.EVOLUTION_GLOBAL_API_KEY` (add both to `vitest.config.ts`'s `test.env` block, dummy values, alongside the existing `ENCRYPTION_KEY`/`META_APP_SECRET`).
- Produces (all later tasks import from here): `createInstance({name}): Promise<{instanceId, instanceToken}>`, `connectInstance({instanceToken, webhookUrl, subscribe}): Promise<void>`, `getQrCode({instanceToken}): Promise<{qrCodePng, code}>`, `getInstanceStatus({instanceToken}): Promise<{connected, loggedIn, name}>`, `logoutInstance({instanceToken}): Promise<void>`, `sendTextMessage({instanceToken, to, text}): Promise<{messageId}>`, `sendMediaMessage({instanceToken, to, kind, link, caption?, filename?}): Promise<{messageId}>`, `EvolutionMediaKind = 'image'|'video'|'document'|'audio'`.

- [ ] **Step 1: Add the new env vars to vitest config**

Edit `vitest.config.ts`, inside `test.env`, add two lines next to the existing `ENCRYPTION_KEY`/`META_APP_SECRET`:

```ts
      EVOLUTION_API_BASE_URL: "https://evolution.test",
      EVOLUTION_GLOBAL_API_KEY: "test-global-key",
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/whatsapp/evolution-api.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInstance,
  connectInstance,
  getQrCode,
  getInstanceStatus,
  logoutInstance,
  sendTextMessage,
  sendMediaMessage,
} from "./evolution-api";

interface Captured {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}
let captured: Captured | null = null;

function okFetch(json: unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    return { ok: true, json: async () => json } as Response;
  });
}

function errorFetch(status: number, message: string) {
  return vi.fn(
    async () =>
      ({
        ok: false,
        status,
        json: async () => ({ error: { message } }),
      }) as Response,
  );
}

describe("evolution-api", () => {
  beforeEach(() => {
    captured = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createInstance posts to /instance/create with the GLOBAL key", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ data: { id: "inst-1", token: "inst-token-1" }, message: "success" }),
    );
    const result = await createInstance({ name: "acc-42" });
    expect(result).toEqual({ instanceId: "inst-1", instanceToken: "inst-token-1" });
    expect(captured?.url).toBe("https://evolution.test/instance/create");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers?.apikey).toBe("test-global-key");
    expect(captured?.body).toEqual({ name: "acc-42" });
  });

  it("connectInstance posts webhookUrl+subscribe with the INSTANCE token", async () => {
    vi.stubGlobal("fetch", okFetch({ success: true, message: "success", data: {} }));
    await connectInstance({
      instanceToken: "inst-token-1",
      webhookUrl: "https://app.example.com/api/whatsapp-evolution/webhook",
      subscribe: ["MESSAGE", "CONNECTION", "QRCODE"],
    });
    expect(captured?.url).toBe("https://evolution.test/instance/connect");
    expect(captured?.headers?.apikey).toBe("inst-token-1");
    expect(captured?.body).toEqual({
      webhookUrl: "https://app.example.com/api/whatsapp-evolution/webhook",
      subscribe: ["MESSAGE", "CONNECTION", "QRCODE"],
      immediate: true,
    });
  });

  it("getQrCode returns the base64 PNG and raw code", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({
        data: { Qrcode: "data:image/png;base64,AAA", Code: "2@abc" },
        message: "success",
      }),
    );
    const result = await getQrCode({ instanceToken: "inst-token-1" });
    expect(result).toEqual({ qrCodePng: "data:image/png;base64,AAA", code: "2@abc" });
    expect(captured?.url).toBe("https://evolution.test/instance/qr");
    expect(captured?.headers?.apikey).toBe("inst-token-1");
  });

  it("getInstanceStatus maps Connected/LoggedIn/Name", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ data: { Connected: true, LoggedIn: true, Name: "+55 11 9…" }, message: "success" }),
    );
    const result = await getInstanceStatus({ instanceToken: "inst-token-1" });
    expect(result).toEqual({ connected: true, loggedIn: true, name: "+55 11 9…" });
  });

  it("logoutInstance issues a DELETE with the instance token", async () => {
    vi.stubGlobal("fetch", okFetch({ success: true, message: "success" }));
    await logoutInstance({ instanceToken: "inst-token-1" });
    expect(captured?.url).toBe("https://evolution.test/instance/logout");
    expect(captured?.method).toBe("DELETE");
    expect(captured?.headers?.apikey).toBe("inst-token-1");
  });

  it("sendTextMessage posts number+text and returns messageId", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ success: true, message: "success", messageId: "msg-1" }),
    );
    const result = await sendTextMessage({
      instanceToken: "inst-token-1",
      to: "5511999999999",
      text: "hello",
    });
    expect(result).toEqual({ messageId: "msg-1" });
    expect(captured?.url).toBe("https://evolution.test/send/text");
    expect(captured?.body).toEqual({ number: "5511999999999", text: "hello" });
  });

  it("sendMediaMessage posts number+type+url+caption+filename", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ success: true, message: "success", messageId: "msg-2" }),
    );
    const result = await sendMediaMessage({
      instanceToken: "inst-token-1",
      to: "5511999999999",
      kind: "document",
      link: "https://cdn.example.com/invoice.pdf",
      caption: "Invoice",
      filename: "invoice.pdf",
    });
    expect(result).toEqual({ messageId: "msg-2" });
    expect(captured?.body).toEqual({
      number: "5511999999999",
      type: "document",
      url: "https://cdn.example.com/invoice.pdf",
      caption: "Invoice",
      filename: "invoice.pdf",
    });
  });

  it("sendMediaMessage throws when no link is provided", async () => {
    vi.stubGlobal("fetch", okFetch({}));
    await expect(
      sendMediaMessage({ instanceToken: "t", to: "5511999999999", kind: "image", link: "" }),
    ).rejects.toThrow(/requires a link/);
  });

  it("surfaces the Evolution Go error message on a non-2xx response", async () => {
    vi.stubGlobal("fetch", errorFetch(401, "Invalid or missing API key"));
    await expect(
      sendTextMessage({ instanceToken: "bad", to: "5511999999999", text: "hi" }),
    ).rejects.toThrow(/Invalid or missing API key/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/whatsapp/evolution-api.test.ts`
Expected: FAIL — `Cannot find module './evolution-api'`.

- [ ] **Step 4: Implement `evolution-api.ts`**

```ts
// src/lib/whatsapp/evolution-api.ts
/**
 * Evolution Go API helpers — the unofficial, QR-code-connected WhatsApp
 * provider. Mirrors meta-api.ts's shape: one options object per
 * function, throws on non-2xx, returns just what callers need.
 *
 * Auth: POST /instance/create is the one call that uses the shared
 * server's GLOBAL_API_KEY (no instance exists yet to have its own
 * token). Every other call is instance-scoped and authenticates with
 * that instance's own `token` (returned by create, stored encrypted
 * in whatsapp_config.evolution_instance_token) sent as the `apikey`
 * header — see the auth-model note in the Evolution Go plan doc if
 * this assumption turns out wrong; only `instanceAuthHeaders` below
 * needs to change.
 */

const EVOLUTION_API_BASE_URL = process.env.EVOLUTION_API_BASE_URL!
const EVOLUTION_GLOBAL_API_KEY = process.env.EVOLUTION_GLOBAL_API_KEY!

export interface EvolutionSendResult {
  messageId: string
}

interface EvolutionErrorResponse {
  error?: { message?: string; code?: string }
  message?: string
}

async function throwEvolutionError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as EvolutionErrorResponse
    message = data.error?.message ?? fallback
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

function globalAuthHeaders(): Record<string, string> {
  return { apikey: EVOLUTION_GLOBAL_API_KEY }
}

function instanceAuthHeaders(instanceToken: string): Record<string, string> {
  return { apikey: instanceToken }
}

// ============================================================
// Instance lifecycle
// ============================================================

export interface CreateInstanceArgs {
  name: string
}

export interface CreateInstanceResult {
  instanceId: string
  instanceToken: string
}

export async function createInstance(args: CreateInstanceArgs): Promise<CreateInstanceResult> {
  const response = await fetch(`${EVOLUTION_API_BASE_URL}/instance/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...globalAuthHeaders() },
    body: JSON.stringify({ name: args.name }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
  const { data } = await response.json()
  return { instanceId: data.id, instanceToken: data.token }
}

export interface ConnectInstanceArgs {
  instanceToken: string
  webhookUrl: string
  subscribe: string[]
}

/**
 * Starts the connection flow and registers our webhook + event
 * subscriptions in one call. Must be called before `getQrCode` —
 * the QR is only available once a connection attempt is in flight.
 */
export async function connectInstance(args: ConnectInstanceArgs): Promise<void> {
  const { instanceToken, webhookUrl, subscribe } = args
  const response = await fetch(`${EVOLUTION_API_BASE_URL}/instance/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...instanceAuthHeaders(instanceToken) },
    body: JSON.stringify({ webhookUrl, subscribe, immediate: true }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
}

export interface GetQrCodeResult {
  /** `data:image/png;base64,...` — ready for a bare `<img src>`. */
  qrCodePng: string
  code: string
}

export async function getQrCode(args: { instanceToken: string }): Promise<GetQrCodeResult> {
  const response = await fetch(`${EVOLUTION_API_BASE_URL}/instance/qr`, {
    headers: instanceAuthHeaders(args.instanceToken),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
  const { data } = await response.json()
  return { qrCodePng: data.Qrcode, code: data.Code }
}

export interface GetInstanceStatusResult {
  connected: boolean
  loggedIn: boolean
  name: string
}

export async function getInstanceStatus(args: { instanceToken: string }): Promise<GetInstanceStatusResult> {
  const response = await fetch(`${EVOLUTION_API_BASE_URL}/instance/status`, {
    headers: instanceAuthHeaders(args.instanceToken),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
  const { data } = await response.json()
  return { connected: !!data.Connected, loggedIn: !!data.LoggedIn, name: data.Name }
}

export async function logoutInstance(args: { instanceToken: string }): Promise<void> {
  const response = await fetch(`${EVOLUTION_API_BASE_URL}/instance/logout`, {
    method: 'DELETE',
    headers: instanceAuthHeaders(args.instanceToken),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
}

// ============================================================
// Sending
// ============================================================

export interface SendTextMessageArgs {
  instanceToken: string
  to: string
  text: string
}

export async function sendTextMessage(args: SendTextMessageArgs): Promise<EvolutionSendResult> {
  const { instanceToken, to, text } = args
  const response = await fetch(`${EVOLUTION_API_BASE_URL}/send/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...instanceAuthHeaders(instanceToken) },
    body: JSON.stringify({ number: to, text }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messageId }
}

export type EvolutionMediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs {
  instanceToken: string
  to: string
  kind: EvolutionMediaKind
  link: string
  caption?: string
  filename?: string
}

export async function sendMediaMessage(args: SendMediaMessageArgs): Promise<EvolutionSendResult> {
  const { instanceToken, to, kind, link, caption, filename } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')
  const response = await fetch(`${EVOLUTION_API_BASE_URL}/send/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...instanceAuthHeaders(instanceToken) },
    body: JSON.stringify({ number: to, type: kind, url: link, caption, filename }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messageId }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/whatsapp/evolution-api.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts src/lib/whatsapp/evolution-api.ts src/lib/whatsapp/evolution-api.test.ts
git commit -m "feat(whatsapp): add Evolution Go API client"
```

---

### Task 3: Extract shared inbound-message pipeline out of the Meta webhook route

**Why this task exists:** The Meta webhook route's tail (insert message → bump conversation → dispatch flows/automations/AI/webhooks) is generic — it doesn't care whether the message came from Meta or Evolution Go. Task 4's new Evolution webhook route needs that exact same tail without duplicating it. This task moves it out **without changing its behavior** — `src/app/api/whatsapp/webhook/route.test.ts` is the regression gate: it drives the route end-to-end through mocked Supabase calls and must pass **unmodified** afterward.

**Files:**
- Create: `src/lib/whatsapp/inbound-message.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts` (replace the moved functions with imports; `processMessage` shrinks to call the new shared function)
- Test: `src/app/api/whatsapp/webhook/route.test.ts` (must NOT need edits — see verification step)

**Interfaces:**
- Produces: `supabaseAdmin(): SupabaseClient`, `findOrCreateContact(accountId, configOwnerUserId, phone, name): Promise<ContactOutcome | null>`, `findOrCreateConversation(accountId, configOwnerUserId, contactId): Promise<{conversation, created: boolean} | null>`, `flagBroadcastReplyIfAny(accountId, contactId): Promise<void>`, `lookupInternalIdByMetaId(providerMessageId, conversationId): Promise<string | null>`, `ingestInboundMessage(params: IngestInboundMessageParams): Promise<void>` — Task 4's Evolution webhook route calls all of these directly.

- [ ] **Step 1: Create the shared module, moving code verbatim where possible**

```ts
// src/lib/whatsapp/inbound-message.ts
/**
 * Provider-agnostic inbound-message pipeline. Both the Meta webhook
 * route and the Evolution Go webhook route resolve their own
 * provider-specific payload into the primitives below, then call
 * `ingestInboundMessage` — everything from "find/create the contact"
 * through "dispatch to flows/automations/AI/outbound webhooks" is
 * identical regardless of which WhatsApp connection the message
 * arrived on.
 *
 * Moved out of src/app/api/whatsapp/webhook/route.ts unchanged in
 * behavior — see that file's history for the original inline version
 * and src/app/api/whatsapp/webhook/route.test.ts for the regression
 * coverage this preserves.
 */
import { createClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
export function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface ContactOutcome {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contact: any
  wasCreated: boolean
}

export async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

export async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

export async function lookupInternalIdByMetaId(
  providerMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-message] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

export interface NormalizedInboundContent {
  contentText: string | null
  mediaUrl: string | null
  interactiveReplyId: string | null
}

export interface IngestInboundMessageParams {
  accountId: string
  configOwnerUserId: string
  contactId: string
  /** Full resolved row — `status` drives `reopenClosedConversation`'s cheap skip. */
  conversation: { id: string; status?: string | null }
  wasContactCreated: boolean
  providerMessageId: string
  contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'template' | 'interactive'
  content: NormalizedInboundContent
  createdAt: Date
  replyToProviderMessageId?: string | null
}

/**
 * The provider-agnostic tail: persist the message, bump the
 * conversation, and fan out to flows / automations / AI auto-reply /
 * outbound webhooks. Callers must have already resolved (or created)
 * the contact and conversation, and normalized the provider's raw
 * payload into `content`/`contentType` — this function does no
 * provider-specific parsing.
 */
export async function ingestInboundMessage(params: IngestInboundMessageParams): Promise<void> {
  const {
    accountId,
    configOwnerUserId,
    contactId,
    conversation,
    wasContactCreated,
    providerMessageId,
    contentType,
    content,
    createdAt,
    replyToProviderMessageId,
  } = params
  const db = supabaseAdmin()

  let replyToInternalId: string | null = null
  if (replyToProviderMessageId) {
    replyToInternalId = await lookupInternalIdByMetaId(replyToProviderMessageId, conversation.id)
    if (!replyToInternalId) {
      console.warn('[inbound-message] reply context parent not found:', replyToProviderMessageId)
    }
  }

  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { data: insertedRows, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: content.contentText,
        media_url: content.mediaUrl,
        message_id: providerMessageId,
        status: 'delivered',
        created_at: createdAt.toISOString(),
        reply_to_message_id: replyToInternalId,
        interactive_reply_id: content.interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('[inbound-message] insert failed:', msgError)
    return
  }
  if (!insertedRows || insertedRows.length === 0) {
    console.info('[inbound-message] duplicate inbound message ignored (idempotent replay):', providerMessageId)
    return
  }

  const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: content.contentText || `[${contentType}]`,
  })
  if (convError) {
    console.error('[inbound-message] Error updating conversation:', convError)
  }

  await reopenClosedConversation(db, conversation)
  await flagBroadcastReplyIfAny(accountId, contactId)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId,
    conversationId: conversation.id,
    message: content.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: content.interactiveReplyId,
          reply_title: content.contentText ?? '',
          meta_message_id: providerMessageId,
        }
      : {
          kind: 'text',
          text: content.contentText ?? '',
          meta_message_id: providerMessageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = content.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (content.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (wasContactCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: content.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && !content.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactId,
    whatsapp_message_id: providerMessageId,
    content_type: contentType,
    text: content.contentText,
  })
}
```

- [ ] **Step 2: Rewire `webhook/route.ts` to use the shared module**

In `src/app/api/whatsapp/webhook/route.ts`:

1. Add to the top imports:
```ts
import {
  findOrCreateContact,
  findOrCreateConversation,
  ingestInboundMessage,
} from '@/lib/whatsapp/inbound-message'
```

2. Delete the local `findOrCreateContact` (was at line 1062) and `findOrCreateConversation` (was at line 1122) function bodies entirely — they're now imported.

3. Delete the local `flagBroadcastReplyIfAny` (was at line 458) and `lookupInternalIdByMetaId` (was at line 494) function bodies — `ingestInboundMessage` calls them internally now; nothing else in this file used them directly.

4. Replace the body of `processMessage` from the "Parse message content based on type" comment (previously line 624) through the end of the function (previously line 883) with:

```ts
  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)
  void mediaType // no `media_type` column — MIME is only used inside parseMessageContent

  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'
      : message.type === 'button'
        ? 'interactive'
        : 'text'

  await ingestInboundMessage({
    accountId,
    configOwnerUserId,
    contactId: contactRecord.id,
    conversation,
    wasContactCreated: contactOutcome.wasCreated,
    providerMessageId: message.id,
    contentType: contentType as
      | 'text' | 'image' | 'document' | 'audio' | 'video'
      | 'location' | 'template' | 'interactive',
    content: { contentText, mediaUrl, interactiveReplyId },
    createdAt: new Date(parseInt(message.timestamp) * 1000),
    replyToProviderMessageId: message.context?.id ?? null,
  })
}
```

Everything ABOVE that point in `processMessage` (senderPhone/contactName resolution, the `findOrCreateContact`/`findOrCreateConversation` calls, the `conversation.created` dispatch, and the reaction short-circuit calling `handleReaction`) stays exactly as it is — those now resolve `contactRecord`/`conversation` via the imported functions instead of local ones, same call signatures, so no other line in that block changes.

- [ ] **Step 3: Run the existing regression suite — must pass with zero edits to the test file**

Run: `npx vitest run src/app/api/whatsapp/webhook/route.test.ts`
Expected: PASS, same test count as before this task. If anything fails, the extraction changed behavior — compare the failing assertion against the original inline code (`git show HEAD:src/app/api/whatsapp/webhook/route.ts` before this task's commit) rather than editing the test to match.

- [ ] **Step 4: Run the full test suite as a broader safety net**

Run: `npx vitest run`
Expected: PASS. `send-message.test.ts`, `broadcast-core.test.ts`, etc. don't touch this code path, so this is mainly confirming nothing else imports the now-deleted local functions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/inbound-message.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "refactor(whatsapp): extract provider-agnostic inbound-message pipeline

Mechanical extraction — src/app/api/whatsapp/webhook/route.test.ts
passes unmodified, confirming behavior is unchanged. Lets a second
webhook route (Evolution Go, next commit) reuse the same pipeline
instead of duplicating it."
```

---

### Task 4: Evolution Go inbound webhook route

**Files:**
- Create: `src/app/api/whatsapp-evolution/webhook/route.ts`
- Test: `src/app/api/whatsapp-evolution/webhook/route.test.ts`

**Interfaces:**
- Consumes: `supabaseAdmin`, `findOrCreateContact`, `findOrCreateConversation`, `ingestInboundMessage` from `@/lib/whatsapp/inbound-message` (Task 3); `decrypt` from `@/lib/whatsapp/encryption`; `dispatchWebhookEvent` from `@/lib/webhooks/deliver`.
- Produces: `POST` handler at `/api/whatsapp-evolution/webhook` — this is the `webhookUrl` Task 5 registers with Evolution Go on connect.

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/whatsapp-evolution/webhook/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  state: {
    config: {
      account_id: 'acc-1',
      user_id: 'user-1',
      evolution_instance_id: 'inst-1',
      evolution_instance_token: 'enc-token',
    } as Record<string, unknown> | null,
    conversation: { id: 'conv-1', status: 'open' },
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    upsertCalls: [] as Record<string, unknown>[],
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () => ({
                eq: () =>
                  Promise.resolve({
                    data: h.state.config ? [h.state.config] : [],
                    error: null,
                  }),
              }),
            }),
          }
        case 'contacts':
          return {
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: 'contact-1', name: 'Ana' }, error: null }),
              }),
            }),
          }
        case 'conversations':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({ data: [h.state.conversation], error: null }),
                  }),
                }),
              }),
            }),
          }
        case 'broadcast_recipients':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
                  }),
                }),
              }),
            }),
          }
        case 'messages':
          return {
            select: (_c: string, options?: { head?: boolean }) =>
              options?.head
                ? {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({ count: h.state.priorCustomerMsgCount, error: null }),
                    }),
                  }
                : { eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) },
            upsert: (row: Record<string, unknown>) => {
              h.state.upsertCalls.push(row)
              return { select: () => Promise.resolve({ data: h.state.messageUpsertResult, error: null }) }
            },
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: vi.fn(async () => false) }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn(async () => {}) }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })) }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn(async () => {}) }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace('enc-', '') }))

import { POST } from './route'

function inboundRequest(body: unknown) {
  return new Request('https://app.example.com/api/whatsapp-evolution/webhook', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('Evolution Go webhook route', () => {
  beforeEach(() => {
    h.state.upsertCalls = []
    h.state.priorCustomerMsgCount = 0
  })

  it('ignores an event whose instanceToken does not match the stored one', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-1',
        instanceToken: 'wrong-token',
        data: { Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'wamid-1', Type: 'text', IsFromMe: false, IsGroup: false, PushName: 'Ana', Timestamp: '2026-08-11T10:00:00-03:00' }, Message: { conversation: 'oi' } },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status).toBe(401)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('ignores an event for an unknown instanceId', async () => {
    h.state.config = null
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-unknown',
        instanceToken: 'token',
        data: { Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'wamid-1', Type: 'text', IsFromMe: false, IsGroup: false, PushName: 'Ana', Timestamp: '2026-08-11T10:00:00-03:00' }, Message: { conversation: 'oi' } },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('ignores echoes of our own outbound messages (IsFromMe)', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: { Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'wamid-1', Type: 'text', IsFromMe: true, IsGroup: false, PushName: 'Ana', Timestamp: '2026-08-11T10:00:00-03:00' }, Message: { conversation: 'oi' } },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('inserts an inbound text message and returns 200', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: {
          Info: {
            Chat: '5511999999999@s.whatsapp.net',
            ID: 'wamid-1',
            Type: 'text',
            IsFromMe: false,
            IsGroup: false,
            PushName: 'Ana',
            Timestamp: '2026-08-11T10:00:00-03:00',
          },
          Message: { conversation: 'Oi, tudo bem?' },
        },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0]).toMatchObject({
      content_type: 'text',
      content_text: 'Oi, tudo bem?',
      message_id: 'wamid-1',
      sender_type: 'customer',
    })
  })

  it('ignores group messages', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: { Info: { Chat: '123-456@g.us', ID: 'wamid-2', Type: 'text', IsFromMe: false, IsGroup: true, PushName: 'Group', Timestamp: '2026-08-11T10:00:00-03:00' }, Message: { conversation: 'oi grupo' } },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('non-Message events (e.g. Connected) return 200 without inserting anything', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Connected',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: { status: 'open', jid: '5511999999999:5@s.whatsapp.net' },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/whatsapp-evolution/webhook/route.test.ts`
Expected: FAIL — route module doesn't exist yet.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/whatsapp-evolution/webhook/route.ts
/**
 * Inbound webhook for the Evolution Go provider. Unlike Meta's
 * webhook, there's no GET verification handshake and no HMAC
 * signature — the shared server is trusted infrastructure we
 * operate, and the payload's `instanceToken` is checked against the
 * value we stored for that `instanceId` to reject spoofed events
 * (the server is multi-tenant, so this is the tenant boundary).
 *
 * Only the `Message` event is handled in this v1 — `Connected` /
 * `PairSuccess` / `QRCode` connection-status events are handled by
 * the settings page polling `/api/whatsapp/config` (Task 5), not by
 * this route, keeping this file's scope to "a message arrived."
 */
import { NextResponse } from 'next/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  supabaseAdmin,
  findOrCreateContact,
  findOrCreateConversation,
  ingestInboundMessage,
} from '@/lib/whatsapp/inbound-message'

interface EvolutionMessageInfo {
  Chat: string
  Sender?: string
  ID: string
  Type: string
  IsFromMe: boolean
  IsGroup: boolean
  PushName?: string
  Timestamp: string
}

interface EvolutionMessagePayload {
  Info: EvolutionMessageInfo
  Message?: {
    conversation?: string
    imageMessage?: { url?: string; caption?: string }
    videoMessage?: { url?: string; caption?: string }
    audioMessage?: { url?: string }
    documentMessage?: { url?: string; caption?: string; fileName?: string }
  }
}

interface EvolutionWebhookBody {
  event: string
  data: unknown
  instanceId: string
  instanceToken: string
}

/** `5511999999999@s.whatsapp.net` -> `5511999999999`. Groups end in `@g.us`. */
function phoneFromJid(jid: string): string {
  return jid.split('@')[0]
}

function normalizeContent(msg: EvolutionMessagePayload['Message']): {
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document'
  contentText: string | null
  mediaUrl: string | null
} {
  if (!msg) return { contentType: 'text', contentText: null, mediaUrl: null }
  if (msg.imageMessage) {
    return { contentType: 'image', contentText: msg.imageMessage.caption ?? null, mediaUrl: msg.imageMessage.url ?? null }
  }
  if (msg.videoMessage) {
    return { contentType: 'video', contentText: msg.videoMessage.caption ?? null, mediaUrl: msg.videoMessage.url ?? null }
  }
  if (msg.audioMessage) {
    return { contentType: 'audio', contentText: null, mediaUrl: msg.audioMessage.url ?? null }
  }
  if (msg.documentMessage) {
    return { contentType: 'document', contentText: msg.documentMessage.caption ?? null, mediaUrl: msg.documentMessage.url ?? null }
  }
  return { contentType: 'text', contentText: msg.conversation ?? null, mediaUrl: null }
}

export async function POST(request: Request) {
  let body: EvolutionWebhookBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { data: configRows, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('evolution_instance_id', body.instanceId)
    .eq('provider', 'evolution')

  if (configError || !configRows || configRows.length === 0) {
    console.error('[evolution-webhook] no config for instanceId:', body.instanceId)
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const config = configRows[0]
  const storedToken = decrypt(config.evolution_instance_token)
  if (storedToken !== body.instanceToken) {
    console.warn('[evolution-webhook] instanceToken mismatch for instanceId:', body.instanceId)
    return NextResponse.json({ error: 'Invalid instance token' }, { status: 401 })
  }

  if (body.event !== 'Message') {
    // Connection/QR events: status is read on demand by the settings
    // page (Task 5), not pushed through here in v1.
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const payload = body.data as EvolutionMessagePayload
  if (payload.Info.IsFromMe || payload.Info.IsGroup) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const senderPhone = phoneFromJid(payload.Info.Chat)
  const contactName = payload.Info.PushName || senderPhone

  const contactOutcome = await findOrCreateContact(config.account_id, config.user_id, senderPhone, contactName)
  if (!contactOutcome) return NextResponse.json({ status: 'error' }, { status: 200 })

  const convResult = await findOrCreateConversation(config.account_id, config.user_id, contactOutcome.contact.id)
  if (!convResult) return NextResponse.json({ status: 'error' }, { status: 200 })

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), config.account_id, 'conversation.created', {
      conversation_id: convResult.conversation.id,
      contact_id: contactOutcome.contact.id,
    })
  }

  const { contentType, contentText, mediaUrl } = normalizeContent(payload.Message)

  await ingestInboundMessage({
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    contactId: contactOutcome.contact.id,
    conversation: convResult.conversation,
    wasContactCreated: contactOutcome.wasCreated,
    providerMessageId: payload.Info.ID,
    contentType,
    content: { contentText, mediaUrl, interactiveReplyId: null },
    createdAt: new Date(payload.Info.Timestamp),
    replyToProviderMessageId: null,
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/whatsapp-evolution/webhook/route.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/whatsapp-evolution/webhook/route.ts src/app/api/whatsapp-evolution/webhook/route.test.ts
git commit -m "feat(whatsapp): add Evolution Go inbound webhook route"
```

---

### Task 5: Evolution Go connect / QR / status / disconnect API routes

**Files:**
- Create: `src/app/api/whatsapp/config/resolve-account.ts` (extracted from `config/route.ts`)
- Create: `src/app/api/whatsapp/evolution/connect/route.ts` (POST — create instance + start connect; DELETE — logout + reset config)
- Create: `src/app/api/whatsapp/evolution/qr/route.ts` (GET — fetch current QR)
- Modify: `src/app/api/whatsapp/config/route.ts` (import `resolveAccountId` instead of defining it locally; GET branches by provider instead of always calling Meta)
- Test: `src/app/api/whatsapp/evolution/connect/route.test.ts`, `src/app/api/whatsapp/evolution/qr/route.test.ts`

**Interfaces:**
- Consumes: `createInstance`, `connectInstance`, `getQrCode`, `logoutInstance` from `@/lib/whatsapp/evolution-api` (Task 2); `encrypt`/`decrypt` from `@/lib/whatsapp/encryption`; `createClient` from `@/lib/supabase/server` (the same cookie-based, RLS-scoped client `config/route.ts` already uses — NOT the service-role `@supabase/supabase-js` client, so the account's normal admin-only write RLS policy on `whatsapp_config` applies here too, same as it does for Meta's POST handler).
- Produces: `resolveAccountId(supabase, userId): Promise<string | null>`; `POST /api/whatsapp/evolution/connect` returns `{ success: true }`; `DELETE /api/whatsapp/evolution/connect` returns `{ success: true }`; `GET /api/whatsapp/evolution/qr` returns `{ qrCodePng: string, code: string }`; `GET /api/whatsapp/config` now also returns `{ connected: boolean, provider: 'evolution', instance_name: string | null }` when the account's provider is `'evolution'`.

**Before this task:** manually confirm the auth-header assumption from Global Constraints against the real Evolution Go server (`curl -X GET $EVOLUTION_API_BASE_URL/instance/status -H "apikey: <a real instance token>"`) — if it 401s and needs the global key + an `instanceId` header instead, fix `instanceAuthHeaders()` in `evolution-api.ts` (Task 2) first; nothing else in this task changes either way.

- [ ] **Step 1: Extract `resolveAccountId` out of `config/route.ts`**

The real current file (`src/app/api/whatsapp/config/route.ts` lines 1–32) is:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}
```

Note the real signature: `resolveAccountId(supabase, userId)` — it takes the already-authenticated RLS-scoped client plus the user id, NOT a bare `Request`. Move the function (unchanged) into a new file, export it, and import it back:

```ts
// src/app/api/whatsapp/config/resolve-account.ts
import type { createClient } from '@/lib/supabase/server'

/**
 * Resolve the caller's account_id from their profile. Extracted out
 * of config/route.ts so the Evolution Go connect/QR routes (Task 5)
 * can share it instead of re-deriving auth resolution.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
export async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}
```

In `config/route.ts`, delete the local `resolveAccountId` function body (the block quoted above, minus the other imports) and add:

```ts
import { resolveAccountId } from './resolve-account'
```

`config/route.ts` has no existing test file, so the check here is build-level: run `npx tsc --noEmit` (or `npm run build`) afterward to confirm the import resolves and every call site (`GET`, and `POST` if it also calls `resolveAccountId` — check before editing) still type-checks.

- [ ] **Step 2: Write the failing tests for `connect/route.ts`**

```ts
// src/app/api/whatsapp/evolution/connect/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  createInstance: vi.fn(async () => ({ instanceId: 'inst-1', instanceToken: 'raw-token' })),
  connectInstance: vi.fn(async () => {}),
  logoutInstance: vi.fn(async () => {}),
  upsertCalls: [] as Record<string, unknown>[],
  deleteCalls: [] as string[],
  accountId: 'acc-1' as string | null,
  authUser: { id: 'user-1' } as { id: string } | null,
}))

vi.mock('next/server', () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ body: b, init: i }) },
}))
vi.mock('@/lib/whatsapp/evolution-api', () => ({
  createInstance: h.createInstance,
  connectInstance: h.connectInstance,
  logoutInstance: h.logoutInstance,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc-${v}`,
  decrypt: (v: string) => v.replace('enc-', ''),
}))
vi.mock('@/app/api/whatsapp/config/resolve-account', () => ({
  resolveAccountId: vi.fn(async () => h.accountId),
}))

function supabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: h.authUser },
        error: h.authUser ? null : { message: 'no user' },
      })),
    },
    from: (table: string) => {
      if (table !== 'whatsapp_config') throw new Error(`unexpected table: ${table}`)
      return {
        upsert: (row: Record<string, unknown>) => {
          h.upsertCalls.push(row)
          return Promise.resolve({ error: null })
        },
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { evolution_instance_token: 'enc-raw-token' }, error: null }),
          }),
        }),
        delete: () => ({
          eq: (_col: string, val: string) => {
            h.deleteCalls.push(val)
            return Promise.resolve({ error: null })
          },
        }),
      }
    },
  }
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock()),
}))

import { POST, DELETE } from './route'

describe('POST /api/whatsapp/evolution/connect', () => {
  beforeEach(() => {
    h.upsertCalls = []
    h.accountId = 'acc-1'
    h.authUser = { id: 'user-1' }
  })

  it('creates an instance, connects it, and saves the config row', async () => {
    const res = await POST()
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.createInstance).toHaveBeenCalledWith({ name: 'acc-1' })
    expect(h.connectInstance).toHaveBeenCalledWith({
      instanceToken: 'raw-token',
      webhookUrl: expect.stringContaining('/api/whatsapp-evolution/webhook'),
      subscribe: ['MESSAGE', 'CONNECTION', 'QRCODE'],
    })
    expect(h.upsertCalls[0]).toMatchObject({
      account_id: 'acc-1',
      provider: 'evolution',
      evolution_instance_id: 'inst-1',
      evolution_instance_token: 'enc-raw-token',
      status: 'connecting',
    })
  })

  it('returns 401 when the caller is not authenticated', async () => {
    h.authUser = null
    const res = await POST()
    expect((res as { init?: { status?: number } }).init?.status).toBe(401)
  })

  it('returns 400 when the profile has no account', async () => {
    h.accountId = null
    const res = await POST()
    expect((res as { init?: { status?: number } }).init?.status).toBe(400)
  })
})

describe('DELETE /api/whatsapp/evolution/connect', () => {
  beforeEach(() => {
    h.deleteCalls = []
    h.accountId = 'acc-1'
    h.authUser = { id: 'user-1' }
  })

  it('logs out the instance and deletes the config row', async () => {
    const res = await DELETE()
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.logoutInstance).toHaveBeenCalledWith({ instanceToken: 'raw-token' })
    expect(h.deleteCalls).toEqual(['acc-1'])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/app/api/whatsapp/evolution/connect/route.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `evolution/connect/route.ts`**

Both handlers reuse the account's own RLS-scoped `supabase` client (from `@/lib/supabase/server`) for every `whatsapp_config` read/write — the same client Meta's `config/route.ts` GET uses — so the table's existing admin-only write RLS policy (migration 017) is enforced for free; no separate service-role client is needed here.

```ts
// src/app/api/whatsapp/evolution/connect/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createInstance, connectInstance, logoutInstance } from '@/lib/whatsapp/evolution-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { resolveAccountId } from '@/app/api/whatsapp/config/resolve-account'

function webhookUrl(): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/api/whatsapp-evolution/webhook`
}

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 400 },
    )
  }

  const { instanceId, instanceToken } = await createInstance({ name: accountId })
  await connectInstance({
    instanceToken,
    webhookUrl: webhookUrl(),
    subscribe: ['MESSAGE', 'CONNECTION', 'QRCODE'],
  })

  const { error } = await supabase
    .from('whatsapp_config')
    .upsert(
      {
        account_id: accountId,
        provider: 'evolution',
        evolution_instance_id: instanceId,
        evolution_instance_token: encrypt(instanceToken),
        status: 'connecting',
      },
      { onConflict: 'account_id' },
    )

  if (error) {
    console.error('[evolution-connect] failed to save config:', error)
    return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

export async function DELETE() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 400 },
    )
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('evolution_instance_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (config?.evolution_instance_token) {
    try {
      await logoutInstance({ instanceToken: decrypt(config.evolution_instance_token) })
    } catch (err) {
      // Best-effort — still remove our local record even if the
      // remote logout fails (e.g. instance already gone).
      console.warn('[evolution-connect] logoutInstance failed:', err)
    }
  }

  const { error } = await supabase.from('whatsapp_config').delete().eq('account_id', accountId)
  if (error) {
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/api/whatsapp/evolution/connect/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write failing tests for `qr/route.ts`**

```ts
// src/app/api/whatsapp/evolution/qr/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getQrCode: vi.fn(async () => ({ qrCodePng: 'data:image/png;base64,AAA', code: '2@abc' })),
  accountId: 'acc-1' as string | null,
  authUser: { id: 'user-1' } as { id: string } | null,
}))

vi.mock('next/server', () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ body: b, init: i }) },
}))
vi.mock('@/lib/whatsapp/evolution-api', () => ({ getQrCode: h.getQrCode }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace('enc-', '') }))
vi.mock('@/app/api/whatsapp/config/resolve-account', () => ({
  resolveAccountId: vi.fn(async () => h.accountId),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: h.authUser },
        error: h.authUser ? null : { message: 'no user' },
      })),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: { evolution_instance_token: 'enc-raw-token' }, error: null }),
        }),
      }),
    }),
  })),
}))

import { GET } from './route'

describe('GET /api/whatsapp/evolution/qr', () => {
  beforeEach(() => {
    h.accountId = 'acc-1'
    h.authUser = { id: 'user-1' }
  })

  it("returns the QR code for the account's instance", async () => {
    const res = await GET()
    expect((res as { body?: unknown }).body).toEqual({ qrCodePng: 'data:image/png;base64,AAA', code: '2@abc' })
    expect(h.getQrCode).toHaveBeenCalledWith({ instanceToken: 'raw-token' })
  })

  it('returns 401 without an authenticated caller', async () => {
    h.authUser = null
    const res = await GET()
    expect((res as { init?: { status?: number } }).init?.status).toBe(401)
  })
})
```

- [ ] **Step 7: Implement `evolution/qr/route.ts`**

```ts
// src/app/api/whatsapp/evolution/qr/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getQrCode } from '@/lib/whatsapp/evolution-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveAccountId } from '@/app/api/whatsapp/config/resolve-account'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 400 },
    )
  }

  const { data: config, error } = await supabase
    .from('whatsapp_config')
    .select('evolution_instance_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !config?.evolution_instance_token) {
    return NextResponse.json({ error: 'No Evolution Go instance connected' }, { status: 404 })
  }

  const { qrCodePng, code } = await getQrCode({ instanceToken: decrypt(config.evolution_instance_token) })
  return NextResponse.json({ qrCodePng, code })
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/app/api/whatsapp/evolution/qr/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Branch `GET /api/whatsapp/config` by provider**

The real current `GET` handler (`src/app/api/whatsapp/config/route.ts` lines 63–100) is:

```ts
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, status')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 }
      )
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    ...
```

Two changes:

1. Widen the `select` to also fetch the two new columns:

```ts
      .select('phone_number_id, access_token, status, provider, evolution_instance_name')
```

2. Right after the `if (!config) { ... }` block and before the `// Try to decrypt...` comment, insert:

```ts
    if (config.provider === 'evolution') {
      return NextResponse.json({
        connected: config.status === 'connected',
        provider: 'evolution' as const,
        instance_name: config.evolution_instance_name ?? null,
      })
    }
```

This returns before any Meta-specific code runs (the decrypt + `verifyPhoneNumber` call below it), so the existing Meta branch is untouched for `provider === 'meta'` rows (including every row written before this migration, since the column defaults to `'meta'`).

`config.status` needs to actually reach `'connected'` for this to work — Task 4's webhook route currently only handles the `Message` event. Add the `Connected`/`PairSuccess` handling now: in `src/app/api/whatsapp-evolution/webhook/route.ts`, the `if (body.event !== 'Message')` branch becomes:

```ts
  if (body.event === 'Connected' || body.event === 'PairSuccess') {
    await supabaseAdmin()
      .from('whatsapp_config')
      .update({ status: 'connected', connected_at: new Date().toISOString() })
      .eq('id', config.id)
    return NextResponse.json({ status: 'ok' }, { status: 200 })
  }
  if (body.event !== 'Message') {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }
```

- [ ] **Step 10: Write a test for the `Connected` event and the config branch**

Add to `src/app/api/whatsapp-evolution/webhook/route.test.ts`:

```ts
  it("marks the config connected on a Connected event", async () => {
    const res = await POST(
      inboundRequest({
        event: 'Connected',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: { status: 'open', jid: '5511999999999:5@s.whatsapp.net' },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
  })
```

(This asserts the route still 200s; the `whatsapp_config` mock's `update` chain needs a stub — add `update: () => ({ eq: () => Promise.resolve({ error: null }) })` to the `whatsapp_config` case in the shared `@supabase/supabase-js` mock at the top of the file.)

For `config/route.ts`'s new branch, no new test file is created (the file has none today) — verify manually with `npm run build` (type-checks the new branch) plus the manual end-to-end check in Task 6.

- [ ] **Step 11: Run the full suite**

Run: `npx vitest run`
Expected: PASS, including the updated Evolution webhook tests.

- [ ] **Step 12: Commit**

```bash
git add src/app/api/whatsapp/evolution src/app/api/whatsapp/config/resolve-account.ts src/app/api/whatsapp/config/route.ts src/app/api/whatsapp-evolution/webhook/route.ts src/app/api/whatsapp-evolution/webhook/route.test.ts
git commit -m "feat(whatsapp): add Evolution Go connect/QR routes and provider-aware config status"
```

---

### Task 6: Settings UI — provider selector + Evolution Go QR connect flow

**Files:**
- Create: `src/components/settings/evolution-go-config.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx`

**Interfaces:**
- Consumes: `GET /api/whatsapp/config` (provider-aware, Task 5), `POST`/`DELETE /api/whatsapp/evolution/connect` (Task 5), `GET /api/whatsapp/evolution/qr` (Task 5).

- [ ] **Step 1: Build `EvolutionGoConfig`**

```tsx
// src/components/settings/evolution-go-config.tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

type Status = 'idle' | 'connecting' | 'connected' | 'error'

export function EvolutionGoConfig() {
  const [status, setStatus] = useState<Status>('idle')
  const [qrCodePng, setQrCodePng] = useState<string | null>(null)
  const [instanceName, setInstanceName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const checkStatus = useCallback(async () => {
    const res = await fetch('/api/whatsapp/config')
    if (!res.ok) return
    const data = await res.json()
    if (data.connected) {
      setStatus('connected')
      setInstanceName(data.instance_name ?? null)
      stopPolling()
    }
  }, [stopPolling])

  useEffect(() => {
    checkStatus()
    return stopPolling
  }, [checkStatus, stopPolling])

  async function handleConnect() {
    setError(null)
    setStatus('connecting')
    try {
      const connectRes = await fetch('/api/whatsapp/evolution/connect', { method: 'POST' })
      if (!connectRes.ok) throw new Error('Falha ao criar instância')

      const qrRes = await fetch('/api/whatsapp/evolution/qr')
      if (!qrRes.ok) throw new Error('Falha ao buscar QR Code')
      const { qrCodePng } = await qrRes.json()
      setQrCodePng(qrCodePng)

      pollRef.current = setInterval(checkStatus, 3000)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Erro desconhecido')
    }
  }

  async function handleDisconnect() {
    stopPolling()
    await fetch('/api/whatsapp/evolution/connect', { method: 'DELETE' })
    setStatus('idle')
    setQrCodePng(null)
    setInstanceName(null)
  }

  if (status === 'connected') {
    return (
      <Card className="p-6 space-y-3">
        <p className="text-sm font-medium">Conectado via Evolution Go</p>
        {instanceName && <p className="text-sm text-muted-foreground">{instanceName}</p>}
        <Button variant="outline" onClick={handleDisconnect}>Desconectar</Button>
      </Card>
    )
  }

  return (
    <Card className="p-6 space-y-4">
      <p className="text-sm text-muted-foreground">
        Conecte um número de WhatsApp escaneando o QR Code com o celular
        (WhatsApp → Aparelhos conectados → Conectar um aparelho).
      </p>
      {qrCodePng ? (
        <div className="flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrCodePng} alt="QR Code de conexão" className="w-56 h-56" />
          <p className="text-xs text-muted-foreground">Aguardando leitura do QR Code…</p>
        </div>
      ) : (
        <Button onClick={handleConnect} disabled={status === 'connecting'}>
          {status === 'connecting' ? 'Gerando QR Code…' : 'Conectar via QR Code'}
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Card>
  )
}
```

- [ ] **Step 2: Add the provider selector to `whatsapp-config.tsx`**

Read the current file's state block (lines 49–90) and return block (lines 395–397) before editing. Add:

```tsx
import { EvolutionGoConfig } from './evolution-go-config'
// ...
const [provider, setProvider] = useState<'meta' | 'evolution'>(
  config?.provider === 'evolution' ? 'evolution' : 'meta',
)
```

Seed `provider` from the loaded config inside the existing `fetchConfig` function (wherever it currently does `setConfig(data)` or equivalent) by also calling `setProvider(data.provider === 'evolution' ? 'evolution' : 'meta')`.

In the return block, right after `<SettingsPanelHead .../>` and before the existing `<div className="space-y-6">` two-column grid, add:

```tsx
<div className="flex gap-2 border-b pb-4 mb-6">
  <Button
    variant={provider === 'meta' ? 'default' : 'outline'}
    onClick={() => setProvider('meta')}
  >
    Meta Cloud API
  </Button>
  <Button
    variant={provider === 'evolution' ? 'default' : 'outline'}
    onClick={() => setProvider('evolution')}
  >
    Evolution Go (QR Code)
  </Button>
</div>
{provider === 'evolution' ? (
  <EvolutionGoConfig />
) : (
  <div className="space-y-6">
    {/* existing two-column grid — wrap the current lines 398–836 here unchanged */}
  </div>
)}
```

Everything currently in the two-column grid (Alert banners, API Credentials Card, Webhook URL Card, action buttons, setup-instructions Accordion) moves inside the `provider === 'meta'` branch **unchanged** — this is a wrap, not a rewrite; do not edit any JSX inside that block.

- [ ] **Step 3: Manual verification (no jsdom/testing-library in this repo — see `src/components/ui/dropdown-menu-group-label.test.tsx` for the one existing narrow exception, which doesn't apply here)**

Run: `npm run dev`, sign in, go to Settings → WhatsApp.
Checklist:
- Meta tab still shows the existing form and still saves/tests/verifies exactly as before (this is the regression check for this task — no code inside the Meta branch changed, only its wrapper).
- Evolution Go tab shows the "Conectar via QR Code" button.
- Clicking it calls `POST /api/whatsapp/evolution/connect` then `GET /api/whatsapp/evolution/qr` (watch Network tab) and renders a QR image.
- If you have a real Evolution Go server + a spare WhatsApp number: scan the QR, confirm the page flips to "Conectado" within ~3s of the scan (polling interval) without a manual refresh.
- Disconnect removes the config row (`DELETE /api/whatsapp/evolution/connect` in Network tab) and returns the tab to the "Conectar" state.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/evolution-go-config.tsx src/components/settings/whatsapp-config.tsx
git commit -m "feat(whatsapp): add provider selector and Evolution Go QR connect flow to settings"
```

---

### Task 7: Inbox send path — provider branch in `send-message.ts`

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts`
- Test: `src/lib/whatsapp/send-message.test.ts` (existing file — add cases, don't remove any)

**Interfaces:**
- Consumes: `sendTextMessage`, `sendMediaMessage` from `@/lib/whatsapp/evolution-api` (Task 2).

- [ ] **Step 1: Read the existing `attempt` closure (lines 339–403) and config fetch (lines 254–269) before editing** — already quoted in full in this plan's research; re-read the live file to catch any drift before touching it.

- [ ] **Step 2: Write the failing tests**

The existing file already has a `sendPathDb(templateRows, captured)` helper (added for issue #483) that fakes the `conversations`/`whatsapp_config`/`messages`/`message_templates` chains and mocks `@/lib/whatsapp/meta-api`. Add a sibling helper and mock for the Evolution branch, near the bottom of `src/lib/whatsapp/send-message.test.ts`:

```ts
// ============================================================
// Evolution Go provider branch
// ============================================================

vi.mock('@/lib/whatsapp/evolution-api', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'evo.text.1' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'evo.media.1' })),
}));

import {
  sendTextMessage as evolutionSendTextMessage,
  sendMediaMessage as evolutionSendMediaMessage,
} from '@/lib/whatsapp/evolution-api';

/** Same shape as sendPathDb above, but the config row is Evolution Go's. */
function sendPathDbEvolution(captured: CapturedWrites): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact: { id: 'ct-1', phone: '+15551234567' },
  };
  const config = {
    id: 'cfg-1',
    provider: 'evolution',
    evolution_instance_token: 'evo-token',
  };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => {
          if (table === 'conversations') return { data: conversation, error: null };
          if (table === 'whatsapp_config') return { data: config, error: null };
          if (table === 'messages') return { data: { id: 'msg-1' }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: [], error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('sendMessageToConversation — Evolution Go provider', () => {
  it('sends a text message via evolution-api.sendTextMessage, not Meta', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDbEvolution(captured),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'oi' }
    );
    expect(result.whatsappMessageId).toBe('evo.text.1');
    // sanitizePhoneForMeta strips the '+' — see src/lib/whatsapp/phone-utils.ts.
    expect(evolutionSendTextMessage).toHaveBeenCalledWith({
      instanceToken: 'evo-token',
      to: '15551234567',
      text: 'oi',
    });
  });

  it('sends a media message via evolution-api.sendMediaMessage', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDbEvolution(captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'image',
        mediaUrl: 'https://cdn.example.com/x.jpg',
      }
    );
    expect(result.whatsappMessageId).toBe('evo.media.1');
    expect(evolutionSendMediaMessage).toHaveBeenCalledWith({
      instanceToken: 'evo-token',
      to: '15551234567',
      kind: 'image',
      link: 'https://cdn.example.com/x.jpg',
      caption: undefined,
      filename: undefined,
    });
  });

  it('rejects messageType "template" for an evolution provider with a clear error', async () => {
    await expect(
      sendMessageToConversation(sendPathDbEvolution({}), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
      })
    ).rejects.toMatchObject({ code: 'provider_unsupported' });
  });

  it('rejects messageType "interactive" for an evolution provider with a clear error', async () => {
    await expect(
      sendMessageToConversation(sendPathDbEvolution({}), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'A' }],
        },
      })
    ).rejects.toMatchObject({ code: 'provider_unsupported' });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Expected: FAIL — provider branch doesn't exist yet.

- [ ] **Step 4: Implement the provider branch**

In `src/lib/whatsapp/send-message.ts`:

1. Add to imports:
```ts
import {
  sendTextMessage as evolutionSendTextMessage,
  sendMediaMessage as evolutionSendMediaMessage,
} from '@/lib/whatsapp/evolution-api';
```

2. Replace the `attempt` closure (previously lines 339–403) with:

```ts
  const attempt = async (phone: string): Promise<string> => {
    if (config.provider === 'evolution') {
      if (messageType === 'template') {
        throw new SendMessageError(
          'provider_unsupported',
          'Evolution Go não usa templates aprovados — envie como mensagem de texto.',
          400,
        );
      }
      if (messageType === 'interactive') {
        throw new SendMessageError(
          'provider_unsupported',
          'Botões/listas interativos não são suportados pelo Evolution Go.',
          400,
        );
      }
      const instanceToken = decrypt(config.evolution_instance_token);
      if (isMediaKind) {
        const result = await evolutionSendMediaMessage({
          instanceToken,
          to: phone,
          kind: messageType as MediaKind,
          link: mediaUrl!,
          caption: contentText || undefined,
          filename: filename || undefined,
        });
        return result.messageId;
      }
      const result = await evolutionSendTextMessage({
        instanceToken,
        to: phone,
        text: contentText!,
      });
      return result.messageId;
    }

    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };
```

3. Just above the config fetch (before line 269's `const accessToken = decrypt(config.access_token);`), guard the Meta-only decrypt/self-heal block so it's skipped for Evolution rows:

```ts
  const accessToken = config.provider === 'evolution' ? '' : decrypt(config.access_token);

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (config.provider !== 'evolution' && isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }
```

(`accessToken` stays declared either way since the Meta branches below reference it — for `provider === 'evolution'` it's simply unused, since the new branch reads `config.evolution_instance_token` instead.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Expected: PASS — original Meta test cases unchanged and passing, plus the new Evolution cases from Step 2.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp/send-message.ts src/lib/whatsapp/send-message.test.ts
git commit -m "feat(whatsapp): send Inbox messages via Evolution Go when the account's provider is evolution"
```

---

## After this plan

Plan A is a complete, testable increment: an account can pick Evolution Go, scan a QR code, and use the Inbox (text + media, both directions) exactly like a Meta-connected account, with zero behavior change for existing Meta accounts. **Plan B** (separate plan, written after this one ships) adds the provider branch to `src/lib/automations/meta-send.ts`, `src/lib/flows/meta-send.ts`, and `src/lib/whatsapp/broadcast-core.ts`/`broadcast-resume.ts` (using `renderTemplateBody` from `src/lib/whatsapp/template-body.ts`, which already exists, to turn a template's body + `template_params` into free-form text for Evolution sends) — those three files are untouched by this plan.
