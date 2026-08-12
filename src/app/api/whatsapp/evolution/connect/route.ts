import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createInstance, connectInstance, logoutInstance } from '@/lib/whatsapp/evolution-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { resolveAccountId } from '@/app/api/whatsapp/config/resolve-account'

function webhookUrl(): string {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  if (!siteUrl) {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL is required to register the Evolution Go webhook',
    )
  }
  return `${siteUrl.replace(/\/+$/, '')}/api/whatsapp-evolution/webhook`
}

/**
 * POST /api/whatsapp/evolution/connect
 *
 * Creates a new Evolution Go instance for the caller's account, starts
 * the connect flow (registering our inbound webhook + event
 * subscriptions), and saves the encrypted instance token as the
 * account's whatsapp_config row. The settings page then polls
 * GET /api/whatsapp/evolution/qr for the QR to display.
 */
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
        user_id: user.id,
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

/**
 * DELETE /api/whatsapp/evolution/connect
 *
 * Logs the instance out of Evolution Go (best-effort — the local row
 * is still removed even if the remote logout fails, e.g. the instance
 * is already gone) and deletes the account's whatsapp_config row.
 */
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

  // Scope by provider as well as account_id — defense in depth so this
  // endpoint can never delete a healthy Meta row (which holds
  // access_token/phone_number_id/waba_id) even if some UI bug lets it
  // be called for a non-Evolution account.
  const { error } = await supabase
    .from('whatsapp_config')
    .delete()
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
  if (error) {
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
