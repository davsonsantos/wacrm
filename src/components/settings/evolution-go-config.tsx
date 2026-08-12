'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

type Status = 'idle' | 'connecting' | 'connected' | 'error'

export function EvolutionGoConfig() {
  const [status, setStatus] = useState<Status>('idle')
  const [qrCodePng, setQrCodePng] = useState<string | null>(null)
  const [instanceName, setInstanceName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
    if (data.connected) {
      setStatus('connected')
      setInstanceName(data.instance_name ?? null)
      stopPolling()
    }
  }, [stopPolling])

  useEffect(() => {
    checkStatus()
    return stopPolling
  }, [checkStatus, stopPolling])

  async function handleConnect() {
    setError(null)
    setStatus('connecting')
    try {
      const connectRes = await fetch('/api/whatsapp/evolution/connect', { method: 'POST' })
      if (!connectRes.ok) throw new Error('Falha ao criar instância')

      const qrRes = await fetch('/api/whatsapp/evolution/qr')
      if (!qrRes.ok) throw new Error('Falha ao buscar QR Code')
      const { qrCodePng } = await qrRes.json()
      setQrCodePng(qrCodePng)

      pollRef.current = setInterval(checkStatus, 3000)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Erro desconhecido')
    }
  }

  async function handleDisconnect() {
    stopPolling()
    await fetch('/api/whatsapp/evolution/connect', { method: 'DELETE' })
    setStatus('idle')
    setQrCodePng(null)
    setInstanceName(null)
  }

  if (status === 'connected') {
    return (
      <Card className="p-6 space-y-3">
        <p className="text-sm font-medium">Conectado via Evolution Go</p>
        {instanceName && <p className="text-sm text-muted-foreground">{instanceName}</p>}
        <Button variant="outline" onClick={handleDisconnect}>Desconectar</Button>
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
        <Button onClick={handleConnect} disabled={status === 'connecting'}>
          {status === 'connecting' ? 'Gerando QR Code…' : 'Conectar via QR Code'}
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Card>
  )
}
