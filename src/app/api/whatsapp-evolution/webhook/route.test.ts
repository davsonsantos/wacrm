import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  state: {
    config: {
      account_id: 'acc-1',
      user_id: 'user-1',
      evolution_instance_id: 'inst-1',
      evolution_instance_token: 'enc-token',
    } as Record<string, unknown> | null,
    conversation: { id: 'conv-1', status: 'open' },
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    upsertCalls: [] as Record<string, unknown>[],
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () => ({
                eq: () =>
                  Promise.resolve({
                    data: h.state.config ? [h.state.config] : [],
                    error: null,
                  }),
              }),
            }),
          }
        case 'contacts':
          return {
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: 'contact-1', name: 'Ana' }, error: null }),
              }),
            }),
          }
        case 'conversations':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({ data: [h.state.conversation], error: null }),
                  }),
                }),
              }),
            }),
          }
        case 'broadcast_recipients':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
                  }),
                }),
              }),
            }),
          }
        case 'messages':
          return {
            select: (_c: string, options?: { head?: boolean }) =>
              options?.head
                ? {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({ count: h.state.priorCustomerMsgCount, error: null }),
                    }),
                  }
                : { eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) },
            upsert: (row: Record<string, unknown>) => {
              h.state.upsertCalls.push(row)
              return { select: () => Promise.resolve({ data: h.state.messageUpsertResult, error: null }) }
            },
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: vi.fn(async () => false) }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn(async () => {}) }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })) }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn(async () => {}) }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace('enc-', '') }))

import { POST } from './route'

function inboundRequest(body: unknown) {
  return new Request('https://app.example.com/api/whatsapp-evolution/webhook', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('Evolution Go webhook route', () => {
  beforeEach(() => {
    h.state.config = {
      account_id: 'acc-1',
      user_id: 'user-1',
      evolution_instance_id: 'inst-1',
      evolution_instance_token: 'enc-token',
    }
    h.state.upsertCalls = []
    h.state.priorCustomerMsgCount = 0
  })

  it('ignores an event whose instanceToken does not match the stored one', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-1',
        instanceToken: 'wrong-token',
        data: { Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'wamid-1', Type: 'text', IsFromMe: false, IsGroup: false, PushName: 'Ana', Timestamp: '2026-08-11T10:00:00-03:00' }, Message: { conversation: 'oi' } },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status).toBe(401)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('ignores an event for an unknown instanceId', async () => {
    h.state.config = null
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-unknown',
        instanceToken: 'token',
        data: { Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'wamid-1', Type: 'text', IsFromMe: false, IsGroup: false, PushName: 'Ana', Timestamp: '2026-08-11T10:00:00-03:00' }, Message: { conversation: 'oi' } },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('ignores echoes of our own outbound messages (IsFromMe)', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: { Info: { Chat: '5511999999999@s.whatsapp.net', ID: 'wamid-1', Type: 'text', IsFromMe: true, IsGroup: false, PushName: 'Ana', Timestamp: '2026-08-11T10:00:00-03:00' }, Message: { conversation: 'oi' } },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('inserts an inbound text message and returns 200', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: {
          Info: {
            Chat: '5511999999999@s.whatsapp.net',
            ID: 'wamid-1',
            Type: 'text',
            IsFromMe: false,
            IsGroup: false,
            PushName: 'Ana',
            Timestamp: '2026-08-11T10:00:00-03:00',
          },
          Message: { conversation: 'Oi, tudo bem?' },
        },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0]).toMatchObject({
      content_type: 'text',
      content_text: 'Oi, tudo bem?',
      message_id: 'wamid-1',
      sender_type: 'customer',
    })
  })

  it('ignores group messages', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Message',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: { Info: { Chat: '123-456@g.us', ID: 'wamid-2', Type: 'text', IsFromMe: false, IsGroup: true, PushName: 'Group', Timestamp: '2026-08-11T10:00:00-03:00' }, Message: { conversation: 'oi grupo' } },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('non-Message events (e.g. Connected) return 200 without inserting anything', async () => {
    const res = await POST(
      inboundRequest({
        event: 'Connected',
        instanceId: 'inst-1',
        instanceToken: 'token',
        data: { status: 'open', jid: '5511999999999:5@s.whatsapp.net' },
      }),
    )
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })
})
