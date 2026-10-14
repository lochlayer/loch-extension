// The extension manifest, as a function so the build and the tests read one definition.
//
// Every permission here is explained in README.md ("Permissions"). Keep the two in step.

/** Hosts the extension may always talk to: the defaults of the three endpoints. */
export const STATIC_HOSTS = [
  "https://api.devnet.solana.com/*", // default RPC endpoint
  "http://127.0.0.1/*", // development relayer, screener, validator and connect page (any port)
  "http://localhost/*",
];

/**
 * `hosts`: the origins of the endpoints this build names as its defaults (LOCH_RPC_URL, LOCH_RELAYER_URL, LOCH_SCREENER_URL).
 * `mainnetTesting`: the mainnet package. Its name and description are plain (the owner's decision, 2026-10-10); the status is stated inside the extension.
 */
export function manifest({ version, hosts = [], mainnetTesting = false }) {
  return {
    manifest_version: 3,
    name: mainnetTesting ? "Loch" : "Loch (devnet alpha)",
    short_name: "Loch",
    version,
    description: mainnetTesting
      ? "A shielded balance inside the Solana wallet you already use."
      : "A shielded balance inside the Solana wallet you already use. v0.1, devnet only, unaudited. Test SOL only.",
    minimum_chrome_version: "116",
    icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
    action: {
      default_title: mainnetTesting ? "Loch" : "Loch (devnet, unaudited)",
      default_popup: "app.html?view=popup",
      default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png" },
    },
    background: { service_worker: "background.js", type: "module" },
    content_scripts: [
      // Isolated world: the bridge's trusted half and the in-page dialog.
      { matches: ["http://*/*", "https://*/*"], js: ["content.js"], run_at: "document_start", all_frames: false },
      // Page world: talks to wallets through the Wallet Standard and registers the Loch wallet.
      // It is injected everywhere and stays inert and silent until the content script tells it
      // otherwise (src/inpage/index.ts). Injecting it only where it is needed would take
      // chrome.scripting and host access to every site, which this extension does not ask for.
      // The two entries stay in this order and in the same run_at: they hand each other a
      // private port while the document is still empty.
      { matches: ["http://*/*", "https://*/*"], js: ["inpage.js"], run_at: "document_start", all_frames: false, world: "MAIN" },
    ],
    permissions: ["storage", "offscreen"],
    host_permissions: [...STATIC_HOSTS, ...hosts.map((origin) => `${origin}/*`).filter((host) => !STATIC_HOSTS.includes(host))],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    content_security_policy: {
      // Scripts and styles from the package only; WebAssembly for the prover; network only to
      // https endpoints and to this machine. No remote code, fonts, images or frames.
      extension_pages: [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "object-src 'none'",
        // No inline styles at all: neither the chart helpers nor the icon sprite emit a style
        // attribute, and the one custom property the interface sets (--progress) goes through
        // the CSSOM, which this does not restrict.
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
        "frame-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
    },
  };
}
