# "Enviar mensagem" from Contacts — Design

## Problem

`/contacts`'s row menu offers "Editar" and "Excluir" only. The one existing
way to message a contact from this page is `ContactDetailView`'s "Send
template" flow, which is Meta-only (WhatsApp Cloud API approved templates).
Accounts connected via Evolution Go (the unofficial, QR-code provider added
in `docs/superpowers/specs/2026-08-11-evolution-go-integration-design.md`)
have no template concept — there is currently no way to message a contact
from Contacts on those accounts at all.

## Approach

Add an "Enviar mensagem" item to the row menu that resolves (or creates) the
contact's conversation and navigates to the Inbox with it selected, instead
of building a second message composer inside Contacts. The Inbox's composer
already sends plain text correctly for both providers (`sendMessageToConversation`
in `src/lib/whatsapp/send-message.ts` already branches on `provider`), so this
reuses that path rather than duplicating it.

## Backend: `POST /api/contacts/[id]/conversation`

New route. Finds or creates the conversation for a contact and returns its id
— no message is sent by this call.

- **Auth:** `requireRole('agent')`, matching `useCan('send-messages')` on the
  frontend and the `messages_modify` RLS policy (migration 017) — the same
  gate `/api/whatsapp/send` already uses for its `contact_id` path.
- **Request:** no body needed; `id` comes from the route param.
- **Behavior:**
  1. Verify the contact belongs to the caller's account (`contacts` table,
     `id` + `account_id`) — 404 if not found, so a caller can't open a
     conversation against another account's contact.
  2. Find-or-create the conversation for that contact, under the caller's
     RLS-scoped client (same as any inbox-initiated conversation).
  3. Return `{ conversation_id }`.
- **Errors:** 401 unauthenticated, 403 insufficient role, 404 contact not
  found, 500 on a find-or-create failure.

### Shared helper extraction

`src/app/api/whatsapp/send/route.ts` already has a local, non-exported
`findOrCreateConversation(supabase, accountId, userId, contactId)` for its
own `contact_id` path (Contact detail → Send template). This second call
site is reason enough to extract it into `src/lib/whatsapp/find-or-create-conversation.ts`,
exporting the one function; `send/route.ts` switches to the import instead of
its local copy. No behavior change to the existing route — this is a pure
extraction, verified by that route's existing test suite passing unmodified.

(This is a distinct helper from `findOrCreateConversation` in
`src/lib/whatsapp/inbound-message.ts` — that one is admin/service-role-scoped
for webhook-driven creation and is not touched by this change.)

## Frontend: `/contacts`

- New `DropdownMenuItem` in the row menu, `MessageSquare` icon (matching the
  icon already used for messaging elsewhere, e.g. `quick-reply-picker.tsx`),
  positioned **first**, before "Editar" — the most common action a user
  reaches for on a contact row.
- Label and gated-tooltip text are new keys under the page's own
  `Contacts.page` i18n namespace (`t = useTranslations('Contacts.page')`,
  same as `editAction`/`deleteAction` — no hardcoded strings), added to
  `messages/en.json`, `messages/ko.json`, `messages/pt-BR.json`:
  - `sendMessageAction`: `"Send message"` / `"Enviar mensagem"`
  - `sendMessageGated`: `"Read-only — your role can't send messages"` /
    `"Somente leitura — sua função não pode enviar mensagens"` — reusing
    the existing English wording from `Inbox.composer.readOnlyTitle`
    (same underlying gate, `send-messages`), just placed in this page's
    own namespace since `Contacts.page`'s `t()` can't reach across
    namespaces without a second `useTranslations` call.
- Gated by the same `canEdit` (`useCan('send-messages')`) value the page
  already computes for "Excluir contatos". When `false`: item is disabled
  with a `title` tooltip of `t('sendMessageGated')`, rather than hiding the
  item entirely — consistent with how Delete is gated on this same page.
- `onClick`: `POST /api/contacts/[id]/conversation`, then
  `router.push('/inbox?c=' + conversation_id)`. `useRouter` is not currently
  imported in `contacts/page.tsx` — added for this.
- On request failure: `toast.error(...)`, matching this page's existing
  error-toast usage. No optimistic navigation — wait for the conversation id
  before routing.

## Out of scope

- No changes to `ContactDetailView`'s existing template-send flow — it stays
  as the Meta-template-specific path it already is.
- No changes to the Inbox page itself — its existing `?c=<conversation_id>`
  deep link already does exactly what's needed once a valid, already-loaded-or-loadable
  conversation id is passed.
- No bulk "send message" action for multi-selected contacts — this is a
  single-contact, single-conversation action only.
