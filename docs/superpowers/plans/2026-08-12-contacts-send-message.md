# "Enviar mensagem" from Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Enviar mensagem" item to `/contacts`'s row menu that opens the Inbox with that contact's conversation already selected, so accounts on any provider (Meta or Evolution Go) can start a plain-text conversation from Contacts — not just via the existing Meta-template-only flow.

**Architecture:** A new `POST /api/contacts/[id]/conversation` route finds-or-creates the contact's conversation (extracting the existing find-or-create logic out of `/api/whatsapp/send`'s local helper into a shared module) and returns its id; the Contacts page calls it, then navigates to the Inbox's existing `?c=<conversation_id>` deep link. No changes to the Inbox page itself.

**Tech Stack:** Next.js 16 App Router, Supabase (RLS-scoped client via `@/lib/supabase/server`), Vitest, next-intl.

## Global Constraints

- Auth gate: `requireRole('agent')` on the backend, matching `useCan('send-messages')` on the frontend — the same pairing already used by `/api/whatsapp/send`'s `contact_id` path and the `messages_modify` RLS policy (migration 017).
- No hardcoded UI strings — all new labels go through this page's existing `Contacts.page` i18n namespace (`useTranslations('Contacts.page')`), added to all three locale files: `messages/en.json`, `messages/ko.json`, `messages/pt-BR.json`.
- The extraction in Task 1 must not change `/api/whatsapp/send`'s behavior — its existing test suite (`src/app/api/whatsapp/send/route.test.ts`) must pass unmodified.

---

### Task 1: Extract `findOrCreateConversation` into a shared module

**Files:**
- Create: `src/lib/whatsapp/find-or-create-conversation.ts`
- Modify: `src/app/api/whatsapp/send/route.ts`

**Interfaces:**
- Produces: `findOrCreateConversation(supabase, accountId: string, userId: string, contactId: string): Promise<string | null>` — Task 2's new route imports this.

**Why this task exists:** `src/app/api/whatsapp/send/route.ts` already has a local, non-exported `findOrCreateConversation` for its own `contact_id` path (Contact detail → Send template). Task 2 needs the exact same find-or-create behavior for the new "Enviar mensagem" route. Rather than a second copy-paste, this task moves it to a shared module first, **without changing its behavior** — `src/app/api/whatsapp/send/route.test.ts` is the regression gate: it drives the route's `contact_id` path end-to-end through mocked Supabase calls and must pass **unmodified** afterward.

- [ ] **Step 1: Read the current file before editing**

Read `src/app/api/whatsapp/send/route.ts` in full (233 lines) to confirm it still matches what's quoted below — if it's drifted, adapt this task's diff to the real current content rather than applying it blindly.

- [ ] **Step 2: Create the shared module**

```ts
// src/lib/whatsapp/find-or-create-conversation.ts
import type { createClient } from '@/lib/supabase/server'

type ScopedSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 */
export async function findOrCreateConversation(
  supabase: ScopedSupabase,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating conversation for contact:', error.message)
    return null
  }

  return created.id
}
```

This is byte-for-byte the same logic as the function being removed in Step 3 — only its location and export status change.

- [ ] **Step 3: Remove the local copy from `send/route.ts` and import the shared one**

In `src/app/api/whatsapp/send/route.ts`:

1. Delete the now-unused `import { createClient } from '@/lib/supabase/server'` at the top (line 2) — it was only ever used for the `SendSupabase` type alias being removed below, and removing it without deleting the import would leave an unused-import lint error.

2. Add this import alongside the existing ones (e.g. right after the `@/lib/whatsapp/send-message` import):

```ts
import { findOrCreateConversation } from '@/lib/whatsapp/find-or-create-conversation'
```

3. Delete the entire trailing block (the `SendSupabase` type alias and the local `findOrCreateConversation` function — everything from the `type SendSupabase = ...` line to the end of the file):

```ts
type SendSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating conversation for contact send:', error.message)
    return null
  }

  return created.id
}
```

The call site inside `POST` (`const resolved = await findOrCreateConversation(supabase, accountId, userId, contact_id)`) needs no change — the imported function has the identical signature.

- [ ] **Step 4: Verify the regression gate passes unmodified**

Run: `npx vitest run src/app/api/whatsapp/send/route.test.ts`
Expected: PASS, all 6 tests, with **zero edits to that test file**. If anything fails, the extraction introduced a behavior change — find and fix it before proceeding; do not edit the test to make it pass.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: clean — confirms the new module's exported type and `send/route.ts`'s updated imports all line up.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/find-or-create-conversation.ts src/app/api/whatsapp/send/route.ts
git commit -m "refactor(whatsapp): extract findOrCreateConversation into a shared module"
```

---

### Task 2: `POST /api/contacts/[id]/conversation`

**Files:**
- Create: `src/app/api/contacts/[id]/conversation/route.ts`
- Test: `src/app/api/contacts/[id]/conversation/route.test.ts`

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` from `@/lib/auth/account` (Task 1's constraints section — already exists, unchanged by this plan); `findOrCreateConversation` from `@/lib/whatsapp/find-or-create-conversation` (Task 1).
- Produces: `POST /api/contacts/[id]/conversation` — this is the endpoint Task 3's frontend button calls.

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/contacts/[id]/conversation/route.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  findOrCreateConversation: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) => {
    const status =
      err instanceof Error && 'status' in err
        ? (err as Error & { status: number }).status
        : 500
    return Response.json({ error: (err as Error).message }, { status })
  }),
}))

vi.mock('@/lib/whatsapp/find-or-create-conversation', () => ({
  findOrCreateConversation: mocks.findOrCreateConversation,
}))

import { POST } from './route'

// Mirrors the shape requireRole's real AccountContext returns — see
// src/lib/auth/account.ts. `supabase` here is a minimal fake exercising
// only the `contacts` lookup this route performs directly.
let contactRow: { id: string } | null = { id: 'contact-1' }

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table !== 'contacts') throw new Error(`unexpected table: ${table}`)
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: contactRow, error: null }),
      }
      return builder
    },
  }
}

const context = {
  supabase: makeSupabase(),
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
}

const params = { params: Promise.resolve({ id: 'contact-1' }) }

function request() {
  return new Request('http://localhost/api/contacts/contact-1/conversation', {
    method: 'POST',
  })
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.findOrCreateConversation.mockReset()
  mocks.requireRole.mockResolvedValue({ ...context, supabase: makeSupabase() })
  contactRow = { id: 'contact-1' }
})

describe('POST /api/contacts/[id]/conversation', () => {
  it('finds-or-creates the conversation and returns its id', async () => {
    mocks.findOrCreateConversation.mockResolvedValue('conv-1')

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ conversation_id: 'conv-1' })
    expect(mocks.requireRole).toHaveBeenCalledWith('agent')
    expect(mocks.findOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      'user-1',
      'contact-1',
    )
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null
    mocks.requireRole.mockResolvedValue({ ...context, supabase: makeSupabase() })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(mocks.findOrCreateConversation).not.toHaveBeenCalled()
  })

  it('500s when findOrCreateConversation fails', async () => {
    mocks.findOrCreateConversation.mockResolvedValue(null)

    const res = await POST(request(), params)
    expect(res.status).toBe(500)
  })

  it('propagates requireRole auth failures via toErrorResponse', async () => {
    class ForbiddenError extends Error {
      status = 403
    }
    mocks.requireRole.mockRejectedValue(new ForbiddenError('Forbidden'))

    const res = await POST(request(), params)
    expect(res.status).toBe(403)
    expect(mocks.findOrCreateConversation).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/contacts/[id]/conversation/route.test.ts`
Expected: FAIL — `./route` doesn't exist yet.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/contacts/[id]/conversation/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { findOrCreateConversation } from '@/lib/whatsapp/find-or-create-conversation'

/**
 * Finds or creates the conversation for a contact, without sending any
 * message — used by the Contacts page's "Enviar mensagem" action to
 * resolve a conversation id before deep-linking into the Inbox
 * (`/inbox?c=<conversation_id>`), so a plain-text send goes through the
 * Inbox composer (which already handles both the Meta and Evolution Go
 * providers) instead of the Contact detail view's Meta-template-only
 * send flow.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id: contactId } = await params

    // Verify the contact is in this account first so a caller can't open
    // a conversation against another account's contact.
    const { data: contactRow, error: contactErr } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (contactErr || !contactRow) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const conversationId = await findOrCreateConversation(
      supabase,
      accountId,
      userId,
      contactId,
    )
    if (!conversationId) {
      return NextResponse.json(
        { error: 'Failed to open a conversation for this contact' },
        { status: 500 },
      )
    }

    return NextResponse.json({ conversation_id: conversationId })
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/contacts/[id]/conversation/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/contacts/[id]/conversation/route.ts src/app/api/contacts/[id]/conversation/route.test.ts
git commit -m "feat(contacts): add find-or-create conversation endpoint"
```

---

### Task 3: "Enviar mensagem" menu item in `/contacts`

**Files:**
- Modify: `src/app/(dashboard)/contacts/page.tsx`
- Modify: `messages/en.json`, `messages/ko.json`, `messages/pt-BR.json`

**Interfaces:**
- Consumes: `POST /api/contacts/[id]/conversation` (Task 2) → `{ conversation_id: string }`; the Inbox's existing `?c=<conversation_id>` deep link (`src/app/(dashboard)/inbox/page.tsx`, unchanged by this plan).

- [ ] **Step 1: Add the three i18n keys to all three locale files**

In `messages/en.json`, find line 330 (`"editAction": "Edit",`) and insert immediately before it:

```json
      "sendMessageAction": "Send message",
      "sendMessageGated": "Read-only — your role can't send messages",
```

In `messages/pt-BR.json`, find line 330 (`"editAction": "Editar",`) and insert immediately before it:

```json
      "sendMessageAction": "Enviar mensagem",
      "sendMessageGated": "Somente leitura — sua função não pode enviar mensagens",
```

In `messages/ko.json`, find line 330 (`"editAction": "수정",`) and insert immediately before it:

```json
      "sendMessageAction": "메시지 보내기",
      "sendMessageGated": "읽기 전용 — 현재 역할로는 메시지를 보낼 수 없습니다",
```

(`sendMessageGated`'s wording matches this codebase's existing `Inbox.composer.readOnlyTitle` string for the same `send-messages` gate — see `messages/en.json:191`, `messages/pt-BR.json:191`, `messages/ko.json:191` — kept in this page's own `Contacts.page` namespace since `t()` here can't reach the `Inbox` namespace.)

- [ ] **Step 2: Verify the i18n parity test still passes**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS (4 tests) — confirms all three locale files stayed in sync after the manual edits above.

- [ ] **Step 3: Add `useRouter` and the `MessageSquare` icon import**

In `src/app/(dashboard)/contacts/page.tsx`, line 4 currently reads:

```ts
import { createClient } from '@/lib/supabase/client';
```

Add a new import line right after it:

```ts
import { useRouter } from 'next/navigation';
```

In the `lucide-react` import block (lines 38–52), add `MessageSquare` to the list:

```ts
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  MessageSquare,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  X,
} from 'lucide-react';
```

- [ ] **Step 4: Declare the router inside the component**

At line 69, right after `const supabase = createClient();`, add:

```ts
  const router = useRouter();
```

So the block (lines 68–71) reads:

```ts
  const t = useTranslations('Contacts.page');
  const supabase = createClient();
  const router = useRouter();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
```

- [ ] **Step 5: Add the handler function**

Right after the component's hook declarations (after the `canEditSettings` line, before the rest of the component body — the exact insertion point doesn't matter as long as it's inside `ContactsPage` and defined before the JSX that references it), add:

```ts
  async function handleSendMessage(contact: ContactWithTags) {
    try {
      const res = await fetch(`/api/contacts/${contact.id}/conversation`, {
        method: 'POST',
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Failed to open conversation');
      }
      router.push(`/inbox?c=${body.conversation_id}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to open conversation',
      );
    }
  }
```

- [ ] **Step 6: Add the menu item**

In the `DropdownMenuContent` block (currently lines 661–686), the existing content is:

```tsx
                      <DropdownMenuContent
                        align="end"
                        className="bg-popover border-border"
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          {t('editAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
```

Replace it with (adds "Enviar mensagem" as the first item, gated the same way the page gates bulk-delete):

```tsx
                      <DropdownMenuContent
                        align="end"
                        className="bg-popover border-border"
                      >
                        <DropdownMenuItem
                          disabled={!canEdit}
                          title={!canEdit ? t('sendMessageGated') : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!canEdit) return;
                            handleSendMessage(contact);
                          }}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <MessageSquare className="size-4" />
                          {t('sendMessageAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          {t('editAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Lint**

Run: `npx eslint src/app/\(dashboard\)/contacts/page.tsx`
Expected: no new warnings (the file may already have pre-existing warnings unrelated to this change — do not fix those, only confirm this change adds none).

- [ ] **Step 9: Manual verification (no jsdom/testing-library component-rendering tests in this repo)**

Run: `npm run dev`, sign in, go to `/contacts`.
Checklist:
- The row menu's first item is "Enviar mensagem" (or the active locale's translation), above "Editar".
- As an account-owner/admin/agent: clicking it navigates to `/inbox?c=<some-uuid>` and that conversation is selected in the Inbox.
- Clicking it again for the same contact reuses the same conversation (same `c=` value) rather than creating a duplicate.
- As a 'viewer' (if you have a test account with that role): the item is visibly disabled, and hovering shows the "Read-only" tooltip; clicking it does nothing.

- [ ] **Step 10: Run the full suite**

Run: `npx vitest run`
Expected: PASS — the only allowed failures are the pre-existing, unrelated `src/lib/dashboard/date-utils.test.ts` timezone-dependent tests (2 failures in this sandbox's `America/Manaus` timezone; they pass on CI's UTC runner). No other new failures.

- [ ] **Step 11: Commit**

```bash
git add src/app/\(dashboard\)/contacts/page.tsx messages/en.json messages/ko.json messages/pt-BR.json
git commit -m "feat(contacts): add Enviar mensagem action that opens the Inbox chat"
```

---

## After this plan

Push the branch and open a PR against `main` (this repo's convention throughout the Evolution Go work earlier — see `docs/superpowers/plans/2026-08-11-evolution-go-connection-inbox.md` for the same pattern), or merge directly if working solo on a fast-moving `main` as has been the practice in this session. Run `npx vitest run`, `npx tsc --noEmit`, and `npm run build` one more time on the final state before pushing, matching the verification level used for every prior change in this session.
