import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInstance,
  connectInstance,
  getQrCode,
  getInstanceStatus,
  logoutInstance,
  sendTextMessage,
  sendMediaMessage,
} from "./evolution-api";

interface Captured {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}
let captured: Captured | null = null;

function okFetch(json: unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    return { ok: true, json: async () => json } as Response;
  });
}

function errorFetch(status: number, message: string) {
  return vi.fn(
    async () =>
      ({
        ok: false,
        status,
        json: async () => ({ error: { message } }),
      }) as Response,
  );
}

describe("evolution-api", () => {
  beforeEach(() => {
    captured = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createInstance posts to /instance/create with the GLOBAL key", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ data: { id: "inst-1", token: "inst-token-1" }, message: "success" }),
    );
    const result = await createInstance({ name: "acc-42" });
    expect(result).toEqual({ instanceId: "inst-1", instanceToken: "inst-token-1" });
    expect(captured?.url).toBe("https://evolution.test/instance/create");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers?.apikey).toBe("test-global-key");
    expect(captured?.body).toEqual({ name: "acc-42" });
  });

  it("connectInstance posts webhookUrl+subscribe with the INSTANCE token", async () => {
    vi.stubGlobal("fetch", okFetch({ success: true, message: "success", data: {} }));
    await connectInstance({
      instanceToken: "inst-token-1",
      webhookUrl: "https://app.example.com/api/whatsapp-evolution/webhook",
      subscribe: ["MESSAGE", "CONNECTION", "QRCODE"],
    });
    expect(captured?.url).toBe("https://evolution.test/instance/connect");
    expect(captured?.headers?.apikey).toBe("inst-token-1");
    expect(captured?.body).toEqual({
      webhookUrl: "https://app.example.com/api/whatsapp-evolution/webhook",
      subscribe: ["MESSAGE", "CONNECTION", "QRCODE"],
      immediate: true,
    });
  });

  it("getQrCode returns the base64 PNG and raw code", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({
        data: { Qrcode: "data:image/png;base64,AAA", Code: "2@abc" },
        message: "success",
      }),
    );
    const result = await getQrCode({ instanceToken: "inst-token-1" });
    expect(result).toEqual({ qrCodePng: "data:image/png;base64,AAA", code: "2@abc" });
    expect(captured?.url).toBe("https://evolution.test/instance/qr");
    expect(captured?.headers?.apikey).toBe("inst-token-1");
  });

  it("getInstanceStatus maps Connected/LoggedIn/Name", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ data: { Connected: true, LoggedIn: true, Name: "+55 11 9…" }, message: "success" }),
    );
    const result = await getInstanceStatus({ instanceToken: "inst-token-1" });
    expect(result).toEqual({ connected: true, loggedIn: true, name: "+55 11 9…" });
  });

  it("logoutInstance issues a DELETE with the instance token", async () => {
    vi.stubGlobal("fetch", okFetch({ success: true, message: "success" }));
    await logoutInstance({ instanceToken: "inst-token-1" });
    expect(captured?.url).toBe("https://evolution.test/instance/logout");
    expect(captured?.method).toBe("DELETE");
    expect(captured?.headers?.apikey).toBe("inst-token-1");
  });

  it("sendTextMessage posts number+text and returns messageId", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ success: true, message: "success", messageId: "msg-1" }),
    );
    const result = await sendTextMessage({
      instanceToken: "inst-token-1",
      to: "5511999999999",
      text: "hello",
    });
    expect(result).toEqual({ messageId: "msg-1" });
    expect(captured?.url).toBe("https://evolution.test/send/text");
    expect(captured?.body).toEqual({ number: "5511999999999", text: "hello" });
  });

  it("sendMediaMessage posts number+type+url+caption+filename", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ success: true, message: "success", messageId: "msg-2" }),
    );
    const result = await sendMediaMessage({
      instanceToken: "inst-token-1",
      to: "5511999999999",
      kind: "document",
      link: "https://cdn.example.com/invoice.pdf",
      caption: "Invoice",
      filename: "invoice.pdf",
    });
    expect(result).toEqual({ messageId: "msg-2" });
    expect(captured?.body).toEqual({
      number: "5511999999999",
      type: "document",
      url: "https://cdn.example.com/invoice.pdf",
      caption: "Invoice",
      filename: "invoice.pdf",
    });
  });

  it("sendMediaMessage throws when no link is provided", async () => {
    vi.stubGlobal("fetch", okFetch({}));
    await expect(
      sendMediaMessage({ instanceToken: "t", to: "5511999999999", kind: "image", link: "" }),
    ).rejects.toThrow(/requires a link/);
  });

  it("surfaces the Evolution Go error message on a non-2xx response", async () => {
    vi.stubGlobal("fetch", errorFetch(401, "Invalid or missing API key"));
    await expect(
      sendTextMessage({ instanceToken: "bad", to: "5511999999999", text: "hi" }),
    ).rejects.toThrow(/Invalid or missing API key/);
  });
});
