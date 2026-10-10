// The test vectors of the X-Wing specification, draft-connolly-cfrg-xwing-kem
// revision 11, Appendix C ("Test vectors"). The seeds, the encapsulation
// randomness and the shared secrets below are copied from the draft. Its
// public keys (1216 bytes) and ciphertexts (1120 bytes) are not copied out in
// full: each is given by its SHA-256 and its first 16 bytes, computed from the
// draft's text.
//
// The draft fixes the two random inputs (the seed of the key pair and the 64
// bytes of the encapsulation), so key generation and encapsulation can be
// reproduced byte for byte. They are reproduced through this package's own
// codec: the public key as a gateway derives it from its stored secret key,
// the ciphertext as it stands in an encapsulated request.

import { XWing } from "@hpke/hybridkem-x-wing";
import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes } from "../src/bytes.js";
import { KEM_X_WING } from "../src/keyConfig.js";
import { encapsulateRequest, gatewayKeyConfig, importGatewayKey } from "../src/ohttp.js";

const VECTORS = [
  {
    seed: "7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26",
    publicKeySha256: "2e816deebcd76c5c80d0cd2d174478871658e8e2ff42bc9d4a6e486372e856bb",
    publicKeyStart: "e2236b35a8c24b39b10aa1323a96a919",
    eseed: "3cb1eea988004b93103cfb0aeefd2a686e01fa4a58e8a3639ca8a1e3f9ae57e2" + "35b8cc873c23dc62b8d260169afa2f75ab916a58d974918835d25e6a435085b2",
    encapsulatedKeySha256: "17cd532d657e44c897ca6583e548a5424fc70bf54f99515a4d2bcf99e3469f33",
    encapsulatedKeyStart: "b83aa828d4d62b9a83ceffe1d3d3bb1e",
    sharedSecret: "d2df0522128f09dd8e2c92b1e905c793d8f57a54c3da25861f10bf4ca613e384",
  },
  {
    seed: "badfd6dfaac359a5efbb7bcc4b59d538df9a04302e10c8bc1cbf1a0b3a5120ea",
    publicKeySha256: "c42ba5f8430d7d2c83739338203819f090e8303ce9c8b02107c272bfa5376916",
    publicKeyStart: "0333285fa253661508c9fb444852caa4",
    eseed: "17cda7cfad765f5623474d368ccca8af0007cd9f5e4c849f167a580b14aabdef" + "aee7eef47cb0fca9767be1fda69419dfb927e9df07348b196691abaeb580b32d",
    encapsulatedKeySha256: "1661ea86d608a1924ba30840cb0a65f13ae051e3aec9cf0f064efc0bc92f2154",
    encapsulatedKeyStart: "c93beb22326705699bbc3d1d0aa6339b",
    sharedSecret: "f2e86241c64d60f6649fbc6c5b7d17180b780a3f34355e64a85749949c45f150",
  },
  {
    seed: "ef58538b8d23f87732ea63b02b4fa0f4873360e2841928cd60dd4cee8cc0d4c9",
    publicKeySha256: "6b080d6b84f095342092fa7a22423e58bd681397ad0ef00eac92bd254db4fa95",
    publicKeyStart: "36244278824f77c621c660892c1c3886",
    eseed: "22a96188d032675c8ac850933c7aff1533b94c834adbb69c6115bad4692d8619" + "f90b0cdf8a7b9c264029ac185b70b83f2801f2f4b3f70c593ea3aeeb613a7f1b",
    encapsulatedKeySha256: "d3ca5578500344b5896cffc4fd740c9311946b82951df155e6fd86a7966b43c6",
    encapsulatedKeyStart: "0d2e38cbf17a2e2e4e0c87a94ca1e770",
    sharedSecret: "953f7f4e8c5b5049bdc771d1dffada0dd961477d1a2ae0988baa7ea6898d893f",
  },
];

const sha256 = async (bytes: Uint8Array) => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));

describe("draft-connolly-cfrg-xwing-kem-11, Appendix C", () => {
  it.each(VECTORS.map((vector, index) => [index + 1, vector] as const))("vector %i: key pair, encapsulation and shared secret", async (_, vector) => {
    // KeyGen: the gateway's public key from its 32-byte secret key.
    const key = await importGatewayKey(1, hexToBytes(vector.seed), undefined, KEM_X_WING);
    expect(key.publicKey).toHaveLength(1216);
    expect(bytesToHex(key.publicKey.subarray(0, 16))).toBe(vector.publicKeyStart);
    expect(await sha256(key.publicKey)).toBe(vector.publicKeySha256);

    // Encapsulate: the encapsulated key of a request, from the draft's randomness.
    const encapsulated = await encapsulateRequest(gatewayKeyConfig(key), new Uint8Array(16), { unsafeEphemeralSecretKey: hexToBytes(vector.eseed) });
    const enc = encapsulated.message.subarray(7, 7 + 1120);
    expect(bytesToHex(enc.subarray(0, 16))).toBe(vector.encapsulatedKeyStart);
    expect(await sha256(enc)).toBe(vector.encapsulatedKeySha256);

    // Decapsulate: the shared secret, which the codec does not expose, from the KEM it uses.
    const sharedSecret = new Uint8Array(await new XWing().decap({ recipientKey: key.privateKey, enc }));
    expect(bytesToHex(sharedSecret)).toBe(vector.sharedSecret);
  });
});
