// A stand-in for a wallet extension's page script: a Wallet Standard wallet that signs with a
// real Ed25519 key. The key and the wallet's name are given by the test (window.__MOCK_WALLET).
// It records every request it receives, so a test can check what reached "the wallet".

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";

interface Config {
  name: string;
  /** 32-byte secret key, hex. */
  secret: string;
  /** Milliseconds a "user" takes to answer a prompt. */
  delay: number;
}

interface Log {
  method: string;
  /** base64 of the message or transaction the wallet was given. */
  payload?: string;
}

declare global {
  interface Window {
    __MOCK_WALLET: Config;
    __mockWallet: { log: Log[]; decisions: ("approve" | "reject")[]; address: string };
  }
}

const config = window.__MOCK_WALLET;
const secret = Uint8Array.from(config.secret.match(/../g)!.map((byte) => parseInt(byte, 16)));
const publicKey = ed25519.getPublicKey(secret);
const address = base58.encode(publicKey);
const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const state = { log: [] as Log[], decisions: [] as ("approve" | "reject")[], address };
window.__mockWallet = state;

const account = Object.freeze({
  address,
  publicKey,
  chains: ["solana:devnet", "solana:localnet"],
  features: ["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"],
});
let connected = false;
const listeners: ((properties: unknown) => void)[] = [];

async function prompt(method: string, payload?: Uint8Array): Promise<void> {
  state.log.push({ method, ...(payload ? { payload: base64(payload) } : {}) });
  await new Promise((resolve) => setTimeout(resolve, config.delay));
  if ((state.decisions.shift() ?? "approve") === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
}

function compactU16(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let size = 0;
  for (;;) {
    const byte = bytes[offset + size]!;
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if ((byte & 0x80) === 0) return [value, size];
  }
}

/** Signs a serialised transaction in place of its own signature slot, leaving everything else as it is. */
function sign(transaction: Uint8Array): Uint8Array {
  const [count, size] = compactU16(transaction, 0);
  const messageStart = size + count * 64;
  const message = transaction.subarray(messageStart);
  const versioned = (message[0]! & 0x80) !== 0;
  const header = versioned ? 1 : 0;
  const [keys, keysSize] = compactU16(message, header + 3);
  let index = -1;
  for (let i = 0; i < keys; i++) {
    const key = message.subarray(header + 3 + keysSize + i * 32, header + 3 + keysSize + (i + 1) * 32);
    if (key.every((byte, at) => byte === publicKey[at])) index = i;
  }
  if (index < 0 || index >= count) throw new Error("this wallet is not a signer of that transaction");
  const signed = Uint8Array.from(transaction);
  signed.set(ed25519.sign(message, secret), size + index * 64);
  return signed;
}

const wallet = {
  version: "1.0.0",
  name: config.name,
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
  chains: ["solana:devnet", "solana:localnet"],
  get accounts() {
    return connected ? [account] : [];
  },
  features: {
    "standard:connect": {
      version: "1.0.0",
      connect: async (input?: { silent?: boolean }) => {
        if (!connected && !input?.silent) await prompt("connect");
        connected = connected || !input?.silent;
        for (const listener of listeners) listener({ accounts: wallet.accounts });
        return { accounts: wallet.accounts };
      },
    },
    "standard:disconnect": { version: "1.0.0", disconnect: async () => void (connected = false) },
    "standard:events": {
      version: "1.0.0",
      on: (_event: string, listener: (properties: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    "solana:signMessage": {
      version: "1.1.0",
      signMessage: async (...inputs: { account: unknown; message: Uint8Array }[]) => {
        const outputs = [];
        for (const input of inputs) {
          if (input.account !== account) throw new Error("invalid account");
          await prompt("signMessage", input.message);
          outputs.push({ signedMessage: input.message, signature: ed25519.sign(input.message, secret) });
        }
        return outputs;
      },
    },
    "solana:signTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: { account: unknown; transaction: Uint8Array }[]) => {
        const outputs = [];
        for (const input of inputs) {
          if (input.account !== account) throw new Error("invalid account");
          await prompt("signTransaction", input.transaction);
          outputs.push({ signedTransaction: sign(input.transaction) });
        }
        return outputs;
      },
    },
    "solana:signAndSendTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
        for (const input of inputs) await prompt("signAndSendTransaction", input.transaction);
        return inputs.map(() => ({ signature: new Uint8Array(64) }));
      },
    },
  },
};

const register = (api: { register(wallet: unknown): void }) => api.register(wallet);
window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
window.addEventListener("wallet-standard:app-ready", (event) => register((event as CustomEvent<{ register(wallet: unknown): void }>).detail));
