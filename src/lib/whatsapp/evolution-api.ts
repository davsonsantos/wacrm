/**
 * Evolution Go API helpers — the unofficial, QR-code-connected WhatsApp
 * provider. Mirrors meta-api.ts's shape: one options object per
 * function, throws on non-2xx, returns just what callers need.
 *
 * Auth: POST /instance/create is the one call that uses the shared
 * server's GLOBAL_API_KEY (no instance exists yet to have its own
 * token). Every other call is instance-scoped and authenticates with
 * that instance's own `token` (client-generated at create time — the
 * server requires the caller to supply it in the create request body,
 * confirmed against the real server: an omitted/empty `token` 400s
 * with "token is required" — stored encrypted in
 * whatsapp_config.evolution_instance_token) sent as the `apikey`
 * header — see the auth-model note in the Evolution Go plan doc if
 * this assumption turns out wrong; only `instanceAuthHeaders` below
 * needs to change.
 */

import crypto from 'crypto'

/**
 * Read lazily (call-time, not module-load-time): this module is
 * imported by Meta-only routes too (e.g. send-message.ts), and
 * these vars are documented as optional — only needed by accounts
 * actually using Evolution Go. Reading them eagerly at module scope
 * would crash every importer at load time on any deployment that
 * hasn't set them, including pure-Meta ones.
 */
function requiredEnv(name: 'EVOLUTION_API_BASE_URL' | 'EVOLUTION_GLOBAL_API_KEY'): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is required to use Evolution Go (see .env.local.example). This is only needed if you use the "Conectar via QR Code" flow.`,
    )
  }
  return value
}

function evolutionApiBaseUrl(): string {
  return requiredEnv('EVOLUTION_API_BASE_URL')
}

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
  return { apikey: requiredEnv('EVOLUTION_GLOBAL_API_KEY') }
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
  // The server requires the caller to supply the instance token up
  // front — it doesn't generate one. 32 random bytes, hex-encoded,
  // matches this codebase's existing secret-generation style (see
  // encryption.ts).
  const token = crypto.randomBytes(32).toString('hex')
  const response = await fetch(`${evolutionApiBaseUrl()}/instance/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...globalAuthHeaders() },
    body: JSON.stringify({ name: args.name, token }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
  const { data } = await response.json()
  return { instanceId: data.id, instanceToken: data.token ?? token }
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
  const response = await fetch(`${evolutionApiBaseUrl()}/instance/connect`, {
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
  const response = await fetch(`${evolutionApiBaseUrl()}/instance/qr`, {
    headers: instanceAuthHeaders(args.instanceToken),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
  const { data } = await response.json()
  return { qrCodePng: data.qrcode, code: data.code }
}

export interface GetInstanceStatusResult {
  connected: boolean
  loggedIn: boolean
  name: string
}

export async function getInstanceStatus(args: { instanceToken: string }): Promise<GetInstanceStatusResult> {
  const response = await fetch(`${evolutionApiBaseUrl()}/instance/status`, {
    headers: instanceAuthHeaders(args.instanceToken),
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution Go API error: ${response.status}`)
  }
  const { data } = await response.json()
  return { connected: !!data.Connected, loggedIn: !!data.LoggedIn, name: data.Name }
}

export async function logoutInstance(args: { instanceToken: string }): Promise<void> {
  const response = await fetch(`${evolutionApiBaseUrl()}/instance/logout`, {
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
  const response = await fetch(`${evolutionApiBaseUrl()}/send/text`, {
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
  const response = await fetch(`${evolutionApiBaseUrl()}/send/media`, {
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
