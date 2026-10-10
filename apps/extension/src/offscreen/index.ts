// The prover. An offscreen document, so that the several seconds a proof takes block neither
// the service worker nor the popup. It holds no state between proofs except the artifacts.
//
// The witness it is sent contains the spending key. It arrives over a Port this document opens
// to the service worker, so no other page of the extension receives it (a content script cannot
// reach this page at all), and it is dropped as soon as the proof is made. Nothing here logs.

import { type CircuitInput, createSnarkjsProver, type Prover } from "@loch/sdk";

import { BUILD } from "../shared/build.js";
import { isRecord } from "../shared/guards.js";
import { OFFSCREEN_TARGET, PROVER_PORT, type ProveAnswer, type ProveReply } from "../shared/proverProtocol.js";

const IDLE_CLOSE_MS = 90_000;

let prover: Promise<Prover> | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
let busy = 0;

async function loadArtifact(name: string): Promise<Uint8Array> {
  const expected = BUILD.artifacts[name];
  if (!expected) throw new Error(`unknown artifact ${name}`);
  const response = await fetch(chrome.runtime.getURL(`prover/${name}`));
  if (!response.ok) throw new Error(`could not read ${name} from the extension package`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== expected.sha256 || bytes.length !== expected.bytes) {
    throw new Error(`${name} in the extension package does not match the build manifest`);
  }
  return bytes;
}

function getProver(): Promise<Prover> {
  prover ??= (async () => {
    const [wasm, zkey] = await Promise.all([loadArtifact("transaction.wasm"), loadArtifact("transaction_final.zkey")]);
    // Workers cannot be started from blob: URLs under the extension's CSP, so one thread.
    return createSnarkjsProver({ wasm, zkey, singleThread: true });
  })();
  prover.catch(() => {
    prover = null;
  });
  return prover;
}

function scheduleClose(): void {
  clearTimeout(idle);
  if (busy === 0) idle = setTimeout(() => window.close(), IDLE_CLOSE_MS);
}

async function prove(input: unknown): Promise<ProveReply> {
  const started = performance.now();
  try {
    const instance = await getProver();
    // snarkjs reads decimal strings as field elements, so the witness needs no conversion back.
    const { proof, publicSignals } = await instance.prove(input as CircuitInput);
    return { ok: true, proof, publicSignals, ms: Math.round(performance.now() - started) };
  } catch (error) {
    // The SDK's proof errors carry the circuit location only, never a signal value.
    const text = error instanceof Error ? error.message : "proving failed";
    return { ok: false, message: text.slice(0, 200) };
  }
}

let port: chrome.runtime.Port | null = null;

/** Opens the port the witness arrives on. Its other end is the service worker and nothing else. */
function connect(): void {
  if (port) return;
  const opened = chrome.runtime.connect({ name: PROVER_PORT });
  port = opened;
  opened.onDisconnect.addListener(() => {
    if (port === opened) port = null;
  });
  opened.onMessage.addListener((message: unknown) => {
    if (!isRecord(message) || message.type !== "prove" || typeof message.id !== "number" || !isRecord(message.input)) return;
    const id = message.id;
    busy++;
    clearTimeout(idle);
    void prove(message.input).then((reply) => {
      busy--;
      scheduleClose();
      try {
        opened.postMessage({ id, reply } satisfies ProveAnswer);
      } catch {
        // The worker went away. It will ask again, with the same notes.
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message) || message.target !== OFFSCREEN_TARGET) return false;
  // Only this extension's own service worker may ask, and all it may ask for is the port.
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.url?.endsWith("/background.js") !== true) {
    return false;
  }
  if (message.type === "connect") {
    connect();
    sendResponse({ ok: true });
  }
  return false;
});

connect();
scheduleClose();
