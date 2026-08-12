'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'

/**
 * - `loading`: initial GET /api/whatsapp/config in flight.
 * - `unconfigured`: no Evolution config yet (fresh account, or the
 *   account previously deleted its instance) — show the initial
 *   "Conectar via QR Code" button.
 * - `qr`: a connect attempt is in flight or just started; the QR
 *   image is shown and status is polled until it flips to connected.
 * - `connected`: paired and live. Green badge + "Excluir instância".
 * - `disconnected`: an instance exists on file but isn't paired right
 *   now (the phone unlinked the device, or a previous QR scan never
 *   completed). Red badge + "Reconectar" (reuses the same instance,
 *   just restarts pairing) + "Excluir instância".
 */
type Phase = 'loading' | 'unconfigured' | 'qr' | 'connected' | 'disconnected'

export function EvolutionGoConfig() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [qrCodePng, setQrCodePng] = useState<string | null>(null)
  const [instanceName, setInstanceName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const checkStatus = useCallback(async () => {
    const res = await fetch('/api/whatsapp/config')
    if (!res.ok) return
    const data = await res.json()
    // GET /api/whatsapp/config's Meta-branch response shape also has
    // `connected: true` but omits `provider` entirely — without this
    // check, opening this tab on a healthy Meta account would render
    // "Conectado via Evolution Go" and expose a delete button that
    // (absent the provider-scoped DELETE guard) could destroy the
    // Meta credentials. Require both.
    if (data.provider !== 'evolution') {
      setPhase('unconfigured')
      return
    }
    setInstanceName(data.instance_name ?? null)
    if (data.status === 'connected') {
      setPhase('connected')
      stopPolling()
    } else if (data.status === 'connecting') {
      // A previous attempt is mid-pairing (e.g. the page was reloaded
      // before the scan completed). Keep polling if we're already
      // showing the QR; otherwise treat it like "disconnected" so the
      // user has a button to regenerate the QR.
      setPhase((prev) => (prev === 'qr' ? 'qr' : 'disconnected'))
    } else {
      setPhase('disconnected')
      stopPolling()
    }
  }, [stopPolling])

  useEffect(() => {
    checkStatus()
    return stopPolling
  }, [checkStatus, stopPolling])

  async function handleConnect() {
    setError(null)
    setBusy(true)
    setPhase('qr')
    try {
      const connectRes = await fetch('/api/whatsapp/evolution/connect', { method: 'POST' })
      if (!connectRes.ok) throw new Error('Falha ao iniciar a conexão')

      const qrRes = await fetch('/api/whatsapp/evolution/qr')
      if (!qrRes.ok) throw new Error('Falha ao buscar QR Code')
      const { qrCodePng } = await qrRes.json()
      setQrCodePng(qrCodePng)

      stopPolling()
      pollRef.current = setInterval(checkStatus, 3000)
    } catch (err) {
      setPhase('disconnected')
      setError(err instanceof Error ? err.message : 'Erro desconhecido')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    setBusy(true)
    stopPolling()
    try {
      await fetch('/api/whatsapp/evolution/connect', { method: 'DELETE' })
      setPhase('unconfigured')
      setQrCodePng(null)
      setInstanceName(null)
      setError(null)
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'loading') {
    return (
      <Card className="p-6 flex items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </Card>
    )
  }

  if (phase === 'connected') {
    return (
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge className="bg-emerald-950/30 text-emerald-400 border-emerald-700/50 gap-1">
              <CheckCircle2 className="size-3" />
              Conectado
            </Badge>
            {instanceName && (
              <span className="text-sm text-muted-foreground">{instanceName}</span>
            )}
          </div>
          <Button variant="outline" onClick={handleDelete} disabled={busy}>
            Excluir instância
          </Button>
        </div>
      </Card>
    )
  }

  if (phase === 'disconnected') {
    return (
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge className="bg-red-950/30 text-red-400 border-red-700/50 gap-1">
              <XCircle className="size-3" />
              Desconectado
            </Badge>
            {instanceName && (
              <span className="text-sm text-muted-foreground">{instanceName}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleConnect} disabled={busy}>
              {busy ? 'Gerando QR Code…' : 'Reconectar'}
            </Button>
            <Button variant="outline" onClick={handleDelete} disabled={busy}>
              Excluir instância
            </Button>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </Card>
    )
  }

  return (
    <Card className="p-6 space-y-4">
      <p className="text-sm text-muted-foreground">
        Conecte um número de WhatsApp escaneando o QR Code com o celular
        (WhatsApp → Aparelhos conectados → Conectar um aparelho).
      </p>
      {qrCodePng ? (
        <div className="flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrCodePng} alt="QR Code de conexão" className="w-56 h-56" />
          <p className="text-xs text-muted-foreground">Aguardando leitura do QR Code…</p>
        </div>
      ) : (
        <Button onClick={handleConnect} disabled={busy}>
          {busy ? 'Gerando QR Code…' : 'Conectar via QR Code'}
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Card>
  )
}
