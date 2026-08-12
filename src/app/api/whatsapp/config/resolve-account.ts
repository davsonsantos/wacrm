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
