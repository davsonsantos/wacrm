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
  /**
   * MIME type of `mediaUrl`'s content (messages.media_type, migration
   * 039 on main / issue #466). Optional — providers without a MIME
   * type available (e.g. Evolution Go's webhook, Task 4) omit it and
   * the column is simply left null for that row.
   */
  mediaType?: string | null
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
        media_type: content.mediaType ?? null,
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
