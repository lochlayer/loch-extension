/** Facts about this build (version, prover artifact hashes). In tests there is no build. */
export const BUILD: typeof __LOCH_BUILD__ =
  typeof __LOCH_BUILD__ !== "undefined"
    ? __LOCH_BUILD__
    : { version: "0.0.0-test", artifacts: {}, network: "devnet", mainnetTesting: false, setup: "test", circuit: "test", connectUrl: null, relayerUrl: null, screenerUrl: null };

/** Runtime settings and dapps cannot enable this; it is chosen when packaging the extension. */
export function mainnetTestingEnabled(): boolean {
  return BUILD.mainnetTesting === true;
}

/**
 * The connect page compiled into this build, or null when it is a setting (development builds).
 * A release build sets it (`node scripts/build.mjs --connect-url https://...`): the page the
 * wallet is asked on is then a constant of the package and no stored value can move it.
 */
export function fixedConnectUrl(): string | null {
  return typeof BUILD.connectUrl === "string" && BUILD.connectUrl.length > 0 ? BUILD.connectUrl : null;
}

/** The relayer and screening service this build starts a new installation with, when it names them. They remain settings. */
export function defaultServiceUrls(): { relayerUrl: string | null; screenerUrl: string | null } {
  const given = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  return { relayerUrl: given(BUILD.relayerUrl), screenerUrl: given(BUILD.screenerUrl) };
}
