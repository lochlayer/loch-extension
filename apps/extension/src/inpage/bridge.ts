// The bridge's page half: does what the service worker asks of a wallet and reports back.
// It runs in the page's own JavaScript world, because that is where wallets are. It holds no
// state and no secret; it only relays a request to the wallet and the wallet's answer back.

import type { BridgeAccount, BridgeAnswer, BridgeErrorCode, BridgeRequest, WalletInfo } from "../shared/messages.js";
import type { StandardAccount, StandardWallet } from "./standard.js";

type AnyFunction = (...args: unknown[]) => unknown;

function toBase64(bytes: ArrayLike<number>): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function failure(code: BridgeErrorCode, message: string): BridgeAnswer {
  return { ok: false, error: { code, message: message.slice(0, 200) } };
}

function thrown(error: unknown): BridgeAnswer {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "the wallet refused";
  if (code === 4001 || /reject|denied|declin|cancel/i.test(message)) return failure("rejected", message);
  return failure("failed", message);
}

function method(wallet: StandardWallet, feature: string, name: string): { self: unknown; call: AnyFunction } | null {
  const found = (wallet.features as Record<string, unknown>)[feature] as Record<string, unknown> | undefined;
  const call = found?.[name];
  return typeof call === "function" ? { self: found, call: call as AnyFunction } : null;
}

function describe(wallet: StandardWallet): WalletInfo {
  return {
    name: String(wallet.name).slice(0, 64),
    features: Object.keys(wallet.features).filter((key) => key.length <= 96).slice(0, 64),
    chains: Array.from(wallet.chains ?? []).filter((chain): chain is string => typeof chain === "string" && chain.length <= 64).slice(0, 32),
  };
}

function account(wallet: StandardWallet, address: string): StandardAccount | undefined {
  return Array.from(wallet.accounts ?? []).find((item) => item.address === address);
}

/**
 * The wallet's own account object for `address`. A page that has just loaded is not connected
 * yet, even if the user approved this site before: ask the wallet quietly first, and only then
 * with a prompt.
 */
async function connectedAccount(wallet: StandardWallet, address: string): Promise<StandardAccount | undefined> {
  const found = account(wallet, address);
  if (found) return found;
  const connect = method(wallet, "standard:connect", "connect");
  if (!connect) return undefined;
  try {
    await connect.call.call(connect.self, { silent: true });
  } catch {
    // A wallet may refuse a silent connect outright. The prompt below is the answer to that.
  }
  if (account(wallet, address)) return account(wallet, address);
  await connect.call.call(connect.self);
  return account(wallet, address);
}

/** Carries out one bridge request against the wallets on this page. Never throws. */
export async function answerBridgeRequest(request: BridgeRequest, wallets: StandardWallet[]): Promise<BridgeAnswer> {
  try {
    if (request.kind === "wallets") return { ok: true, value: { kind: "wallets", wallets: wallets.slice(0, 16).map(describe) } };

    const wallet = wallets.find((item) => item.name === request.wallet);
    if (!wallet) return failure("no-wallet", `${request.wallet} is not on this page`);

    if (request.kind === "connect") {
      const connect = method(wallet, "standard:connect", "connect");
      if (!connect) return failure("unsupported", "the wallet cannot connect");
      const result = (await connect.call.call(connect.self, request.silent ? { silent: true } : undefined)) as { accounts?: readonly StandardAccount[] } | undefined;
      const accounts: BridgeAccount[] = Array.from(result?.accounts ?? wallet.accounts ?? [])
        .filter((item) => Array.from(item.chains ?? []).some((chain) => String(chain).startsWith("solana:")))
        .slice(0, 16)
        .map((item) => ({ address: item.address, publicKey: toBase64(item.publicKey) }));
      return { ok: true, value: { kind: "connect", accounts } };
    }

    const owner = await connectedAccount(wallet, request.address);
    if (!owner) return failure("no-account", "the wallet is not connected with that address");

    if (request.kind === "signMessage") {
      const sign = method(wallet, "solana:signMessage", "signMessage");
      if (!sign) return failure("unsupported", "the wallet cannot sign messages");
      const outputs = (await sign.call.call(sign.self, { account: owner, message: fromBase64(request.message) })) as { signature?: Uint8Array }[] | undefined;
      const signature = outputs?.[0]?.signature;
      if (!signature || signature.length !== 64) return failure("failed", "the wallet returned no signature");
      return { ok: true, value: { kind: "signMessage", signature: toBase64(signature) } };
    }

    const sign = method(wallet, "solana:signTransaction", "signTransaction");
    if (!sign) return failure("unsupported", "the wallet cannot sign transactions without sending them");
    const outputs = (await sign.call.call(sign.self, { account: owner, transaction: fromBase64(request.transaction), chain: request.chain })) as
      | { signedTransaction?: Uint8Array }[]
      | undefined;
    const signed = outputs?.[0]?.signedTransaction;
    if (!signed || signed.length === 0) return failure("failed", "the wallet returned no transaction");
    return { ok: true, value: { kind: "signTransaction", signedTransaction: toBase64(signed) } };
  } catch (error) {
    return thrown(error);
  }
}
