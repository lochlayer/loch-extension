// The Connection helper, against a JSON-RPC transport in memory. The same
// helper is exercised over real sockets, through the relay and the gateway,
// in services/rpc-proxy/test.

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { RpcClientError } from "../src/errors.js";
import { createConnection } from "../src/web3.js";

const RPC_URL = "https://rpc.loch.example/";
const SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

interface Call {
  method: string;
  params: unknown[];
  headers: Record<string, string>;
}

/** A fetch that answers JSON-RPC from a table of handlers and records what it was asked. */
function rpc(handlers: Record<string, (params: unknown[]) => unknown>) {
  const calls: Call[] = [];
  const transport: typeof fetch = async (input, init = {}) => {
    expect(String(input)).toBe(RPC_URL);
    const request = JSON.parse(String(init.body)) as { id: string; method: string; params?: unknown[] };
    calls.push({ method: request.method, params: request.params ?? [], headers: init.headers as Record<string, string> });
    const handler = handlers[request.method];
    const answer = handler
      ? { jsonrpc: "2.0", id: request.id, result: handler(request.params ?? []) }
      : { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, transport };
}

const status = (confirmationStatus: string | null, err: unknown = null) => ({
  context: { slot: 10 },
  value: [confirmationStatus === null ? null : { slot: 9, confirmations: 1, err, confirmationStatus }],
});

/** The parts of a Connection's private state that show whether a WebSocket was ever asked for. */
function socketState(connection: unknown) {
  const internals = connection as { _rpcWsEndpoint: string; _rpcWebSocketConnected: boolean; _subscriptionsByHash: Record<string, unknown> };
  return {
    endpoint: internals._rpcWsEndpoint,
    connected: internals._rpcWebSocketConnected,
    subscriptions: Object.keys(internals._subscriptionsByHash).length,
  };
}

describe("createConnection", () => {
  it("sends HTTP calls through the given fetch", async () => {
    const { calls, transport } = rpc({ getBalance: () => ({ context: { slot: 1 }, value: 42 }) });
    const connection = createConnection({ rpcUrl: RPC_URL, fetch: transport });
    expect(connection.commitment).toBe("confirmed");
    expect(await connection.getBalance(PublicKey.default)).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "getBalance", params: ["11111111111111111111111111111111", { commitment: "confirmed" }] });
  });

  it("refuses subscriptions instead of opening a WebSocket to the RPC host", () => {
    const { transport } = rpc({});
    const connection = createConnection({ rpcUrl: RPC_URL, fetch: transport });
    const attempts = [
      () => connection.onAccountChange(PublicKey.default, () => undefined),
      () => connection.onProgramAccountChange(PublicKey.default, () => undefined),
      () => connection.onLogs("all", () => undefined),
      () => connection.onSlotChange(() => undefined),
      () => connection.onSlotUpdate(() => undefined),
      () => connection.onSignature(SIGNATURE, () => undefined),
      () => connection.onSignatureWithOptions(SIGNATURE, () => undefined),
      () => connection.onRootChange(() => undefined),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(expect.objectContaining({ name: "RpcClientError", code: "unsupported_request" }));
    }
    // The socket client that web3.js always creates points at this machine and was never connected.
    expect(socketState(connection)).toEqual({ endpoint: "ws://127.0.0.1:9/", connected: false, subscriptions: 0 });
  });

  it("confirmTransaction polls over HTTP until the commitment is reached", async () => {
    const answers = [status(null), status("processed"), status("confirmed")];
    const { calls, transport } = rpc({ getSignatureStatuses: () => answers.shift() ?? status("finalized"), getBlockHeight: () => 100 });
    const connection = createConnection({ rpcUrl: RPC_URL, fetch: transport, confirmPollIntervalMs: 5 });
    const result = await connection.confirmTransaction({ signature: SIGNATURE, blockhash: "x", lastValidBlockHeight: 200 });
    expect(result).toEqual({ context: { slot: 10 }, value: { err: null } });
    expect(calls.filter((call) => call.method === "getSignatureStatuses")).toHaveLength(3);
    expect(calls.every((call) => call.method === "getSignatureStatuses" || call.method === "getBlockHeight")).toBe(true);
    expect(socketState(connection)).toMatchObject({ connected: false, subscriptions: 0 });

    // A stricter commitment keeps polling past "confirmed".
    const more = [status("confirmed"), status("finalized")];
    const strict = rpc({ getSignatureStatuses: () => more.shift(), getBlockHeight: () => 100 });
    const finalized = createConnection({ rpcUrl: RPC_URL, fetch: strict.transport, confirmPollIntervalMs: 5 });
    await finalized.confirmTransaction({ signature: SIGNATURE, blockhash: "x", lastValidBlockHeight: 200 }, "finalized");
    expect(strict.calls.filter((call) => call.method === "getSignatureStatuses")).toHaveLength(2);
  });

  it("confirmTransaction returns the transaction's error, and reports expiry", async () => {
    const failed = rpc({ getSignatureStatuses: () => status("processed", { InstructionError: [0, "Custom"] }) });
    const connection = createConnection({ rpcUrl: RPC_URL, fetch: failed.transport, confirmPollIntervalMs: 5 });
    expect((await connection.confirmTransaction(SIGNATURE)).value.err).toEqual({ InstructionError: [0, "Custom"] });

    const expired = rpc({ getSignatureStatuses: () => status(null), getBlockHeight: () => 201 });
    const late = createConnection({ rpcUrl: RPC_URL, fetch: expired.transport, confirmPollIntervalMs: 5 });
    await expect(late.confirmTransaction({ signature: SIGNATURE, blockhash: "x", lastValidBlockHeight: 200 })).rejects.toBeInstanceOf(
      TransactionExpiredBlockheightExceededError,
    );

    const never = rpc({ getSignatureStatuses: () => status(null) });
    const slow = createConnection({ rpcUrl: RPC_URL, fetch: never.transport, confirmPollIntervalMs: 5, confirmTimeoutMs: 40 });
    await expect(slow.confirmTransaction(SIGNATURE)).rejects.toBeInstanceOf(TransactionExpiredTimeoutError);

    const controller = new AbortController();
    const pendingForever = rpc({ getSignatureStatuses: () => status(null), getBlockHeight: () => 1 });
    const waiting = createConnection({ rpcUrl: RPC_URL, fetch: pendingForever.transport, confirmPollIntervalMs: 10_000 });
    const pending = waiting.confirmTransaction({ signature: SIGNATURE, blockhash: "x", lastValidBlockHeight: 200, abortSignal: controller.signal });
    const outcome = pending.catch((reason: unknown) => reason);
    setTimeout(() => controller.abort(), 20);
    expect(await outcome).toBe(controller.signal.reason);
  });

  it("sendAndConfirmTransaction works, and web3.js's WebSocket client is never asked to connect", async () => {
    const { calls, transport } = rpc({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100 } }),
      sendTransaction: () => SIGNATURE,
      getSignatureStatuses: () => status("confirmed"),
      getBlockHeight: () => 50,
    });
    const connection = createConnection({ rpcUrl: RPC_URL, fetch: transport, confirmPollIntervalMs: 5 });
    // Count every attempt to open the socket, whatever it would connect to.
    const socket = (connection as unknown as { _rpcWebSocket: { connect: (...args: unknown[]) => unknown } })._rpcWebSocket;
    let connects = 0;
    const connect = socket.connect.bind(socket);
    socket.connect = (...args) => {
      connects += 1;
      return connect(...args);
    };

    const payer = Keypair.generate();
    const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: PublicKey.default, lamports: 1 }));
    expect(await sendAndConfirmTransaction(connection, transaction, [payer])).toBe(SIGNATURE);
    expect((await connection.confirmTransaction(SIGNATURE)).value.err).toBeNull();
    // The unsubscribe methods are harmless without subscriptions; web3.js notes that on the console.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await connection.removeSignatureListener(0);
      await connection.removeAccountChangeListener(0);
    } finally {
      consoleWarn.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connects).toBe(0);
    expect(socketState(connection)).toEqual({ endpoint: "ws://127.0.0.1:9/", connected: false, subscriptions: 0 });
    expect(calls.map((call) => call.method)).toEqual(["getLatestBlockhash", "sendTransaction", "getSignatureStatuses", "getSignatureStatuses"]);
  });

  it("confirmTransaction keeps polling through failed polls instead of giving up on a transaction that was sent", async () => {
    let polls = 0;
    const flaky: typeof fetch = async (_input, init = {}) => {
      const { id, method } = JSON.parse(String(init.body)) as { id: string; method: string };
      polls += method === "getSignatureStatuses" ? 1 : 0;
      // The second and third polls fail in two different ways.
      if (polls === 2) throw new TypeError("fetch failed");
      if (polls === 3) return new Response("bad gateway", { status: 502 });
      const result = method === "getBlockHeight" ? 10 : polls < 5 ? status(null) : status("confirmed");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
    };
    const connection = createConnection({ rpcUrl: RPC_URL, fetch: flaky, confirmPollIntervalMs: 5 });
    const result = await connection.confirmTransaction({ signature: SIGNATURE, blockhash: "x", lastValidBlockHeight: 200 });
    expect(result.value).toEqual({ err: null });
    expect(polls).toBe(5);

    // Polling that fails for the whole timeout does end, with the error of the poll.
    const down: typeof fetch = async () => new Response("bad gateway", { status: 502 });
    const dead = createConnection({ rpcUrl: RPC_URL, fetch: down, confirmPollIntervalMs: 5, confirmTimeoutMs: 40 });
    await expect(dead.confirmTransaction({ signature: SIGNATURE, blockhash: "x", lastValidBlockHeight: 200 })).rejects.toThrow(/502/);
  });

  it("confirmTransaction looks once more after the last valid block before calling a transaction expired", async () => {
    // The status is unknown, the block height has passed, and the transaction turns out to have landed in its last block.
    const answers = [status(null), status("confirmed")];
    const landed = rpc({ getSignatureStatuses: () => answers.shift(), getBlockHeight: () => 201 });
    const connection = createConnection({ rpcUrl: RPC_URL, fetch: landed.transport, confirmPollIntervalMs: 5 });
    expect((await connection.confirmTransaction({ signature: SIGNATURE, blockhash: "x", lastValidBlockHeight: 200 })).value).toEqual({ err: null });
    expect(landed.calls.map((call) => call.method)).toEqual(["getSignatureStatuses", "getBlockHeight", "getSignatureStatuses"]);
  });

  it("rejects unusable options", () => {
    const { transport } = rpc({});
    expect(() => createConnection({ rpcUrl: RPC_URL } as never)).toThrow(RpcClientError);
    expect(() => createConnection({ fetch: transport } as never)).toThrow(RpcClientError);
    expect(() => createConnection({ rpcUrl: RPC_URL, fetch: transport, confirmPollIntervalMs: 0 })).toThrow(RpcClientError);
  });
});
