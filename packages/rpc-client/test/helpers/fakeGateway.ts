// An Oblivious HTTP relay and gateway in memory, built on the protocol
// primitives, behind a function with the signature of fetch. No sockets.

import { type BinaryRequest, type BinaryResponse, decodeRequest, encodeResponse } from "../../src/bhttp.js";
import { OhttpError } from "../../src/errors.js";
import { MEDIA_TYPE_KEYS, MEDIA_TYPE_RESPONSE, encodeKeyConfigList } from "../../src/keyConfig.js";
import { type GatewayKey, decapsulateRequest, gatewayKeyConfig, generateGatewaySecretKey, importGatewayKey } from "../../src/ohttp.js";

export const RELAY_URL = "https://relay.example/ohttp";
export const KEYS_URL = "https://keys.example/ohttp-keys";

/** What the relay saw of one request. */
export interface OuterRequest {
  url: string;
  init: RequestInit;
  bodyLength: number;
}

export interface FakeGateway {
  /** Use as the `fetch` option. Serves RELAY_URL and KEYS_URL; anything else fails like an unreachable host. */
  fetch: typeof fetch;
  /** Current content of `application/ohttp-keys`. */
  keyConfigList(): Uint8Array;
  /** Hex public key of the current key. */
  publicKeyHex(): string;
  /**
   * Further keys the gateway decrypts with, of any KEM, each with a key
   * identifier of its own. Listed after the current key in `keyConfigList`.
   */
  moreKeys: GatewayKey[];
  /** KEM identifier each decrypted request was encrypted with. */
  kems: number[];
  /** Replaces the key with a fresh one (the one from `prepareRotation`, if it was called); the old one stops working at once. */
  rotate(): Promise<void>;
  /** Generates the key the next `rotate` will switch to and returns its public key in hex, so that a client can pin it beforehand. */
  prepareRotation(): Promise<string>;
  outer: OuterRequest[];
  inner: BinaryRequest[];
  /** Length of each decrypted Binary HTTP request, padding included. */
  innerLengths: number[];
  keyFetches: OuterRequest[];
  /** The target resource. Default: echoes the request as JSON. */
  handler: (request: BinaryRequest) => BinaryResponse | Promise<BinaryResponse>;
  /** If set, replaces the relay's whole behaviour for the next request only. */
  nextRelayAnswer: ((body: Uint8Array) => Response | Promise<Response>) | undefined;
  /** If set, transforms the encapsulated response before it is returned. */
  tamper: ((sealed: Uint8Array) => Uint8Array) | undefined;
  /** If set, the gateway seals these bytes instead of a Binary HTTP response. */
  rawResponse: Uint8Array | undefined;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export const jsonResponse = (status: number, value: unknown): BinaryResponse => ({
  status,
  headers: [["content-type", "application/json"]],
  content: new TextEncoder().encode(JSON.stringify(value)),
});

export async function makeGateway(keyId = 1, aeads?: number[]): Promise<FakeGateway> {
  let key: GatewayKey = await importGatewayKey(keyId, generateGatewaySecretKey(), aeads);
  let next: GatewayKey | undefined;

  const gateway: FakeGateway = {
    outer: [],
    inner: [],
    innerLengths: [],
    moreKeys: [],
    kems: [],
    keyFetches: [],
    nextRelayAnswer: undefined,
    tamper: undefined,
    rawResponse: undefined,
    handler: (request) =>
      jsonResponse(200, {
        method: request.method,
        scheme: request.scheme,
        authority: request.authority,
        path: request.path,
        headers: request.headers,
        body: new TextDecoder().decode(request.content),
      }),
    keyConfigList: () => encodeKeyConfigList([key, ...gateway.moreKeys].map(gatewayKeyConfig)),
    publicKeyHex: () => hex(key.publicKey),
    async rotate() {
      key = next ?? (await importGatewayKey((key.keyId + 1) % 256, generateGatewaySecretKey(), aeads));
      next = undefined;
    },
    async prepareRotation() {
      next = await importGatewayKey((key.keyId + 1) % 256, generateGatewaySecretKey(), aeads);
      return hex(next.publicKey);
    },
    fetch: async (input, init = {}) => {
      const url = String(input);
      // An aborted signal rejects, as the platform fetch does.
      init.signal?.throwIfAborted();
      if (url === KEYS_URL) {
        gateway.keyFetches.push({ url, init, bodyLength: 0 });
        return new Response(gateway.keyConfigList() as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": MEDIA_TYPE_KEYS } });
      }
      if (url !== RELAY_URL) throw new TypeError("fetch failed");
      const body = new Uint8Array(init.body as Uint8Array);
      gateway.outer.push({ url, init, bodyLength: body.length });
      if (gateway.nextRelayAnswer) {
        const answer = gateway.nextRelayAnswer;
        gateway.nextRelayAnswer = undefined;
        return answer(body);
      }
      let decapsulated;
      try {
        decapsulated = await decapsulateRequest((id) => [key, ...gateway.moreKeys].find((candidate) => candidate.keyId === id), body);
      } catch (error) {
        const unknownKey = error instanceof OhttpError && error.code === "unknown_key";
        return new Response(
          JSON.stringify(unknownKey ? { type: "https://iana.org/assignments/http-problem-types#ohttp-key", title: "key identifier unknown" } : { title: "bad request" }),
          { status: 400, headers: { "content-type": "application/problem+json" } },
        );
      }
      gateway.innerLengths.push(decapsulated.request.length);
      gateway.kems.push((body[1]! << 8) | body[2]!);
      const request = decodeRequest(decapsulated.request);
      gateway.inner.push(request);
      const plain = gateway.rawResponse ?? encodeResponse(await gateway.handler(request));
      let sealed = await decapsulated.sealResponse(plain);
      if (gateway.tamper) sealed = gateway.tamper(sealed);
      return new Response(sealed as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": MEDIA_TYPE_RESPONSE } });
    },
  };
  return gateway;
}
