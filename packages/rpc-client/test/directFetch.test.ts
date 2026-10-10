import { describe, expect, it } from "vitest";

import { RpcClientError } from "../src/errors.js";
import { createDirectFetch } from "../src/index.js";

const RPC_URL = "https://rpc.loch.example/";
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" });

function recorder(answer: () => Response | Promise<Response> = () => new Response('{"ok":true}', { status: 200 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return answer();
  };
  return { calls, transport };
}

describe("createDirectFetch", () => {
  it("sends the request to its own URL with private settings and only allowlisted headers", async () => {
    const { calls, transport } = recorder();
    const directFetch = createDirectFetch({ fetch: transport });
    const response = await directFetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "solana-client": "js/1.0.0-maintenance", Authorization: "Bearer x", Cookie: "a=b" },
      body,
      credentials: "include",
      ...({ agent: {} } as object),
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RPC_URL);
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
    });
    expect(new TextDecoder().decode(calls[0]!.init.body as Uint8Array)).toBe(body);
    expect(Object.keys(calls[0]!.init).sort()).toEqual(["body", "cache", "credentials", "headers", "method", "mode", "redirect", "referrerPolicy", "signal"]);
  });

  it("returns the service's response as it is, error statuses included", async () => {
    const { transport } = recorder(() => new Response("slow down", { status: 429 }));
    const response = await createDirectFetch({ fetch: transport })(RPC_URL, { method: "POST", body });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("slow down");
  });

  it("refuses plain http:// to another machine unless told otherwise", async () => {
    const { calls, transport } = recorder();
    const directFetch = createDirectFetch({ fetch: transport });
    await expect(directFetch("http://rpc.loch.example/", { method: "POST", body })).rejects.toMatchObject({ name: "RpcClientError", code: "unsupported_request" });
    expect(calls).toHaveLength(0);
    for (const local of ["http://127.0.0.1:8787/", "http://localhost:8787/", "http://[::1]:8787/"]) {
      expect((await directFetch(local, { method: "POST", body })).status).toBe(200);
    }
    expect((await createDirectFetch({ fetch: transport, allowInsecureHttp: true })("http://rpc.internal/", { method: "POST", body })).status).toBe(200);
    expect(calls).toHaveLength(4);
  });

  it("reports failures as typed errors that do not quote the request", async () => {
    const leaky: typeof fetch = async () => {
      throw new TypeError(`fetch failed for ${body}`);
    };
    const error = await createDirectFetch({ fetch: leaky })(RPC_URL, { method: "POST", body }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RpcClientError);
    expect((error as RpcClientError).code).toBe("network_error");
    expect(`${(error as Error).message}${(error as Error).stack}`).not.toContain("getSlot");

    const hanging: typeof fetch = () => new Promise(() => undefined);
    const timeout = await createDirectFetch({ fetch: hanging, timeoutMs: 30 })(RPC_URL, { method: "POST", body }).catch((reason: unknown) => reason);
    expect((timeout as RpcClientError).code).toBe("timeout");

    const controller = new AbortController();
    const pending = createDirectFetch({ fetch: hanging })(RPC_URL, { method: "POST", body, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);

    await expect(createDirectFetch({ fetch: hanging })(RPC_URL, { method: "POST", body: new FormData() })).rejects.toMatchObject({ code: "unsupported_request" });
    expect(() => createDirectFetch({ timeoutMs: Number.NaN })).toThrow(RpcClientError);
  });
});
