import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Final-review fix (I5): reacting from an Evolution Go account used to call
// decrypt(config.access_token) unconditionally. access_token is NULL for
// `provider = 'evolution'` rows (Meta's columns are unused), so decrypt(null)
// threw and the route 500'd. It should instead 400 with a clear message.
// ---------------------------------------------------------------------------

let whatsappConfig: Record<string, unknown> | null = {
  id: 'cfg-1',
  account_id: 'acct-1',
  phone_number_id: 'PNID-1',
  access_token: 'enc-token',
  provider: 'meta',
}

const TARGET_MESSAGE = {
  id: 'msg-1',
  message_id: 'wamid-1',
  conversation_id: 'conv-1',
}

const CONVERSATION = {
  id: 'conv-1',
  account_id: 'acct-1',
  contact: { phone: '+15551234567' },
}

function builder(table: string) {
  const selectResult = () => {
    switch (table) {
      case 'profiles':
        return { data: { account_id: 'acct-1', account_role: 'admin' }, error: null }
      case 'accounts':
        return { data: { id: 'acct-1', name: 'Acme' }, error: null }
      case 'messages':
        return { data: TARGET_MESSAGE, error: null }
      case 'conversations':
        return { data: CONVERSATION, error: null }
      case 'whatsapp_config':
        return { data: whatsappConfig, error: null }
      default:
        return { data: null, error: null }
    }
  }

  const b: Record<string, unknown> = {}
  const chain = () => b
  for (const m of ['select', 'eq', 'delete']) b[m] = vi.fn(chain)
  b.upsert = vi.fn(() => Promise.resolve({ error: null }))
  b.single = vi.fn(() => Promise.resolve(selectResult()))
  b.maybeSingle = vi.fn(() => Promise.resolve(selectResult()))
  b.then = (resolve: (v: unknown) => unknown) => resolve(selectResult())
  return b
}

function makeSupabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => v.replace('enc-', '')),
}))

const { sendReactionMessage } = vi.hoisted(() => ({
  sendReactionMessage: vi.fn(async () => ({})),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendReactionMessage }))

import { POST } from './route'

function postReact(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: 'msg-1', emoji: '👍', ...overrides }),
    }),
  )
}

describe('POST /api/whatsapp/react', () => {
  beforeEach(() => {
    whatsappConfig = {
      id: 'cfg-1',
      account_id: 'acct-1',
      phone_number_id: 'PNID-1',
      access_token: 'enc-token',
      provider: 'meta',
    }
    supabaseMock = makeSupabaseMock()
    sendReactionMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sends the reaction for a Meta-provider config', async () => {
    const res = await postReact()
    expect(res.status).toBe(200)
    expect(sendReactionMessage).toHaveBeenCalledTimes(1)
  })

  it('400s with a clear message instead of decrypting a null access_token for an Evolution account', async () => {
    whatsappConfig = {
      id: 'cfg-1',
      account_id: 'acct-1',
      phone_number_id: null,
      access_token: null,
      provider: 'evolution',
    }

    const res = await postReact()
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/evolution/i)
    expect(sendReactionMessage).not.toHaveBeenCalled()
  })
})
