// The service worker's side of proving: hand the witness to the offscreen document and wait.
// A service worker cannot start workers, so proving here would block it for seconds.
//
// The witness holds the spending key. It is sent over a Port the offscreen document opens to
// this worker, so exactly one context receives it. (`runtime.sendMessage` would deliver it to
// every open page of the extension: the popup, the expanded view.) The only thing broadcast is
// a request to open that port, which says nothing.

import { type CircuitInput, type DepthCircuitInput, LochError, type ProofResult, type Prover } from "@loch/sdk";

import { isRecord } from "../shared/guards.js";
import { OFFSCREEN_TARGET, PROVER_PORT, type ProveAnswer, type ProveReply, type ProveRequest, type ProverCircuit } from "../shared/proverProtocol.js";

let creating: Promise<void> | null = null;
let port: chrome.runtime.Port | null = null;
let nextId = 1;
const waiting = new Map<number, (reply: ProveReply) => void>();
const portWaiters = new Set<() => void>();

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Generates zero-knowledge proofs on this device without blocking the extension.",
    })
    .catch((error: unknown) => {
      // Two callers raced: the document exists, which is all that was wanted.
      if (!/single offscreen/i.test(error instanceof Error ? error.message : "")) throw error;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/**
 * Takes the port the offscreen document opened. The caller (index.ts) has checked that the
 * browser reports this extension's own offscreen document as the other end.
 */
export function acceptProverPort(candidate: chrome.runtime.Port): void {
  if (candidate.name !== PROVER_PORT) return;
  port?.disconnect();
  port = candidate;
  candidate.onMessage.addListener((message: unknown) => {
    if (!isRecord(message) || typeof message.id !== "number" || !isRecord(message.reply)) return;
    const answer = message as unknown as ProveAnswer;
    const resolve = waiting.get(answer.id);
    waiting.delete(answer.id);
    resolve?.(answer.reply);
  });
  candidate.onDisconnect.addListener(() => {
    if (port !== candidate) return;
    port = null;
    // The document closed, or was replaced. Whoever was waiting on it will not get an answer.
    for (const [id, resolve] of waiting) {
      waiting.delete(id);
      resolve({ ok: false, message: "the prover stopped before it answered" });
    }
  });
  for (const wake of portWaiters) wake();
  portWaiters.clear();
}

/** The port to the prover, opened by the prover. Asks it to open one when there is none. */
async function proverPort(): Promise<chrome.runtime.Port> {
  for (let attempt = 0; attempt < 20 && port === null; attempt++) {
    // The document connects by itself when it loads. This is for one that lost its port (the
    // worker was restarted) or has not finished loading. It carries nothing.
    await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "connect" }).catch(() => undefined);
    if (port !== null) break;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        portWaiters.delete(wake);
        resolve();
      }, 250);
      portWaiters.add(wake);
    });
  }
  if (port === null) throw new LochError("PROOF_FAILED", "the prover did not start");
  return port;
}

/** Field elements as decimal strings: structured cloning of extension messages has no bigint. */
function serialise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialise);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialise(item)]));
  return value;
}

async function proveOffscreen(circuit: ProverCircuit, input: unknown): Promise<ProofResult> {
  await ensureOffscreen();
  const channel = await proverPort();
  const id = nextId++;
  const reply = await new Promise<ProveReply>((resolve) => {
    waiting.set(id, resolve);
    try {
      channel.postMessage({ type: "prove", id, circuit, input: serialise(input) } satisfies ProveRequest);
    } catch {
      waiting.delete(id);
      resolve({ ok: false, message: "the prover could not be reached" });
    }
  });
  if (!reply.ok) throw new LochError("PROOF_FAILED", reply.message);
  return { proof: reply.proof, publicSignals: reply.publicSignals };
}

export const offscreenProver: Prover = {
  prove: (input: CircuitInput) => proveOffscreen("transaction", input),
};

/** Depth proofs, in the same offscreen document. The witness holds the spending key here too. */
export const offscreenDepthProver: Prover<DepthCircuitInput> = {
  prove: (input: DepthCircuitInput) => proveOffscreen("depth", input),
};
