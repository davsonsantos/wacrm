import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  findOrCreateConversation: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) => {
    const status =
      err instanceof Error && 'status' in err
        ? (err as Error & { status: number }).status
        : 500
    return Response.json({ error: (err as Error).message }, { status })
  }),
}))

vi.mock('@/lib/whatsapp/find-or-create-conversation', () => ({
  findOrCreateConversation: mocks.findOrCreateConversation,
}))

import { POST } from './route'

// Mirrors the shape requireRole's real AccountContext returns — see
// src/lib/auth/account.ts. `supabase` here is a minimal fake exercising
// only the `contacts` lookup this route performs directly.
let contactRow: { id: string } | null = { id: 'contact-1' }

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table !== 'contacts') throw new Error(`unexpected table: ${table}`)
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: contactRow, error: null }),
      }
      return builder
    },
  }
}

const context = {
  supabase: makeSupabase(),
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
}

const params = { params: Promise.resolve({ id: 'contact-1' }) }

function request() {
  return new Request('http://localhost/api/contacts/contact-1/conversation', {
    method: 'POST',
  })
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.findOrCreateConversation.mockReset()
  mocks.requireRole.mockResolvedValue({ ...context, supabase: makeSupabase() })
  contactRow = { id: 'contact-1' }
})

describe('POST /api/contacts/[id]/conversation', () => {
  it('finds-or-creates the conversation and returns its id', async () => {
    mocks.findOrCreateConversation.mockResolvedValue('conv-1')

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ conversation_id: 'conv-1' })
    expect(mocks.requireRole).toHaveBeenCalledWith('agent')
    expect(mocks.findOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      'user-1',
      'contact-1',
    )
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null
    mocks.requireRole.mockResolvedValue({ ...context, supabase: makeSupabase() })

    const res = await POST(request(), params)
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(mocks.findOrCreateConversation).not.toHaveBeenCalled()
  })

  it('500s when findOrCreateConversation fails', async () => {
    mocks.findOrCreateConversation.mockResolvedValue(null)

    const res = await POST(request(), params)
    expect(res.status).toBe(500)
  })

  it('propagates requireRole auth failures via toErrorResponse', async () => {
    class ForbiddenError extends Error {
      status = 403
    }
    mocks.requireRole.mockRejectedValue(new ForbiddenError('Forbidden'))

    const res = await POST(request(), params)
    expect(res.status).toBe(403)
    expect(mocks.findOrCreateConversation).not.toHaveBeenCalled()
  })
})
