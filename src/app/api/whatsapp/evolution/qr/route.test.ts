import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getQrCode: vi.fn(async () => ({ qrCodePng: 'data:image/png;base64,AAA', code: '2@abc' })),
  accountId: 'acc-1' as string | null,
  authUser: { id: 'user-1' } as { id: string } | null,
}))

vi.mock('next/server', () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ body: b, init: i }) },
}))
vi.mock('@/lib/whatsapp/evolution-api', () => ({ getQrCode: h.getQrCode }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace('enc-', '') }))
vi.mock('@/app/api/whatsapp/config/resolve-account', () => ({
  resolveAccountId: vi.fn(async () => h.accountId),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: h.authUser },
        error: h.authUser ? null : { message: 'no user' },
      })),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: { evolution_instance_token: 'enc-raw-token' }, error: null }),
        }),
      }),
    }),
  })),
}))

import { GET } from './route'

describe('GET /api/whatsapp/evolution/qr', () => {
  beforeEach(() => {
    h.accountId = 'acc-1'
    h.authUser = { id: 'user-1' }
  })

  it("returns the QR code for the account's instance", async () => {
    const res = await GET()
    expect((res as { body?: unknown }).body).toEqual({ qrCodePng: 'data:image/png;base64,AAA', code: '2@abc' })
    expect(h.getQrCode).toHaveBeenCalledWith({ instanceToken: 'raw-token' })
  })

  it('returns 401 without an authenticated caller', async () => {
    h.authUser = null
    const res = await GET()
    expect((res as { init?: { status?: number } }).init?.status).toBe(401)
  })
})
