// ohttp-js ships its types outside its package "exports", so the compiler
// cannot find them. This declares the part the interoperability test uses.
declare module "ohttp-js" {
  interface TheirKem {
    deserializePublicKey(key: ArrayBuffer): Promise<CryptoKey>;
  }
  export class KeyConfig {
    constructor(keyId: number);
  }
  export class PublicKeyConfig {
    publicKey: CryptoKey;
    suite: { kemContext(): Promise<TheirKem> };
    constructor(keyId: number, kem: never, kdf: never, aead: never, publicKey: never);
  }
  export class ServerResponse {
    encode(): Uint8Array;
  }
  export class ServerResponseContext {
    readonly encodedRequest: Uint8Array;
    encapsulate(encodedResponse: Uint8Array): Promise<ServerResponse>;
    request(): Request;
  }
  export class Server {
    constructor(config: KeyConfig);
    decodeAndDecapsulate(message: Uint8Array): Promise<ServerResponseContext>;
    encodeKeyConfigAsList(): Promise<Uint8Array>;
  }
  class ClientRequest {
    encode(): Uint8Array;
  }
  class ClientRequestContext {
    readonly request: ClientRequest;
    decodeAndDecapsulate(message: Uint8Array): Promise<Uint8Array>;
    decapsulateResponse(response: Response): Promise<Response>;
  }
  export class Client {
    constructor(config: PublicKeyConfig);
    encapsulate(encodedRequest: Uint8Array): Promise<ClientRequestContext>;
    encapsulateRequest(request: Request): Promise<ClientRequestContext>;
  }
}
