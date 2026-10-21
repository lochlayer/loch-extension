import { type Socket, createServer } from "node:net";
import type { AddressInfo } from "node:net";

import { base58 } from "@scure/base";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "../src/bytes.js";
import { BASE_FIELD_MODULUS, DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, LIGHTHOUSE_PROGRAM_ID } from "../src/constants.js";
import {
  FIELD_MODULUS,
  PROGRAM_ID,
  type TransactArgs,
  buildTransactInstruction,
  buildTransactTransaction,
  configPda,
  encodeTransactArgs,
  fieldToBytes,
  nullifierPda,
  setLoadedAccountsDataSizeLimit,
  treePda,
  vaultPda,
} from "../src/index.js";
import type { AnyTransaction } from "../src/transactionV1.js";
import {
  MAX_LIGHTHOUSE_INSTRUCTIONS,
  RelayerClient,
  type RelayRequest,
  ScreenerClient,
  WIRE_ERROR_CODES,
  WIRE_ERROR_STATUS,
  WireError,
  type WireRequestInit,
  applyScreenerSignature,
  checkRelayRequest,
  fromRelayRequest,
  inspectDepositTransaction,
  parseScreenTransaction,
  toRelayRequest,
  toScreenRequest,
  validateErrorBody,
  validateRelayRequest,
  validateRelayResponse,
  validateRelayerInfo,
  validateScreenRequest,
  validateScreenResponse,
  validateScreenerInfo,
} from "../src/wire.js";
import { VECTOR_PATH, address, readJson, wallet } from "./helpers/fixtures.js";

const vector = readJson(VECTOR_PATH);
const BLOCKHASH = "11111111111111111111111111111111";
const relayer = wallet("relayer");
const depositor = wallet("alice");
const screener = wallet("screener");

function sampleArgs(overrides: Partial<TransactArgs["extData"]> = {}): TransactArgs {
  return {
    proof: { a: hexToBytes(vector.program.proofA), b: hexToBytes(vector.program.proofB), c: hexToBytes(vector.program.proofC) },
    root: hexToBytes(vector.program.root),
    inputNullifiers: [hexToBytes(vector.program.inputNullifiers[0]), hexToBytes(vector.program.inputNullifiers[1])],
    outputCommitments: [hexToBytes(vector.program.outputCommitments[0]), hexToBytes(vector.program.outputCommitments[1])],
    extData: {
      recipient: address("recipient"),
      relayer: relayer.publicKey,
      extAmount: -1_500_000_000n,
      fee: 5_000n,
      encryptedOutput0: randomBytes(87),
      encryptedOutput1: randomBytes(87),
      ...overrides,
    },
  };
}

const goodRelayRequest = (): RelayRequest => toRelayRequest(sampleArgs());

/** Applies a change to a deep copy and returns the validation result. */
function relayWith(mutate: (body: any) => void) {
  const body = JSON.parse(JSON.stringify(goodRelayRequest()));
  mutate(body);
  return validateRelayRequest(body);
}

const errorOf = (result: { ok: boolean; error?: WireError }) => (result.ok ? null : { code: result.error!.code, status: result.error!.status });

/** A proof part (hex) with `times * q` added to its 32-byte word number `word`: the same curve point to a verifier that reduces mod q. */
function plusQ(part: string, word: number, times = 1n): string {
  const value = BigInt(`0x${part.slice(word * 64, word * 64 + 64)}`) + times * BASE_FIELD_MODULUS;
  const hex = value.toString(16).padStart(64, "0");
  if (hex.length !== 64) throw new Error("the aliased coordinate does not fit in 32 bytes");
  return part.slice(0, word * 64) + hex + part.slice(word * 64 + 64);
}

describe("wire encoding of a relay request", () => {
  it("uses base58 keys, lowercase hex fields and proof, base64 blobs, decimal amounts", () => {
    const args = sampleArgs();
    const request = toRelayRequest(args);
    expect(request.proof).toEqual({ a: vector.program.proofA, b: vector.program.proofB, c: vector.program.proofC });
    expect(request.root).toBe(vector.program.root);
    expect(request.inputNullifiers).toEqual(vector.program.inputNullifiers);
    expect(request.outputCommitments).toEqual(vector.program.outputCommitments);
    expect(request.extData.recipient).toBe(args.extData.recipient.toBase58());
    expect(request.extData.relayer).toBe(relayer.publicKey.toBase58());
    expect(request.extData.extAmount).toBe("-1500000000");
    expect(request.extData.fee).toBe("5000");
    expect(request.extData.encryptedOutput0).toBe(Buffer.from(args.extData.encryptedOutput0).toString("base64"));
    expect(request.extData.encryptedOutput0).toHaveLength(116);
  });

  it("round-trips through JSON to the same instruction data", () => {
    const args = sampleArgs();
    const overTheWire = JSON.parse(JSON.stringify(toRelayRequest(args)));
    const validated = validateRelayRequest(overTheWire);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const back = fromRelayRequest(validated.value);
    expect(back).toEqual(args);
    expect(encodeTransactArgs(back)).toEqual(encodeTransactArgs(args));
  });

  it("accepts a transfer (extAmount 0) and drops unknown properties", () => {
    const result = relayWith((body) => {
      body.extData.extAmount = "0";
      body.extra = "ignored";
      body.extData.note = "ignored";
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty("extra");
      expect(result.value.extData).not.toHaveProperty("note");
    }
  });
});

describe("validateRelayRequest", () => {
  it("rejects deposits with their own code", () => {
    expect(errorOf(relayWith((body) => (body.extData.extAmount = "1")))).toEqual({ code: "deposit_not_relayed", status: 400 });
    expect(errorOf(relayWith((body) => (body.extData.extAmount = "9223372036854775807")))).toEqual({ code: "deposit_not_relayed", status: 400 });
  });

  it.each<[string, (body: any) => void]>([
    ["missing proof", (body) => delete body.proof],
    ["proof.a too short", (body) => (body.proof.a = body.proof.a.slice(2))],
    ["proof.b upper case", (body) => (body.proof.b = body.proof.b.toUpperCase())],
    ["proof.c not hex", (body) => (body.proof.c = "zz".repeat(64))],
    ["proof.c with 0x", (body) => (body.proof.c = `0x${body.proof.c.slice(2)}`)],
    ["proof.a all zero", (body) => (body.proof.a = "00".repeat(64))],
    ["proof.b all zero", (body) => (body.proof.b = "00".repeat(128))],
    ["proof.c all zero", (body) => (body.proof.c = "00".repeat(64))],
    ["proof.a x not below q", (body) => (body.proof.a = plusQ(body.proof.a, 0))],
    ["proof.a y not below q", (body) => (body.proof.a = plusQ(body.proof.a, 1))],
    ["proof.b first limb not below q", (body) => (body.proof.b = plusQ(body.proof.b, 0))],
    ["proof.b third limb not below q", (body) => (body.proof.b = plusQ(body.proof.b, 2))],
    ["proof.b last limb not below q", (body) => (body.proof.b = plusQ(body.proof.b, 3))],
    ["proof.c x not below q", (body) => (body.proof.c = plusQ(body.proof.c, 0))],
    ["proof.c y plus 2q", (body) => (body.proof.c = plusQ(body.proof.c, 1, 2n))],
    ["proof.c y equal to q", (body) => (body.proof.c = body.proof.c.slice(0, 64) + BASE_FIELD_MODULUS.toString(16).padStart(64, "0"))],
    ["root too long", (body) => (body.root += "00")],
    ["root not below r", (body) => (body.root = bytesToHex(concatBytes(new Uint8Array(0), hexToBytes(FIELD_MODULUS.toString(16)))))],
    ["root all ff", (body) => (body.root = "ff".repeat(32))],
    ["nullifier not below r", (body) => (body.inputNullifiers[1] = FIELD_MODULUS.toString(16))],
    ["one nullifier", (body) => (body.inputNullifiers = [body.inputNullifiers[0]])],
    ["three commitments", (body) => body.outputCommitments.push(body.outputCommitments[0])],
    ["nullifiers as numbers", (body) => (body.inputNullifiers = [1, 2])],
    ["equal nullifiers", (body) => (body.inputNullifiers[1] = body.inputNullifiers[0])],
    ["recipient not base58", (body) => (body.extData.recipient = "0OIl")],
    ["recipient wrong size", (body) => (body.extData.recipient = base58.encode(new Uint8Array(31)))],
    ["relayer missing", (body) => delete body.extData.relayer],
    ["extAmount as a number", (body) => (body.extData.extAmount = -5)],
    ["extAmount with a plus", (body) => (body.extData.extAmount = "+5")],
    ["extAmount negative zero", (body) => (body.extData.extAmount = "-0")],
    ["extAmount with leading zero", (body) => (body.extData.extAmount = "-05")],
    ["extAmount below i64", (body) => (body.extData.extAmount = "-9223372036854775809")],
    ["extAmount fractional", (body) => (body.extData.extAmount = "-1.5")],
    ["fee negative", (body) => (body.extData.fee = "-1")],
    ["fee above u64", (body) => (body.extData.fee = "18446744073709551616")],
    ["fee hex", (body) => (body.extData.fee = "0x10")],
    ["fee empty", (body) => (body.extData.fee = "")],
    ["output not base64", (body) => (body.extData.encryptedOutput0 = "@@@@")],
    ["output without padding", (body) => (body.extData.encryptedOutput1 = "QQ")],
    ["output too large", (body) => (body.extData.encryptedOutput0 = Buffer.alloc(257).toString("base64"))],
    ["output as a number", (body) => (body.extData.encryptedOutput0 = 5)],
    ["extData missing", (body) => delete body.extData],
    ["extData an array", (body) => (body.extData = [])],
  ])("rejects %s as invalid_request", (_, mutate) => {
    expect(errorOf(relayWith(mutate))).toEqual({ code: "invalid_request", status: 400 });
  });

  it("rejects bodies that are not objects", () => {
    for (const body of [null, undefined, "{}", 5, [], true]) {
      expect(errorOf(validateRelayRequest(body))).toEqual({ code: "invalid_request", status: 400 });
    }
  });

  it("says which field is wrong, without echoing its value", () => {
    const result = relayWith((body) => (body.extData.fee = "-777"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/extData\.fee/);
      expect(result.error.message).not.toContain("777");
      expect(result.error.toBody()).toEqual({ error: { code: "invalid_request", message: result.error.message } });
    }
  });

  it("accepts the extremes", () => {
    expect(relayWith((body) => (body.extData.extAmount = "-9223372036854775808")).ok).toBe(true);
    expect(relayWith((body) => (body.extData.fee = "18446744073709551615")).ok).toBe(true);
    expect(relayWith((body) => (body.extData.encryptedOutput0 = Buffer.alloc(256).toString("base64"))).ok).toBe(true);
    expect(relayWith((body) => (body.extData.encryptedOutput1 = "")).ok).toBe(true);
    expect(relayWith((body) => (body.root = bytesToHex(fieldToBytes(FIELD_MODULUS - 1n)))).ok).toBe(true);
    // The largest coordinate there is: q - 1.
    const top = (BASE_FIELD_MODULUS - 1n).toString(16).padStart(64, "0");
    expect(relayWith((body) => (body.proof.c = top + top)).ok).toBe(true);
  });
});

describe("checkRelayRequest: a relayer's static checks", () => {
  const policy = { relayer: relayer.publicKey, feeLamports: 5_000n, minWithdrawalLamports: 1_000_000n };
  const codeOf = (args: TransactArgs, overrides: Partial<typeof policy> = {}) => {
    const result = checkRelayRequest(args, { ...policy, ...overrides });
    return result.ok ? "ok" : result.error.code;
  };

  it("accepts a withdrawal and a transfer that name this relayer and pay its fee", () => {
    const withdrawal = sampleArgs();
    const result = checkRelayRequest(withdrawal, policy);
    expect(result.ok && result.value).toBe(withdrawal);
    expect(codeOf(sampleArgs({ extAmount: 0n, recipient: relayer.publicKey }))).toBe("ok");
    expect(codeOf(sampleArgs({ fee: 5_000n }))).toBe("ok");
    // Without a minimum of its own the relayer leaves small withdrawals to the simulation.
    expect(checkRelayRequest(sampleArgs({ extAmount: -1n }), { relayer: relayer.publicKey, feeLamports: 0n }).ok).toBe(true);
  });

  it("answers each refusal with the protocol's code", () => {
    expect(codeOf(sampleArgs({ extAmount: 1n }))).toBe("deposit_not_relayed");
    expect(codeOf(sampleArgs({ relayer: address("another relayer") }))).toBe("wrong_relayer");
    expect(codeOf(sampleArgs({ extAmount: 0n }))).toBe("wrong_relayer"); // a transfer whose recipient is not the relayer
    expect(codeOf(sampleArgs({ fee: 4_999n }))).toBe("fee_too_low");
    expect(codeOf(sampleArgs({ extAmount: -999_999n }))).toBe("withdrawal_too_small");
    expect(codeOf(sampleArgs({ extAmount: -1_000_000n }))).toBe("ok");
    const refused = checkRelayRequest(sampleArgs({ fee: 1n }), policy);
    expect(!refused.ok && refused.error.status).toBe(400);
  });

  it("refuses recipients a withdrawal cannot be paid to, which would cost the relayer a failed transaction", () => {
    const args = sampleArgs();
    for (const recipient of [
      vaultPda(),
      treePda(),
      configPda(),
      nullifierPda(args.inputNullifiers[0]),
      nullifierPda(args.inputNullifiers[1]),
      PROGRAM_ID,
      SystemProgram.programId,
    ]) {
      expect(codeOf(sampleArgs({ recipient }))).toBe("invalid_request");
    }
    // For another deployment the pool accounts are other addresses.
    const elsewhere = address("another deployment");
    expect(codeOf(sampleArgs({ recipient: vaultPda(elsewhere) }))).toBe("ok");
    expect(checkRelayRequest(sampleArgs({ recipient: vaultPda(elsewhere) }), { ...policy, programId: elsewhere }).ok).toBe(false);
  });

  it("refuses a proof the program's verifier would refuse to parse", () => {
    const args = sampleArgs();
    const aliased = { ...args, proof: { ...args.proof, a: hexToBytes(plusQ(bytesToHex(args.proof.a), 0)) } };
    expect(codeOf(aliased)).toBe("invalid_request");
    expect(codeOf({ ...args, proof: { ...args.proof, b: new Uint8Array(128) } })).toBe("invalid_request");
  });
});

const relayerInfo = () => ({
  version: "0.1.0",
  cluster: "devnet",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  programId: PROGRAM_ID.toBase58(),
  relayer: relayer.publicKey.toBase58(),
  feeLamports: "2500000",
  computeUnitLimit: 300_000,
});

const screenerInfo = () => ({
  version: "0.1.0",
  cluster: "devnet",
  programId: PROGRAM_ID.toBase58(),
  screener: screener.publicKey.toBase58(),
  maxDepositLamports: "10000000000",
  policy: "Sanctions screening of the depositing address.",
});

describe("response validators", () => {
  it("accept a well-formed relayer info, with and without the optional fields", () => {
    expect(validateRelayerInfo(relayerInfo())).toEqual({ ok: true, value: relayerInfo() });
    const full = { ...relayerInfo(), minWithdrawalLamports: "1000000", lookupTable: address("lookup table").toBase58() };
    expect(validateRelayerInfo({ ...full, unknown: 1 })).toEqual({ ok: true, value: full });
    expect(validateRelayerInfo({ ...relayerInfo(), cluster: "localnet" }).ok).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["missing version", { version: undefined }],
    ["unknown cluster", { cluster: "mainnet" }],
    ["genesis hash not a hash", { genesisHash: "abc" }],
    ["program id hex", { programId: "00".repeat(32) }],
    ["fee as a number", { feeLamports: 2_500_000 }],
    ["fee negative", { feeLamports: "-1" }],
    ["compute units as a string", { computeUnitLimit: "300000" }],
    ["compute units too high", { computeUnitLimit: 1_400_001 }],
    ["compute units fractional", { computeUnitLimit: 1.5 }],
    ["bad lookup table", { lookupTable: "nope" }],
    ["bad minimum withdrawal", { minWithdrawalLamports: "1e9" }],
  ])("reject a relayer info with %s as bad_response", (_, patch) => {
    expect(errorOf(validateRelayerInfo({ ...relayerInfo(), ...patch }))).toEqual({ code: "bad_response", status: null });
  });

  it("validate a relay response: a base58 transaction id", () => {
    const signature = base58.encode(randomBytes(64));
    expect(validateRelayResponse({ signature })).toEqual({ ok: true, value: { signature } });
    expect(errorOf(validateRelayResponse({ signature: base58.encode(randomBytes(32)) }))?.code).toBe("bad_response");
    expect(errorOf(validateRelayResponse({ signature: Buffer.alloc(64).toString("base64") }))?.code).toBe("bad_response");
    expect(errorOf(validateRelayResponse({}))?.code).toBe("bad_response");
  });

  it("validate screener info", () => {
    expect(validateScreenerInfo(screenerInfo())).toEqual({ ok: true, value: screenerInfo() });
    // A service may send more than the six fields (the reference screener adds `policyVersion`): accepted, and left out of the result.
    expect(validateScreenerInfo({ ...screenerInfo(), policyVersion: "2026-10+3f9c2a71d0e4", somethingNewer: 1 })).toEqual({ ok: true, value: screenerInfo() });
    expect(errorOf(validateScreenerInfo({ ...screenerInfo(), policy: "" }))?.code).toBe("bad_response");
    expect(errorOf(validateScreenerInfo({ ...screenerInfo(), screener: "x" }))?.code).toBe("bad_response");
    expect(errorOf(validateScreenerInfo({ ...screenerInfo(), maxDepositLamports: 5 }))?.code).toBe("bad_response");
  });

  it("validate a screen request and response", () => {
    expect(validateScreenRequest({ transaction: "AQID" })).toEqual({ ok: true, value: { transaction: "AQID" } });
    expect(errorOf(validateScreenRequest({ transaction: "" }))).toEqual({ code: "invalid_request", status: 400 });
    expect(errorOf(validateScreenRequest({ transaction: Buffer.alloc(1233).toString("base64") }))?.code).toBe("invalid_request");
    expect(errorOf(validateScreenRequest({ transaction: "not base64" }))?.code).toBe("invalid_request");
    expect(errorOf(validateScreenRequest({}))?.code).toBe("invalid_request");

    const response = { signature: Buffer.alloc(64, 7).toString("base64"), screener: screener.publicKey.toBase58() };
    expect(validateScreenResponse(response)).toEqual({ ok: true, value: response });
    expect(errorOf(validateScreenResponse({ ...response, signature: Buffer.alloc(63).toString("base64") }))?.code).toBe("bad_response");
    expect(errorOf(validateScreenResponse({ ...response, signature: base58.encode(randomBytes(64)) }))?.code).toBe("bad_response");
    expect(errorOf(validateScreenResponse({ ...response, screener: 5 }))?.code).toBe("bad_response");
  });

  it("validate an error body", () => {
    const body = { error: { code: "unknown_root", message: "sync and prove again" } };
    expect(validateErrorBody(body)).toEqual({ ok: true, value: body });
    expect(validateErrorBody({ error: "nope" }).ok).toBe(false);
    expect(validateErrorBody({ error: { code: 5, message: "x" } }).ok).toBe(false);
    expect(validateErrorBody({ message: "x" }).ok).toBe(false);
  });

  it("gives every service error code an HTTP status", () => {
    const serviceCodes = WIRE_ERROR_CODES.filter((code) => code !== "network_error" && code !== "bad_response");
    expect(Object.keys(WIRE_ERROR_STATUS).sort()).toEqual([...serviceCodes].sort());
    expect(WIRE_ERROR_STATUS.unknown_root).toBe(409);
    expect(WIRE_ERROR_STATUS.denied).toBe(403);
    expect(new Set(WIRE_ERROR_CODES).size).toBe(WIRE_ERROR_CODES.length);
  });
});

/** A fetch that records requests and answers from a script. */
function fakeFetch(answers: Array<{ status: number; body: unknown } | Error>) {
  const requests: Array<{ url: string; init: WireRequestInit }> = [];
  const fetch = async (url: string, init: WireRequestInit) => {
    requests.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error("no scripted answer left");
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)) };
  };
  return { fetch, requests };
}

describe("RelayerClient", () => {
  it("GETs /v1/info and returns the validated body", async () => {
    const { fetch, requests } = fakeFetch([{ status: 200, body: { ...relayerInfo(), extra: true } }]);
    const client = new RelayerClient("https://relayer.example/", { fetch });
    expect(await client.info()).toEqual(relayerInfo());
    expect(requests[0]!.url).toBe("https://relayer.example/v1/info");
    expect(requests[0]!.init.method).toBe("GET");
    expect(requests[0]!.init.body).toBeUndefined();
  });

  it("POSTs the request as JSON to /v1/relay, without cookies, referrer, cache or redirects", async () => {
    const signature = base58.encode(randomBytes(64));
    const { fetch, requests } = fakeFetch([{ status: 200, body: { signature } }]);
    const client = new RelayerClient("https://relayer.example/base", { fetch });
    const request = goodRelayRequest();
    expect(await client.relay(request)).toEqual({ signature });
    const { url, init } = requests[0]!;
    expect(url).toBe("https://relayer.example/base/v1/relay");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    expect(init.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    expect(JSON.parse(init.body!)).toEqual(request);
    // What was sent is accepted by the service-side validator.
    expect(validateRelayRequest(JSON.parse(init.body!)).ok).toBe(true);
  });

  it("turns an error body into a WireError with the service's code and status", async () => {
    const { fetch } = fakeFetch([
      { status: 409, body: { error: { code: "unknown_root", message: "root is not in recent history" } } },
      { status: 400, body: { error: { code: "fee_too_low", message: "fee below 2500000" } } },
      { status: 418, body: { error: { code: "a_code_from_the_future", message: "new" } } },
    ]);
    const client = new RelayerClient("https://relayer.example", { fetch });
    const first = await client.relay(goodRelayRequest()).catch((error) => error);
    expect(first).toBeInstanceOf(WireError);
    expect(first).toMatchObject({ code: "unknown_root", status: 409, message: "root is not in recent history" });
    await expect(client.relay(goodRelayRequest())).rejects.toMatchObject({ code: "fee_too_low", status: 400 });
    await expect(client.relay(goodRelayRequest())).rejects.toMatchObject({ code: "a_code_from_the_future", status: 418 });
  });

  it("reports anything else the service says as bad_response", async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: "<html>hello</html>" },
      { status: 200, body: { signature: 5 } },
      { status: 502, body: "Bad Gateway" },
      { status: 500, body: { oops: true } },
      { status: 200, body: "x".repeat(70_000) },
    ]);
    const client = new RelayerClient("https://relayer.example", { fetch });
    for (const status of [200, 200, 502, 500, 200]) {
      await expect(client.relay(goodRelayRequest())).rejects.toMatchObject({ code: "bad_response", status });
    }
  });

  it("reports a transport failure as network_error and lets an abort through", async () => {
    const { fetch } = fakeFetch([new TypeError("fetch failed")]);
    const client = new RelayerClient("https://relayer.example", { fetch });
    const error = await client.info().catch((e) => e);
    expect(error).toMatchObject({ code: "network_error", status: null });
    expect(error.cause).toBeInstanceOf(TypeError);

    const controller = new AbortController();
    const aborting = new RelayerClient("https://relayer.example", {
      fetch: async (_url, init) => {
        controller.abort(new Error("cancelled"));
        throw init.signal!.reason;
      },
    });
    await expect(aborting.info(controller.signal)).rejects.toThrow("cancelled");
  });

  it("says what kind of network_error it was: timeout, unreachable, aborted or other", async () => {
    const failing = (thrown: unknown) => new RelayerClient("https://relayer.example", { fetch: async () => Promise.reject(thrown) });
    const reasonOf = async (thrown: unknown) => {
      const error = await failing(thrown).relay(goodRelayRequest()).catch((e) => e);
      // The code, the status and the message are what they always were; the reason is extra.
      expect(error).toBeInstanceOf(WireError);
      expect(error).toMatchObject({ code: "network_error", status: null, message: "the service could not be reached" });
      expect(error.cause).toBe(thrown);
      return error.reason;
    };
    // What fetch rejects with when there is no response: a TypeError. Node puts the socket's error underneath.
    expect(await reasonOf(new TypeError("fetch failed"))).toBe("unreachable");
    expect(await reasonOf(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) }))).toBe("unreachable");
    expect(await reasonOf(new TypeError("Failed to fetch"))).toBe("unreachable");
    // A timeout below the client's own: of the transport, of the socket, of Node's fetch.
    expect(await reasonOf(new DOMException("The operation timed out.", "TimeoutError"))).toBe("timeout");
    expect(await reasonOf(new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }))).toBe("timeout");
    expect(await reasonOf(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe("timeout");
    // The transport gave up on its own: neither the caller's signal nor the client's timeout.
    expect(await reasonOf(new DOMException("The operation was aborted.", "AbortError"))).toBe("aborted");
    // Anything else.
    expect(await reasonOf(new Error("the tunnel refused the request"))).toBe("other");
    expect(await reasonOf("a string")).toBe("other");
    expect(await reasonOf(undefined)).toBe("other");

    // A connection that breaks while the answer is being read: the service was reached.
    const broken = new RelayerClient("https://relayer.example", {
      fetch: async () => ({ status: 200, text: async () => Promise.reject(new TypeError("terminated")) }),
    });
    await expect(broken.info()).rejects.toMatchObject({ code: "network_error", reason: "other" });
  });

  it("puts nothing of the request into a network_error, and no reason on any other error", async () => {
    const request = goodRelayRequest();
    const secret = "a-header-value-that-must-not-leak";
    // A transport whose error quotes the request, as some do.
    const quoting = new RelayerClient("https://relayer.example", {
      headers: { "x-secret": secret },
      fetch: async (url, init) => Promise.reject(new TypeError(`request to ${url} failed: ${init.body}`)),
    });
    const error = await quoting.relay(request).catch((e) => e);
    expect(error.reason).toBe("unreachable");
    const shown = [error.message, String(error), JSON.stringify(error), JSON.stringify({ ...error }), JSON.stringify(error.toBody())].join("\n");
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: "WireError", code: "network_error", status: null, reason: "unreachable" });
    for (const value of [request.root, request.inputNullifiers[0], request.proof.a, request.extData.recipient, request.extData.encryptedOutput0, secret, "relayer.example"]) {
      expect(shown).not.toContain(value);
    }
    expect(error.toBody()).toEqual({ error: { code: "network_error", message: "the service could not be reached" } });

    // Errors that are not network errors have no such property at all.
    const { fetch } = fakeFetch([{ status: 409, body: { error: { code: "unknown_root", message: "sync" } } }, { status: 200, body: "<html>" }]);
    const client = new RelayerClient("https://relayer.example", { fetch });
    for (const code of ["unknown_root", "bad_response"]) {
      const other = await client.relay(request).catch((e) => e);
      expect(other.code).toBe(code);
      expect("reason" in other).toBe(false);
      expect(Object.keys(other).sort()).toEqual(["code", "name", "status"]);
    }
    expect("reason" in new WireError("network_error", "made by hand")).toBe(false);
    expect(new WireError("network_error", "made by hand", null, { reason: "aborted" }).reason).toBe("aborted");
    // A WireError a transport throws itself is passed on as it is.
    const own = new WireError("network_error", "the relay is down", null, { reason: "unreachable" });
    await expect(new RelayerClient("https://relayer.example", { fetch: async () => Promise.reject(own) }).info()).rejects.toBe(own);
  });

  it("tells a refused connection from a timeout over real sockets", async () => {
    // Loopback only. A port nobody listens on, and a server that accepts and never answers.
    const held: Socket[] = [];
    const silent = createServer((socket) => void held.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    try {
      const refused = await new RelayerClient(`http://127.0.0.1:${closedPort}`).info().catch((e) => e);
      expect(refused).toMatchObject({ code: "network_error", status: null, reason: "unreachable" });
      const slow = await new RelayerClient(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, { timeoutMs: 150 }).info().catch((e) => e);
      expect(slow).toMatchObject({ code: "network_error", status: null, reason: "timeout" });
      expect(slow.message).toMatch(/did not answer within/);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("sends extra headers and refuses a URL that is not http(s)", async () => {
    const { fetch, requests } = fakeFetch([{ status: 200, body: relayerInfo() }]);
    await new RelayerClient("http://127.0.0.1:8787", { fetch, headers: { "x-test": "1" } }).info();
    expect(requests[0]!.init.headers).toEqual({ "x-test": "1", accept: "application/json" });
    expect(() => new RelayerClient("relayer.example")).toThrow(WireError);
    expect(() => new RelayerClient("file:///etc/passwd")).toThrow(/http/);
  });

  it("refuses plain http for anything but this machine, unless explicitly allowed", () => {
    // On plain http anyone on the path can rewrite /v1/info: the relayer's key and its fee.
    // A name under .localhost is not this machine by definition: outside a browser it goes to the system resolver.
    for (const url of [
      "http://relayer.example",
      "http://relayer.example:8080/base",
      "http://10.0.0.5:8787",
      "http://localhost.evil.example",
      "http://dev.localhost/base/",
      "http://127.0.0.1.evil.example",
      "HTTP://RELAYER.EXAMPLE",
    ]) {
      expect(() => new RelayerClient(url)).toThrow(expect.objectContaining({ code: "invalid_request" }));
      expect(() => new ScreenerClient(url)).toThrow(/https/);
    }
    for (const url of ["https://relayer.example", "http://localhost:8787", "http://LOCALHOST:8787/base/", "http://127.0.0.1:8787", "http://127.9.9.9", "http://[::1]:8787"]) {
      expect(() => new RelayerClient(url)).not.toThrow();
    }
    expect(() => new RelayerClient("http://loch7relayerexampleonion.onion", { allowInsecureHttp: true })).not.toThrow();
    expect(() => new RelayerClient("http://dev.localhost/base/", { allowInsecureHttp: true })).not.toThrow();
    expect(() => new RelayerClient("ftp://relayer.example", { allowInsecureHttp: true })).toThrow(WireError);
  });

  it("stops reading a response at 64 KiB instead of buffering all of it", async () => {
    const chunk = new Uint8Array(16_384).fill(0x20);
    let delivered = 0;
    let cancelled = false;
    // A body that would go on for 200 MB.
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          delivered += chunk.byteLength;
          if (delivered > 200 * 1024 * 1024) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
    const streaming = new RelayerClient("https://relayer.example", {
      fetch: async () => ({ status: 200, body: endless(), text: async () => { throw new Error("text() must not be used when there is a stream"); } }),
    });
    await expect(streaming.info()).rejects.toMatchObject({ code: "bad_response", status: 200, message: /oversized/ });
    expect(cancelled).toBe(true);
    expect(delivered).toBeLessThanOrEqual(65_536 + 2 * chunk.byteLength);

    // A declared length over the cap is refused before a single byte is read.
    let read = false;
    const declared = new RelayerClient("https://relayer.example", {
      fetch: async () => ({
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? "209715200" : null) },
        text: async () => {
          read = true;
          return "{}";
        },
      }),
    });
    await expect(declared.info()).rejects.toMatchObject({ code: "bad_response" });
    expect(read).toBe(false);

    // A stream within the cap is read and validated as usual (the platform Response has both).
    const body = JSON.stringify(relayerInfo());
    const ok = new RelayerClient("https://relayer.example", { fetch: async () => new Response(body, { status: 200 }) });
    expect(await ok.info()).toEqual(relayerInfo());
  });

  it("gives up with network_error when the service does not answer in time", async () => {
    let seen: AbortSignal | undefined;
    // A transport that honours the signal, and one that ignores it: neither can hold the call.
    const hanging = (honour: boolean) => (_url: string, init: WireRequestInit) =>
      new Promise<never>((_, reject) => {
        seen = init.signal;
        if (honour) init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    for (const honour of [true, false]) {
      const client = new RelayerClient("https://relayer.example", { fetch: hanging(honour), timeoutMs: 30, relayTimeoutMs: 60 });
      const started = Date.now();
      const error = await client.info().catch((e) => e);
      expect(error).toBeInstanceOf(WireError);
      expect(error).toMatchObject({ code: "network_error", status: null, reason: "timeout" });
      expect(error.message).toMatch(/did not answer within/);
      expect(seen!.aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
      // relay() waits for confirmation and has its own, longer limit.
      await expect(client.relay(goodRelayRequest())).rejects.toMatchObject({ code: "network_error" });
    }
    // The caller's own abort is still passed through as it is.
    const controller = new AbortController();
    const client = new RelayerClient("https://relayer.example", { fetch: hanging(true) });
    const pending = client.info(controller.signal);
    controller.abort(new Error("closed the popup"));
    await expect(pending).rejects.toThrow("closed the popup");
    expect(() => new RelayerClient("https://relayer.example", { timeoutMs: -1 })).toThrow(WireError);
  });
});

function depositTransaction(options: { args?: TransactArgs; extra?: TransactionInstruction[]; signer?: PublicKey; screenerKey?: PublicKey | null; payer?: PublicKey; price?: number } = {}) {
  const args = options.args ?? sampleArgs({ recipient: depositor.publicKey, relayer: depositor.publicKey, extAmount: 1_000_000_000n, fee: 0n });
  const instruction = buildTransactInstruction(args, {
    signer: options.signer ?? depositor.publicKey,
    screener: options.screenerKey === undefined ? screener.publicKey : options.screenerKey,
  });
  if (!options.extra) {
    return buildTransactTransaction({ instruction, payer: options.payer ?? depositor.publicKey, recentBlockhash: BLOCKHASH, computeUnitPrice: options.price });
  }
  const message = new TransactionMessage({
    payerKey: options.payer ?? depositor.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [instruction, ...options.extra],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

const reasonOf = (transaction: AnyTransaction, options: { screener?: PublicKey; programId?: PublicKey } = {}) => {
  const result = inspectDepositTransaction(transaction, { screener: screener.publicKey, ...options });
  if (result.ok) return "accepted";
  expect(result.error.code).toBe("invalid_transaction");
  expect(result.error.status).toBe(400);
  return result.error.message;
};

describe("ScreenerClient and the screening handshake", () => {
  it("POSTs the serialised transaction as base64 to /v1/screen", async () => {
    const transaction = depositTransaction();
    const response = { signature: Buffer.alloc(64, 1).toString("base64"), screener: screener.publicKey.toBase58() };
    const { fetch, requests } = fakeFetch([{ status: 200, body: response }, { status: 403, body: { error: { code: "denied", message: "no" } } }, { status: 200, body: screenerInfo() }]);
    const client = new ScreenerClient("https://screener.example", { fetch });
    expect(await client.screen(toScreenRequest(transaction))).toEqual(response);
    expect(requests[0]!.url).toBe("https://screener.example/v1/screen");
    const sent = JSON.parse(requests[0]!.init.body!);
    expect(Buffer.from(sent.transaction, "base64")).toEqual(Buffer.from(transaction.serialize()));
    await expect(client.screen(toScreenRequest(transaction))).rejects.toMatchObject({ code: "denied", status: 403 });
    expect(await client.info()).toEqual(screenerInfo());
  });

  it("accepts exactly one canonical deposit and reports what it does", () => {
    const transaction = depositTransaction({ price: 5_000 });
    const parsed = parseScreenTransaction(toScreenRequest(transaction));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = inspectDepositTransaction(parsed.value, { screener: screener.publicKey });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { value } = result;
    expect(value.depositor.equals(depositor.publicKey)).toBe(true);
    expect(value.screener.equals(screener.publicKey)).toBe(true);
    expect(value.amount).toBe(1_000_000_000n);
    expect(value.fee).toBe(0n);
    expect(value.computeUnitLimit).toBe(300_000);
    expect(value.computeUnitPrice).toBe(5_000n);
    expect(value.screenerSignatureIndex).toBe(1);
    expect(value.accounts.signer.equals(depositor.publicKey)).toBe(true);
    expect(value.message).toEqual(transaction.message.serialize());
    expect(reasonOf(depositTransaction())).toBe("accepted");
  });

  it("refuses a transaction that would spend the screener's own funds", () => {
    // The screener's key as the deposit signer: its signature would pay for the attacker's note.
    const args = sampleArgs({ recipient: screener.publicKey, relayer: screener.publicKey, extAmount: 1_000_000_000n, fee: 0n });
    expect(reasonOf(depositTransaction({ args, signer: screener.publicKey, payer: depositor.publicKey }))).toMatch(/signer|two signers/);
    // An extra instruction that moves the screener's lamports.
    const drain = SystemProgram.transfer({ fromPubkey: screener.publicKey, toPubkey: depositor.publicKey, lamports: 1_000_000 });
    expect(reasonOf(depositTransaction({ extra: [drain] }))).toMatch(/two signers|another program/);
    // The screener as fee payer.
    expect(reasonOf(depositTransaction({ payer: screener.publicKey }))).not.toBe("accepted");
  });

  it("refuses anything besides compute budget and one transact", () => {
    const memo = new TransactionInstruction({ programId: address("memo program"), keys: [], data: Buffer.from("hi") });
    expect(reasonOf(depositTransaction({ extra: [memo] }))).toMatch(/another program/);
    const second = buildTransactInstruction(sampleArgs({ recipient: depositor.publicKey, relayer: depositor.publicKey, extAmount: 1n, fee: 0n }), {
      signer: depositor.publicKey,
      screener: screener.publicKey,
    });
    expect(reasonOf(depositTransaction({ extra: [second] }))).toMatch(/more than one/);
    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 });
    expect(reasonOf(depositTransaction({ extra: [heap] }))).toMatch(/SetComputeUnitLimit/);
    const twice = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 2 })];
    expect(reasonOf(depositTransaction({ extra: twice }))).toMatch(/only one/);
    const onlyBudget = new VersionedTransaction(
      new TransactionMessage({ payerKey: depositor.publicKey, recentBlockhash: BLOCKHASH, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })] }).compileToV0Message(),
    );
    expect(reasonOf(onlyBudget)).toMatch(/two signers|no loch_pool/);
  });

  it("refuses transfers, withdrawals and deposits that are not canonical", () => {
    const base = { recipient: depositor.publicKey, relayer: depositor.publicKey, fee: 0n };
    expect(reasonOf(depositTransaction({ args: sampleArgs({ ...base, extAmount: 0n }) }))).toMatch(/not positive/);
    expect(reasonOf(depositTransaction({ args: sampleArgs({ ...base, extAmount: -5n }) }))).toMatch(/not positive/);
    expect(reasonOf(depositTransaction({ args: sampleArgs({ ...base, extAmount: 5n, recipient: address("elsewhere") }) }))).toMatch(/recipient and relayer/);
    expect(reasonOf(depositTransaction({ args: sampleArgs({ ...base, extAmount: 5n, relayer: address("elsewhere") }) }))).toMatch(/recipient and relayer/);
    expect(reasonOf(depositTransaction({ screenerKey: null }))).toMatch(/two signers/);
    expect(reasonOf(depositTransaction(), { screener: address("our real key") })).toMatch(/different screening authority/);
    expect(reasonOf(depositTransaction(), { programId: address("another deployment") })).toMatch(/another program/);
  });

  it("always knows which screening authority it is checking for", () => {
    // A deposit that names some other key in the screener slot is well formed, and still not ours to sign.
    const stranger = Keypair.generate();
    const foreign = depositTransaction({ screenerKey: stranger.publicKey });
    expect(reasonOf(foreign)).toMatch(/different screening authority/);
    expect(inspectDepositTransaction(foreign, { screener: stranger.publicKey }).ok).toBe(true);
    // Leaving the key out is a bug in the service, not a property of the transaction.
    expect(() => inspectDepositTransaction(foreign, {} as never)).toThrow(expect.objectContaining({ code: "internal" }));
    expect(() => inspectDepositTransaction(foreign, undefined as never)).toThrow(WireError);
  });

  it("refuses accounts the program would not derive, trailing data, lookup tables and legacy transactions", () => {
    const good = depositTransaction();
    const keys = good.message.staticAccountKeys;
    const swap = (from: PublicKey, to: PublicKey) => {
      const copy = VersionedTransaction.deserialize(good.serialize());
      const index = copy.message.staticAccountKeys.findIndex((key) => key.equals(from));
      copy.message.staticAccountKeys[index] = to;
      return copy;
    };
    expect(keys.some((key) => key.equals(configPda()))).toBe(true);
    expect(reasonOf(swap(configPda(), address("fake config")))).toMatch(/config/);
    expect(reasonOf(swap(treePda(), address("fake tree")))).toMatch(/tree/);
    expect(reasonOf(swap(SystemProgram.programId, address("fake system")))).toMatch(/system program/);

    const padded = VersionedTransaction.deserialize(good.serialize());
    const transact = padded.message.compiledInstructions.find((ix) => ix.data.length > 100)!;
    transact.data = concatBytes(transact.data, Uint8Array.of(0));
    expect(reasonOf(padded)).toMatch(/well-formed/);

    const lookupTable = new AddressLookupTableAccount({
      key: address("lookup table"),
      state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [configPda(), treePda()] },
    });
    const instruction = buildTransactInstruction(sampleArgs({ recipient: depositor.publicKey, relayer: depositor.publicKey, extAmount: 5n, fee: 0n }), {
      signer: depositor.publicKey,
      screener: screener.publicKey,
    });
    const compressed = buildTransactTransaction({ instruction, payer: depositor.publicKey, recentBlockhash: BLOCKHASH, lookupTable });
    expect(reasonOf(compressed)).toMatch(/lookup table/);

    const legacy = new Transaction({ feePayer: depositor.publicKey, recentBlockhash: BLOCKHASH }).add(instruction);
    expect(reasonOf(new VersionedTransaction(legacy.compileMessage()))).toMatch(/version 0/);

    expect(parseScreenTransaction({ transaction: "AQID" })).toMatchObject({ ok: false, error: { code: "invalid_transaction" } });
  });

  /** The pool's table, as on both clusters: frozen, holding config, tree, vault and the system program. */
  const poolTable = new AddressLookupTableAccount({
    key: address("pool lookup table"),
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [configPda(), treePda(), vaultPda(), SystemProgram.programId],
    },
  });
  const depositInstruction = () =>
    buildTransactInstruction(sampleArgs({ recipient: depositor.publicKey, relayer: depositor.publicKey, extAmount: 1_000_000_000n, fee: 0n }), {
      signer: depositor.publicKey,
      screener: screener.publicKey,
    });
  /** A deposit as a wallet that adds Lighthouse assertions would hand it back. */
  const withLighthouse = (extra: TransactionInstruction[]) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: depositor.publicKey,
        recentBlockhash: BLOCKHASH,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), depositInstruction(), ...extra],
      }).compileToV0Message([poolTable]),
    );
  const assertion = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = []) =>
    new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys, data: Buffer.from([15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) });

  it("accepts the pool's frozen lookup table and a loaded-data limit, and only that table", () => {
    const compressed = buildTransactTransaction({
      instruction: depositInstruction(),
      payer: depositor.publicKey,
      recentBlockhash: BLOCKHASH,
      lookupTable: poolTable,
      loadedAccountsDataSizeLimit: DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    });
    // The table takes four keys out of the message: room for what a wallet adds.
    expect(compressed.serialize().length).toBeLessThan(depositTransaction().serialize().length - 80);
    const result = inspectDepositTransaction(compressed, { screener: screener.publicKey, lookupTable: poolTable });
    expect(result).toMatchObject({ ok: true, value: { loadedAccountsDataSizeLimit: DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, computeUnitLimit: 300_000, lighthouseInstructions: 0 } });
    // Without the table, or with another one, it is refused.
    expect(reasonOf(compressed)).toMatch(/lookup table/);
    const other = new AddressLookupTableAccount({ key: address("someone else's table"), state: poolTable.state });
    expect(inspectDepositTransaction(compressed, { screener: screener.publicKey, lookupTable: other })).toMatchObject({ ok: false });
    // A table that can still change is not one to sign against.
    const open = new AddressLookupTableAccount({ key: poolTable.key, state: { ...poolTable.state, authority: address("table authority") } });
    expect(() => inspectDepositTransaction(compressed, { screener: screener.publicKey, lookupTable: open })).toThrow(expect.objectContaining({ code: "internal" }));
    // One loaded-data limit, not two.
    const twice = [setLoadedAccountsDataSizeLimit(1_000), setLoadedAccountsDataSizeLimit(2_000)];
    expect(reasonOf(depositTransaction({ extra: twice }))).toMatch(/only one/);
    expect(reasonOf(depositTransaction({ extra: [setLoadedAccountsDataSizeLimit(1_000)] }))).toBe("accepted");
  });

  it("accepts Lighthouse assertions a wallet adds, but never on the screener's key", () => {
    const memory = address("lighthouse memory");
    const added = withLighthouse([
      assertion(),
      assertion([{ pubkey: depositor.publicKey, isSigner: false, isWritable: false }]),
      assertion([{ pubkey: memory, isSigner: false, isWritable: true }, { pubkey: depositor.publicKey, isSigner: true, isWritable: true }]),
    ]);
    const result = inspectDepositTransaction(added, { screener: screener.publicKey, lookupTable: poolTable });
    expect(result).toMatchObject({ ok: true, value: { lighthouseInstructions: 3 } });
    const onScreener = withLighthouse([assertion([{ pubkey: screener.publicKey, isSigner: false, isWritable: false }])]);
    expect(inspectDepositTransaction(onScreener, { screener: screener.publicKey, lookupTable: poolTable })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/screener/) } });
    const writableTree = withLighthouse([assertion([{ pubkey: configPda(), isSigner: false, isWritable: true }])]);
    expect(inspectDepositTransaction(writableTree, { screener: screener.publicKey, lookupTable: poolTable })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/flags/) } });
    const third = Keypair.generate().publicKey;
    const signing = withLighthouse([assertion([{ pubkey: third, isSigner: true, isWritable: false }])]);
    expect(inspectDepositTransaction(signing, { screener: screener.publicKey, lookupTable: poolTable })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/two signers/) } });
    const many = withLighthouse(Array.from({ length: MAX_LIGHTHOUSE_INSTRUCTIONS + 1 }, () => assertion()));
    expect(inspectDepositTransaction(many, { screener: screener.publicKey, lookupTable: poolTable })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Lighthouse/) } });
  });

  // Offset of the three header bytes in a serialised two-signer v0 transaction: signature count, two signatures, version prefix.
  const HEADER = 1 + 2 * 64 + 1;
  /** The deposit without compute budget instructions: one read-only account fewer. */
  const bareDeposit = () => depositTransaction({ extra: [] });
  const reparsed = (transaction: VersionedTransaction) => VersionedTransaction.deserialize(transaction.serialize());

  it("refuses a message header that gives the deposit's accounts other flags than a deposit has", () => {
    const bytes = depositTransaction().serialize();
    // Two signers, one of them read-only (the screener), and four read-only accounts that do not sign:
    // the config, the system program and the two program ids.
    expect(Array.from(bytes.subarray(HEADER, HEADER + 3))).toEqual([2, 1, 4]);
    expect(depositTransaction().message.staticAccountKeys).toHaveLength(10);
    const withHeader = (offset: number, value: number) => {
      const changed = Uint8Array.from(bytes);
      changed[HEADER + offset] = value;
      return VersionedTransaction.deserialize(changed);
    };
    // 0: the config and the programs writable. 8: the tree, the vault and both nullifier records read-only.
    for (const readonlyUnsigned of [0, 1, 2, 3, 5, 6, 7, 8]) {
      expect(reasonOf(withHeader(2, readonlyUnsigned)), `${readonlyUnsigned} read-only accounts`).toMatch(/other signer or writable flags than a deposit has/);
    }
    // More read-only accounts than there are accounts that do not sign.
    for (const readonlyUnsigned of [9, 10, 200]) expect(reasonOf(withHeader(2, readonlyUnsigned))).toMatch(/header does not fit its account list/);
    expect(reasonOf(withHeader(2, 4))).toBe("accepted");
    // The other two header bytes were checked before: the screener writable, the depositor read-only.
    for (const readonlySigners of [0, 2]) expect(reasonOf(withHeader(1, readonlySigners))).toMatch(/two signers/);
    // A third or a missing signer does not even deserialise: the signature slots no longer match the header.
    for (const signers of [1, 3]) {
      const changed = Uint8Array.from(bytes);
      changed[HEADER] = signers;
      expect(parseScreenTransaction({ transaction: Buffer.from(changed).toString("base64") })).toMatchObject({ ok: false, error: { code: "invalid_transaction" } });
    }

    // What is canonical follows from the instructions: without a compute budget instruction there are three read-only accounts, not four.
    const bare = bareDeposit().serialize();
    expect(Array.from(bare.subarray(HEADER, HEADER + 3))).toEqual([2, 1, 3]);
    expect(reasonOf(bareDeposit())).toBe("accepted");
    const four = Uint8Array.from(bare);
    four[HEADER + 2] = 4;
    expect(reasonOf(VersionedTransaction.deserialize(four))).toMatch(/other signer or writable flags/);
  });

  it("checks the flags of each account, not only how many of each kind the header counts", () => {
    // The header of a deposit, the keys of a deposit, but the config in a writable position and the tree in a read-only one.
    const swapped = reparsed(depositTransaction());
    const keys = swapped.message.staticAccountKeys;
    const config = keys.findIndex((key) => key.equals(configPda()));
    const tree = keys.findIndex((key) => key.equals(treePda()));
    expect(swapped.message.isAccountWritable(tree)).toBe(true);
    expect(swapped.message.isAccountWritable(config)).toBe(false);
    [keys[config], keys[tree]] = [keys[tree]!, keys[config]!];
    const transact = swapped.message.compiledInstructions.find((instruction) => instruction.accountKeyIndexes.length === 10)!;
    transact.accountKeyIndexes = transact.accountKeyIndexes.map((index) => (index === config ? tree : index === tree ? config : index));
    const result = reparsed(swapped);
    expect(Array.from(result.serialize().subarray(HEADER, HEADER + 3))).toEqual([2, 1, 4]);
    expect(result.message.isAccountWritable(result.message.staticAccountKeys.findIndex((key) => key.equals(treePda())))).toBe(false);
    expect(reasonOf(result)).toMatch(/other signer or writable flags than a deposit has/);
  });

  it("refuses an account list with a key no instruction uses, or with a key listed twice", () => {
    const stray = address("an account nobody uses");
    // Appended as a read-only account, and as one more writable account (the header then also shifts the config).
    const readOnly = depositTransaction();
    readOnly.message.staticAccountKeys.push(stray);
    readOnly.message.header.numReadonlyUnsignedAccounts += 1;
    expect(reasonOf(reparsed(readOnly))).toMatch(/an account that no instruction uses/);
    const writable = depositTransaction();
    writable.message.staticAccountKeys.push(stray);
    expect(reasonOf(reparsed(writable))).toMatch(/an account that no instruction uses/);
    // In the middle of the list, with every instruction index moved up accordingly.
    const inserted = depositTransaction();
    const at = inserted.message.staticAccountKeys.findIndex((key) => key.equals(treePda()));
    inserted.message.staticAccountKeys.splice(at, 0, stray);
    for (const instruction of inserted.message.compiledInstructions) {
      instruction.programIdIndex += instruction.programIdIndex >= at ? 1 : 0;
      instruction.accountKeyIndexes = instruction.accountKeyIndexes.map((index) => (index >= at ? index + 1 : index));
    }
    expect(reasonOf(reparsed(inserted))).toMatch(/an account that no instruction uses/);

    // The same key twice: once where the instruction looks for it, once more at the end.
    const twice = depositTransaction();
    twice.message.staticAccountKeys.push(treePda());
    twice.message.header.numReadonlyUnsignedAccounts += 1;
    expect(reasonOf(reparsed(twice))).toMatch(/listed twice/);
    // And both copies in use: the depositor again as a writable account that does not sign, named as the recipient.
    const split = depositTransaction();
    const copy = split.message.staticAccountKeys.findIndex((key) => key.equals(treePda()));
    split.message.staticAccountKeys.splice(copy, 0, depositor.publicKey);
    for (const instruction of split.message.compiledInstructions) {
      instruction.programIdIndex += instruction.programIdIndex >= copy ? 1 : 0;
      instruction.accountKeyIndexes = instruction.accountKeyIndexes.map((index, slot) => (slot === 5 && instruction.accountKeyIndexes.length === 10 ? copy : index >= copy ? index + 1 : index));
    }
    expect(reasonOf(reparsed(split))).toMatch(/listed twice/);

    expect(reasonOf(reparsed(depositTransaction()))).toBe("accepted");
  });

  it("refuses bytes after the end of the transaction, and a transaction that is not in canonical encoding", () => {
    const parse = (bytes: Uint8Array) => parseScreenTransaction({ transaction: Buffer.from(bytes).toString("base64") });
    const reason = (bytes: Uint8Array) => {
      const result = parse(bytes);
      if (result.ok) return "accepted";
      expect(errorOf(result)).toEqual({ code: "invalid_transaction", status: 400 });
      return result.error.message;
    };
    const transaction = depositTransaction();
    const bytes = transaction.serialize();
    expect(reason(bytes)).toBe("accepted");
    // VersionedTransaction.deserialize reads one transaction and ignores the rest.
    for (const tail of [[0], [1, 2, 3], Array.from(bytes)]) {
      const padded = Uint8Array.from([...bytes, ...tail]);
      expect(VersionedTransaction.deserialize(padded).message.serialize()).toEqual(transaction.message.serialize());
      expect(reason(padded)).toMatch(/bytes follow the transaction/);
    }
    // The signature count written in two bytes where one will do: the same transaction to a lenient reader.
    const aliased = Uint8Array.from([0x82, 0x00, ...bytes.subarray(1)]);
    expect(VersionedTransaction.deserialize(aliased).message.serialize()).toEqual(transaction.message.serialize());
    expect(reason(aliased)).toMatch(/not in canonical encoding/);
    // One byte short: the deserialiser reads the missing last byte (the number of lookup tables) as zero.
    expect(VersionedTransaction.deserialize(bytes.subarray(0, bytes.length - 1)).message.serialize()).toEqual(transaction.message.serialize());
    expect(reason(bytes.subarray(0, bytes.length - 1))).toMatch(/not in canonical encoding/);
    expect(reason(bytes.subarray(0, 200))).toMatch(/could not be deserialised/);

    // What clients send still parses: with the depositor's signature, with the screener's, and a legacy
    // transaction too (refused by the inspection, with a reason, not here).
    const signed = depositTransaction();
    signed.sign([depositor, screener]);
    const viaRequest = parseScreenTransaction(toScreenRequest(signed));
    expect(viaRequest.ok && viaRequest.value.signatures).toEqual(signed.signatures);
    const legacy = new Transaction({ feePayer: depositor.publicKey, recentBlockhash: BLOCKHASH }).add(
      buildTransactInstruction(sampleArgs({ recipient: depositor.publicKey, relayer: depositor.publicKey, extAmount: 5n, fee: 0n }), { signer: depositor.publicKey, screener: screener.publicKey }),
    );
    const parsedLegacy = parse(legacy.serialize({ requireAllSignatures: false, verifySignatures: false }));
    expect(parsedLegacy.ok).toBe(true);
    if (parsedLegacy.ok) expect(reasonOf(parsedLegacy.value)).toMatch(/version 0/);
  });

  it("applies the screener's signature at the screener's index, and the wallet's signature keeps it", () => {
    const transaction = depositTransaction();
    const serviceCopy = VersionedTransaction.deserialize(transaction.serialize());
    serviceCopy.sign([screener]);
    const response = { signature: Buffer.from(serviceCopy.signatures[1]!).toString("base64"), screener: screener.publicKey.toBase58() };

    expect(applyScreenerSignature(transaction, response)).toBe(transaction);
    expect(transaction.signatures[1]).toEqual(serviceCopy.signatures[1]);
    expect(transaction.signatures[0]!.every((byte) => byte === 0)).toBe(true);
    transaction.sign([depositor]);
    expect(transaction.signatures[1]).toEqual(serviceCopy.signatures[1]);
    expect(transaction.signatures[0]!.some((byte) => byte !== 0)).toBe(true);
  });

  it("refuses a signature that is not the screener's signature of this transaction", () => {
    const transaction = depositTransaction();
    const other = depositTransaction({ price: 7 });
    other.sign([screener]);
    const wrongMessage = { signature: Buffer.from(other.signatures[1]!).toString("base64"), screener: screener.publicKey.toBase58() };
    expect(() => applyScreenerSignature(transaction, wrongMessage)).toThrow(expect.objectContaining({ code: "bad_response" }));

    const stranger = Keypair.generate();
    const copy = VersionedTransaction.deserialize(transaction.serialize());
    copy.sign([screener]);
    const good = Buffer.from(copy.signatures[1]!).toString("base64");
    expect(() => applyScreenerSignature(transaction, { signature: good, screener: stranger.publicKey.toBase58() })).toThrow(/not a signer/);
    expect(() => applyScreenerSignature(transaction, { signature: good, screener: depositor.publicKey.toBase58() })).toThrow(/does not match/);
    expect(() => applyScreenerSignature(transaction, { signature: "AAAA", screener: screener.publicKey.toBase58() })).toThrow(/64 bytes/);
    expect(() => applyScreenerSignature(transaction, { signature: "***", screener: "???" })).toThrow(/malformed/);
    expect(transaction.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
  });
});
