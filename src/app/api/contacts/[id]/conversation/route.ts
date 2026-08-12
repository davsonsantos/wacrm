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
