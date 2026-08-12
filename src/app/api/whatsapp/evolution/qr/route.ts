import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getQrCode } from '@/lib/whatsapp/evolution-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveAccountId } from '@/app/api/whatsapp/config/resolve-account'

/**
 * GET /api/whatsapp/evolution/qr
 *
 * Returns the current QR code for the account's Evolution Go instance.
 * The settings page polls this after POST /connect until the instance
 * reports `connected` (via GET /api/whatsapp/config).
 */
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
