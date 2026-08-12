import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  createInstance: vi.fn(async () => ({ instanceId: 'inst-1', instanceToken: 'raw-token' })),
  connectInstance: vi.fn(async () => {}),
  logoutInstance: vi.fn(async () => {}),
  upsertCalls: [] as Record<string, unknown>[],
  deleteCalls: [] as { col: string; val: string }[],
  accountId: 'acc-1' as string | null,
  authUser: { id: 'user-1' } as { id: string } | null,
  // Controls what the account's existing whatsapp_config row (if any)
  // looks like for both POST's instance-reuse lookup and DELETE's
  // logout lookup. Null = no row yet (fresh account).
  existingConfig: null as {
    evolution_instance_id?: string
    evolution_instance_token?: string
  } | null,
}))

vi.mock('next/server', () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ body: b, init: i }) },
}))
vi.mock('@/lib/whatsapp/evolution-api', () => ({
  createInstance: h.createInstance,
  connectInstance: h.connectInstance,
  logoutInstance: h.logoutInstance,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc-${v}`,
  decrypt: (v: string) => v.replace('enc-', ''),
}))
vi.mock('@/app/api/whatsapp/config/resolve-account', () => ({
  resolveAccountId: vi.fn(async () => h.accountId),
}))

function supabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: h.authUser },
        error: h.authUser ? null : { message: 'no user' },
      })),
    },
    from: (table: string) => {
      if (table !== 'whatsapp_config') throw new Error(`unexpected table: ${table}`)
      return {
        upsert: (row: Record<string, unknown>) => {
          h.upsertCalls.push(row)
          return Promise.resolve({ error: null })
        },
        select: () => {
          // Chainable across one or two `.eq()` calls — POST's
          // instance-reuse lookup filters by account_id AND provider;
          // DELETE's logout lookup filters by account_id alone.
          const builder = {
            eq: () => builder,
            maybeSingle: () => Promise.resolve({ data: h.existingConfig, error: null }),
          }
          return builder
        },
        delete: () => ({
          eq: (col: string, val: string) => {
            h.deleteCalls.push({ col, val })
            return {
              eq: (col2: string, val2: string) => {
                h.deleteCalls.push({ col: col2, val: val2 })
                return Promise.resolve({ error: null })
              },
            }
          },
        }),
      }
    },
  }
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock()),
}))

import { POST, DELETE } from './route'

describe('POST /api/whatsapp/evolution/connect', () => {
  beforeEach(() => {
    h.upsertCalls = []
    h.accountId = 'acc-1'
    h.authUser = { id: 'user-1' }
    h.existingConfig = null
    h.createInstance.mockClear()
    h.connectInstance.mockClear()
  })

  it('creates a new instance for an account with none yet, connects it, and saves the config row', async () => {
    const res = await POST()
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.createInstance).toHaveBeenCalledWith({ name: 'acc-1' })
    expect(h.connectInstance).toHaveBeenCalledWith({
      instanceToken: 'raw-token',
      webhookUrl: expect.stringContaining('/api/whatsapp-evolution/webhook'),
      subscribe: ['MESSAGE', 'CONNECTION', 'QRCODE'],
    })
    expect(h.upsertCalls[0]).toMatchObject({
      account_id: 'acc-1',
      user_id: 'user-1',
      provider: 'evolution',
      evolution_instance_id: 'inst-1',
      evolution_instance_token: 'enc-raw-token',
      status: 'connecting',
    })
  })

  it('reuses the existing instance instead of creating a new one ("Reconectar")', async () => {
    h.existingConfig = {
      evolution_instance_id: 'inst-existing',
      evolution_instance_token: 'enc-existing-token',
    }
    const res = await POST()
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    // The whole point: retrying/reconnecting must never call
    // createInstance again — that would orphan a live instance on the
    // shared server with no local record of it (issue flagged in the
    // final review as a Minor, now closed for real by this test).
    expect(h.createInstance).not.toHaveBeenCalled()
    expect(h.connectInstance).toHaveBeenCalledWith({
      instanceToken: 'existing-token',
      webhookUrl: expect.stringContaining('/api/whatsapp-evolution/webhook'),
      subscribe: ['MESSAGE', 'CONNECTION', 'QRCODE'],
    })
    expect(h.upsertCalls[0]).toMatchObject({
      evolution_instance_id: 'inst-existing',
      evolution_instance_token: 'enc-existing-token',
      status: 'connecting',
    })
  })

  it('returns 401 when the caller is not authenticated', async () => {
    h.authUser = null
    const res = await POST()
    expect((res as { init?: { status?: number } }).init?.status).toBe(401)
  })

  it('returns 400 when the profile has no account', async () => {
    h.accountId = null
    const res = await POST()
    expect((res as { init?: { status?: number } }).init?.status).toBe(400)
  })
})

describe('webhookUrl', () => {
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL

  beforeEach(() => {
    h.upsertCalls = []
    h.accountId = 'acc-1'
    h.authUser = { id: 'user-1' }
    h.existingConfig = null
  })

  afterEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl
  })

  it('throws instead of registering a webhook built from "undefined" when NEXT_PUBLIC_SITE_URL is unset', async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL
    await expect(POST()).rejects.toThrow(/NEXT_PUBLIC_SITE_URL/)
    expect(h.connectInstance).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/whatsapp/evolution/connect', () => {
  beforeEach(() => {
    h.deleteCalls = []
    h.accountId = 'acc-1'
    h.authUser = { id: 'user-1' }
    h.existingConfig = { evolution_instance_token: 'enc-raw-token' }
    h.logoutInstance.mockClear()
  })

  it('logs out the instance and deletes the config row, scoped to account_id AND provider', async () => {
    const res = await DELETE()
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.logoutInstance).toHaveBeenCalledWith({ instanceToken: 'raw-token' })
    // Two chained .eq() calls — account_id first, then provider. This is
    // the defense-in-depth guard (C3) that makes it structurally
    // impossible for this endpoint to delete a Meta-provider row.
    expect(h.deleteCalls).toEqual([
      { col: 'account_id', val: 'acc-1' },
      { col: 'provider', val: 'evolution' },
    ])
  })

  it('still deletes the local config row when the remote logout fails', async () => {
    h.logoutInstance.mockRejectedValueOnce(new Error('instance already gone'))
    const res = await DELETE()
    expect((res as { init?: { status?: number } }).init?.status ?? 200).toBe(200)
    expect(h.deleteCalls).toEqual([
      { col: 'account_id', val: 'acc-1' },
      { col: 'provider', val: 'evolution' },
    ])
  })
})
