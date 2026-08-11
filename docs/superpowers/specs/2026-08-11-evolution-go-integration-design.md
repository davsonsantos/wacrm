# Suporte a Evolution Go (WhatsApp não-oficial via QR Code)

**Data:** 2026-08-11
**Status:** Aprovado, aguardando plano de implementação

## Contexto e objetivo

O WACRM hoje só conecta com o WhatsApp através da API oficial da Meta (Cloud API), com um token de acesso e `phone_number_id` configurados por conta em `whatsapp_config`. Queremos oferecer uma segunda forma de conexão: **Evolution Go**, uma API não-oficial (baseada em `whatsmeow`) que conecta um número real de WhatsApp via escaneamento de QR Code, sem passar pelo processo de aprovação da Meta.

O usuário escolhe, na tela de configurações, qual provider usar para a conta. As duas opções não coexistem na mesma conta (mesma restrição de hoje: uma linha de config por `account_id`).

**Requisito inegociável:** nada do que já funciona com a Meta pode quebrar. Por isso o design evita tocar em código de envio/recebimento da Meta sempre que possível, preferindo branches novos a refatorações do caminho existente.

## Decisões já tomadas com o usuário

- Servidor Evolution Go **compartilhado por nós** (não é BYO do cliente) — já está no ar, só será consumido via env vars.
- Escopo da v1: **paridade ampla** — Inbox, Broadcasts, Automations e Flows suportam Evolution Go.
- Fora de escopo: botões/listas interativas (API não expõe endpoint para isso), múltiplas instâncias por conta, deploy/operação do servidor Evolution Go.

## Referência da API Evolution Go

Base URL + header `apikey` (global, nosso). Endpoints relevantes:

- `POST /instance/create` — cria uma instância (`name`, `token`) → retorna `id`, `token`, `qrcode`, etc.
- `POST /instance/connect` — inicia conexão; aceita `webhookUrl`, `subscribe` (lista de eventos), `phone` (pairing code alternativo).
- `GET /instance/qr` — retorna `{ data: { Qrcode: "data:image/png;base64,...", Code: "2@..." } }`.
- `GET /instance/status` — retorna `{ data: { Connected: bool, LoggedIn: bool, Name: string } }`.
- `POST /send/text`, `/send/media`, `/send/location`, `/send/contact`, `/send/poll`.
- `POST /instance/logout`, `POST /instance/disconnect`, `DELETE /instance/delete`.
- Webhooks: payload base `{ event, data, instanceId, instanceToken }`. Eventos relevantes: `Message` (inbound), `Connected`/`PairSuccess` (conectado), `QRCode` (novo QR gerado). Endpoint precisa responder 2xx em até 30s; 5 tentativas de retry a cada 30s.

Não há conceito de template aprovado — qualquer texto pode ser enviado livremente.

## Arquitetura

### 1. Modelo de dados

Reaproveita `whatsapp_config` (1 linha por `account_id`, `UNIQUE(account_id)` já existente) em vez de tabela nova. Nova migração `0XX_evolution_provider.sql`:

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'evolution')),
  ADD COLUMN IF NOT EXISTS evolution_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_token TEXT, -- cifrado, mesmo padrão de access_token
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT;
```

Colunas específicas da Meta continuam existindo e simplesmente não são usadas quando `provider = 'evolution'`. `status` e `connected_at` continuam genéricos, usados por ambos providers.

Env vars novas (nível de servidor, não por conta): `EVOLUTION_API_BASE_URL`, `EVOLUTION_GLOBAL_API_KEY`.

### 2. Cliente de baixo nível

Novo `src/lib/whatsapp/evolution-api.ts`, espelhando a forma de `meta-api.ts`: `createInstance`, `connectInstance`, `getQrCode`, `getInstanceStatus`, `logoutInstance`, `deleteInstance`, `sendTextMessage`, `sendMediaMessage`, `sendLocationMessage`, `sendContactMessage`, `sendPollMessage`. Cada função faz uma chamada HTTP simples contra `EVOLUTION_API_BASE_URL` com header `apikey: EVOLUTION_GLOBAL_API_KEY`.

### 3. Camada de envio (não tocar no caminho da Meta)

Os 4 pontos que hoje chamam `meta-api.ts` diretamente ganham um branch por `config.provider`, sem alterar o comportamento existente do branch Meta:

- `src/lib/whatsapp/send-message.ts` (Inbox / API pública)
- `src/lib/flows/meta-send.ts` (Flows)
- `src/lib/automations/meta-send.ts` (Automations)
- `src/lib/whatsapp/broadcast-core.ts` (Broadcasts)

Para Broadcasts/Automations: quando `provider === 'evolution'`, em vez de chamar o envio de template da Meta, o texto do template já interpolado com `template_params` (mecanismo existente desde a migração 038) é enviado como texto livre via `evolution-api.ts#sendTextMessage`.

Não haverá consolidação dos 4 senders duplicados nesta tarefa — fica registrado como melhoria futura, não faz parte deste trabalho.

### 4. Fluxo de conexão (QR Code) — Settings UI

`whatsapp-config.tsx` ganha um seletor de provider no topo. Ao escolher Evolution Go:

1. Server action cria a instância (`POST /instance/create`), já passando `webhookUrl` apontando para a rota de webhook da Evolution e `subscribe: ["MESSAGE", "CONNECTION", "QRCODE"]`. Salva `evolution_instance_id` / `evolution_instance_token` (cifrado) em `whatsapp_config`, `provider = 'evolution'`, `status = 'connecting'`.
2. UI busca o QR (`GET /instance/qr`) e renderiza o PNG base64 recebido.
3. UI faz polling do **nosso** endpoint `/api/whatsapp/config` (não da Evolution diretamente) esperando `status = 'connected'` — esse status é atualizado pelo webhook (`Connected`/`PairSuccess`), não por polling direto na Evolution.
4. Conectado: mostra estado equivalente ao card da Meta (número/jid), com botão de desconectar (`logoutInstance`).

### 5. Webhook de entrada

Nova rota `src/app/api/whatsapp-evolution/webhook/route.ts` — payload da Evolution não tem relação com o da Meta, não reaproveita a rota existente. Sem handshake `GET` (não existe verificação estilo `hub.challenge` na Evolution).

Fluxo do `POST`:
1. Resolve `account_id` por `evolution_instance_id` recebido no payload.
2. Valida `instanceToken` do payload contra o valor cifrado salvo (proteção contra spoofing, já que o servidor é compartilhado entre contas).
3. `event: "Message"` → normaliza para o mesmo formato interno usado pela rota da Meta hoje.
4. `event: "Connected" | "PairSuccess"` → atualiza `whatsapp_config.status = 'connected'`, `connected_at = now()`.

**Único ponto que toca código da Meta:** a lógica de "processar mensagem normalizada → automations/flows/IA auto-reply" que hoje vive inline em `src/app/api/whatsapp/webhook/route.ts` precisa ser extraída para uma função compartilhada (ex.: `processInboundMessage(accountId, normalizedMessage)`), chamada pelas duas rotas de webhook. É extração mecânica — sem mudar comportamento do caminho da Meta.

### 6. Automations / Broadcasts / Flows

Como essas engines já resolvem `whatsapp_config` e delegam para um dos 4 senders, a lógica de negócio (matching de trigger, execução do grafo de nós, resolução de destinatários) não muda — só o leaf final de envio passa a olhar `config.provider`.

## Testes

- `evolution-api.ts`: testes unitários com fetch mockado (criação de instância, QR, status, envio, erros 4xx/5xx).
- Branch de provider nos 4 senders: teste garantindo que `provider = 'meta'` continua batendo exatamente no mesmo código/mocks de hoje (regressão), e que `provider = 'evolution'` chama `evolution-api.ts` em vez de `meta-api.ts`.
- Webhook da Evolution: teste de normalização do payload `Message` → formato interno, teste de rejeição quando `instanceToken` não bate.
- `processInboundMessage` extraída: teste garantindo que o webhook da Meta, após a extração, produz exatamente o mesmo resultado que produzia antes (regressão pura).

## Fora de escopo (v1)

- Botões/listas interativas via Evolution Go (API não expõe endpoint).
- Múltiplas instâncias/números simultâneos por conta.
- Deploy/operação do servidor Evolution Go em si (assume-se já em produção).
- Consolidação dos 4 senders duplicados (Meta) em uma interface única — melhoria futura, não faz parte deste trabalho.
