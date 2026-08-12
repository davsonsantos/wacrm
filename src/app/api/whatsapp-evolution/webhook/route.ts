/**
 * Inbound webhook for the Evolution Go provider. Unlike Meta's
 * webhook, there's no GET verification handshake and no HMAC
 * signature — the shared server is trusted infrastructure we
 * operate, and the payload's `instanceToken` is checked against the
 * value we stored for that `instanceId` to reject spoofed events
 * (the server is multi-tenant, so this is the tenant boundary).
 *
 * `Message` events run the full inbound pipeline. `Connected` /
 * `PairSuccess` mark the config row `connected` (and best-effort
 * persist the instance name via `getInstanceStatus`) so the settings
 * page (polling `/api/whatsapp/config`, Task 5) can reflect it.
 * `Disconnected` / `LoggedOut` revert it back to `disconnected` —
 * these event names are inferred from the naming convention of the
 * other connection events and should be confirmed against the real
 * server. Every other event (e.g. `QRCode`) is ignored — the QR
 * itself is fetched on demand via `/api/whatsapp/evolution/qr`, not
 * pushed here.
 *
 * The whole processing step (everything after the instanceToken
 * check) runs inside a try/catch that returns 200 on any unexpected
 * throw, matching the Meta webhook's resilience — most senders retry
 * on non-2xx, so surfacing our own bugs as 500s would just cause
 * duplicate deliveries and noisy alerting.
 */
import { NextResponse } from 'next/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getInstanceStatus } from '@/lib/whatsapp/evolution-api'
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

/**
 * Media only carries a durable `mediaUrl` when the shared server runs
 * with `WEBHOOK_FILES=false`. With the server's default
 * (`WEBHOOK_FILES=true`), media arrives as inline base64 with no
 * `url` field — that case is out of scope for v1 (no storage-upload
 * path), so we warn and store `media_url: null` rather than silently
 * dropping the attachment without a trace.
 */
function warnIfMediaMissingUrl(messageId: string, kind: string, url: string | undefined) {
  if (!url) {
    console.warn(
      `[evolution-webhook] ${kind} message ${messageId} has no durable url (server likely has WEBHOOK_FILES=true) — storing media_url as null`,
    )
  }
}

function normalizeContent(msg: EvolutionMessagePayload['Message'], messageId: string): {
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document'
  contentText: string | null
  mediaUrl: string | null
} {
  if (!msg) return { contentType: 'text', contentText: null, mediaUrl: null }
  if (msg.imageMessage) {
    warnIfMediaMissingUrl(messageId, 'image', msg.imageMessage.url)
    return { contentType: 'image', contentText: msg.imageMessage.caption ?? null, mediaUrl: msg.imageMessage.url ?? null }
  }
  if (msg.videoMessage) {
    warnIfMediaMissingUrl(messageId, 'video', msg.videoMessage.url)
    return { contentType: 'video', contentText: msg.videoMessage.caption ?? null, mediaUrl: msg.videoMessage.url ?? null }
  }
  if (msg.audioMessage) {
    warnIfMediaMissingUrl(messageId, 'audio', msg.audioMessage.url)
    return { contentType: 'audio', contentText: null, mediaUrl: msg.audioMessage.url ?? null }
  }
  if (msg.documentMessage) {
    warnIfMediaMissingUrl(messageId, 'document', msg.documentMessage.url)
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

  // Everything below this point processes trusted event data (the
  // instanceToken check above already rejected spoofed payloads), but a
  // malformed/unexpected event shape (e.g. `Message` with no `Info`) or a
  // transient failure (e.g. Evolution Go being unreachable) can still
  // throw. Match the Meta webhook route's resilience: log and return 200
  // rather than surfacing a 500 that most senders would just retry.
  try {
    if (body.event === 'Connected' || body.event === 'PairSuccess') {
      // Best-effort: also pull the instance's WhatsApp name/number so the
      // settings card isn't stuck showing a blank number. Never block
      // marking the connection as `connected` on this succeeding.
      let instanceName: string | undefined
      try {
        const info = await getInstanceStatus({ instanceToken: storedToken })
        instanceName = info.name
      } catch (err) {
        console.warn('[evolution-webhook] getInstanceStatus failed:', err)
      }

      await supabaseAdmin()
        .from('whatsapp_config')
        .update({
          status: 'connected',
          connected_at: new Date().toISOString(),
          ...(instanceName ? { evolution_instance_name: instanceName } : {}),
        })
        .eq('id', config.id)
      return NextResponse.json({ status: 'ok' }, { status: 200 })
    }

    // Event name inferred from the `Connected`/`PairSuccess` naming
    // convention used elsewhere in this webhook — not confirmed against
    // the real Evolution Go server. Confirm and adjust if the actual
    // disconnect/logout event name differs. Without this, `status` never
    // reverts once a device unlinks or the session dies remotely, so the
    // Inbox/Settings keep reporting "connected" and sends silently fail.
    if (body.event === 'Disconnected' || body.event === 'LoggedOut') {
      await supabaseAdmin()
        .from('whatsapp_config')
        .update({ status: 'disconnected' })
        .eq('id', config.id)
      return NextResponse.json({ status: 'ok' }, { status: 200 })
    }

    if (body.event !== 'Message') {
      // Other connection/QR events: status is read on demand by the
      // settings page (Task 5), not pushed through here in v1.
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

    const { contentType, contentText, mediaUrl } = normalizeContent(payload.Message, payload.Info.ID)

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
  } catch (err) {
    console.error('[evolution-webhook] unhandled error processing event:', err)
    return NextResponse.json({ status: 'error' }, { status: 200 })
  }
}
