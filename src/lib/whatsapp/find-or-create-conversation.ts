import type { createClient } from '@/lib/supabase/server'

import { isUniqueViolation } from '@/lib/contacts/dedupe'

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
    // Lost a race against a concurrent create (e.g. an inbound webhook
    // message arriving at the same moment) — the unique index (migration
    // 036) rejected the duplicate. Re-resolve to the winning row instead
    // of failing the caller.
    if (isUniqueViolation(error)) {
      const { data: raced } = await supabase
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) return raced[0].id
    }

    console.error('Error creating conversation for contact:', error.message)
    return null
  }

  return created.id
}
