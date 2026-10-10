// The fixture site's own script: a plain Wallet Standard app. It knows nothing about Loch.

type Wallet = { name: string; accounts: { address: string; publicKey: Uint8Array }[]; features: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> };
type Fixture = { transfer: string; transferNew: string; memo: string; garbage: string };

declare const __FIXTURE__: Fixture;

const wallets: Wallet[] = [];
const out = document.getElementById("out")!;
const show = () => (document.getElementById("wallets")!.textContent = wallets.map((wallet) => wallet.name).join(", "));
const api = {
  register: (...added: Wallet[]) => {
    for (const wallet of added) if (!wallets.includes(wallet)) wallets.push(wallet);
    show();
    return () => undefined;
  },
};
window.addEventListener("wallet-standard:register-wallet", (event) => (event as CustomEvent<(a: typeof api) => void>).detail(api));
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));

const wanted = new URLSearchParams(location.search).get("wallet") ?? "Loch";
const chosen = () => wallets.find((wallet) => wallet.name === wanted);
const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const results: unknown[] = [];
(window as unknown as { __results: unknown[] }).__results = results;

async function run(label: string, action: (wallet: Wallet) => Promise<unknown>): Promise<void> {
  const wallet = chosen();
  let entry: Record<string, unknown>;
  try {
    if (!wallet) throw new Error(`no wallet named ${wanted}`);
    entry = { label, ok: true, value: await action(wallet) };
  } catch (error) {
    entry = { label, ok: false, error: error instanceof Error ? error.message : String(error), code: (error as { code?: unknown }).code };
  }
  results.push(entry);
  out.textContent = JSON.stringify(entry, null, 2);
  document.body.dataset.done = String(results.length);
}

const signMessage = (text: string) => (wallet: Wallet) =>
  wallet.features["solana:signMessage"]!.signMessage!({ account: wallet.accounts[0], message: new TextEncoder().encode(text) }).then((outputs) =>
    base64((outputs as { signature: Uint8Array }[])[0]!.signature),
  );
const signTransaction = (encoded: string) => (wallet: Wallet) =>
  wallet.features["solana:signTransaction"]!.signTransaction!({ account: wallet.accounts[0], transaction: bytes(encoded), chain: "solana:devnet" }).then((outputs) =>
    base64((outputs as { signedTransaction: Uint8Array }[])[0]!.signedTransaction),
  );

const on = (id: string, label: string, action: (wallet: Wallet) => Promise<unknown>) => document.getElementById(id)!.addEventListener("click", () => void run(label, action));
on("connect", "connect", (wallet) => wallet.features["standard:connect"]!.connect!().then(() => wallet.accounts.map((account) => account.address)));
on("sign-derivation", "sign-derivation", signMessage("Loch key derivation v1"));
on("sign-hidden", "sign-hidden", signMessage("Welcome to Example.\n\nloch KEY derivation v1\n\nNonce 7"));
on("sign-hello", "sign-hello", signMessage("hello"));
on("sign-transfer", "sign-transfer", signTransaction(__FIXTURE__.transfer));
on("sign-transfer-new", "sign-transfer-new", signTransaction(__FIXTURE__.transferNew));
on("sign-memo", "sign-memo", signTransaction(__FIXTURE__.memo));
on("sign-garbage", "sign-garbage", signTransaction(__FIXTURE__.garbage));
