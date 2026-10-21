// Version 1 transactions (SIMD-0385): the layout byte for byte, the strict reader, signing,
// and a v1 deposit through the screening checks. web3.js 1.99 reads v1 (but cannot write
// it), which makes it an independent check of every transaction written here.

import { ed25519 } from "@noble/curves/ed25519";
import { base58, base64 } from "@scure/base";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, LIGHTHOUSE_PROGRAM_ID } from "../src/constants.js";
import { type TransactArgs, buildTransactInstruction } from "../src/index.js";
import { MessageV1, TransactionV1, buildTransactionV1, deserializeTransaction } from "../src/transactionV1.js";
import { applyScreenerSignature, inspectDepositTransaction, parseScreenTransaction, toScreenRequest, validateScreenRequest } from "../src/wire.js";

const BLOCKHASH = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const payer = Keypair.generate();
const other = Keypair.generate();
const to = Keypair.generate().publicKey;

const field = (seed: number) => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7) & 0xff);
  bytes[0] = 0x01;
  return bytes;
};

function transfer(): TransactionInstruction {
  const instruction = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 5 });
  // A second, read-only signer, as a deposit has.
  instruction.keys.push({ pubkey: other.publicKey, isSigner: true, isWritable: false });
  return instruction;
}

describe("the v1 layout", () => {
  it("writes the fields of SIMD-0385 in order, and web3.js reads back the same transaction", () => {
    const transaction = buildTransactionV1({ instructions: [transfer()], payer: payer.publicKey, recentBlockhash: BLOCKHASH, computeUnitLimit: 300_000, loadedAccountsDataSizeLimit: 65_536, priorityFeeLamports: 7 });
    transaction.sign([payer, other]);
    const bytes = transaction.serialize();

    expect(bytes[0]).toBe(129);
    expect(Array.from(bytes.subarray(1, 4))).toEqual([2, 1, 1]); // two signers, one read-only; the system program read-only
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true)).toBe(0b1111); // fee (two bits), unit limit, data limit
    expect(base58.encode(bytes.subarray(8, 40))).toBe(BLOCKHASH);
    expect(Array.from(bytes.subarray(40, 42))).toEqual([1, 4]); // one instruction, four addresses
    const addresses = [0, 1, 2, 3].map((i) => new PublicKey(bytes.subarray(42 + 32 * i, 74 + 32 * i)));
    expect(addresses.map((key) => key.toBase58())).toEqual([payer.publicKey, other.publicKey, to, SystemProgram.programId].map((key) => key.toBase58()));
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getBigUint64(170, true)).toBe(7n);
    expect(view.getUint32(178, true)).toBe(300_000);
    expect(view.getUint32(182, true)).toBe(65_536);
    expect(Array.from(bytes.subarray(186, 190))).toEqual([3, 3, 12, 0]); // program 3, three accounts, twelve bytes of data
    expect(Array.from(bytes.subarray(190, 193))).toEqual([0, 2, 1]);
    expect(bytes.length).toBe(193 + 12 + 2 * 64);
    // The signatures come last and cover everything before them.
    const message = bytes.subarray(0, 205);
    expect(ed25519.verify(bytes.subarray(205, 269), message, payer.publicKey.toBytes())).toBe(true);
    expect(ed25519.verify(bytes.subarray(269), message, other.publicKey.toBytes())).toBe(true);

    const theirs = VersionedTransaction.deserialize(bytes);
    expect(theirs.message.version).toBe(1);
    const ours = TransactionV1.deserialize(bytes);
    for (const parsed of [theirs, ours]) {
      expect(parsed.message.header).toEqual(transaction.message.header);
      expect(parsed.message.recentBlockhash).toBe(BLOCKHASH);
      expect(parsed.message.staticAccountKeys.map((key) => key.toBase58())).toEqual(addresses.map((key) => key.toBase58()));
      expect(parsed.message.compiledInstructions).toEqual(transaction.message.compiledInstructions);
      expect(parsed.signatures).toEqual(transaction.signatures);
    }
    expect((theirs.message as unknown as MessageV1).transactionConfig).toEqual(ours.message.transactionConfig);
    expect(ours.message.transactionConfig).toEqual({ computeUnitLimit: 300_000, loadedAccountsDataSizeLimit: 65_536, priorityFee: 7, heapSize: null });
    expect(ours.serialize()).toEqual(bytes);
    expect(deserializeTransaction(bytes)).toBeInstanceOf(TransactionV1);
  });

  it("gives each account the flags of its place, as earlier versions do", () => {
    const { message } = buildTransactionV1({ instructions: [transfer()], payer: payer.publicKey, recentBlockhash: BLOCKHASH });
    expect([0, 1, 2, 3].map((i) => message.isAccountSigner(i))).toEqual([true, true, false, false]);
    expect([0, 1, 2, 3].map((i) => message.isAccountWritable(i))).toEqual([true, false, true, false]);
    expect(message.addressTableLookups).toEqual([]);
    expect(message.getAccountKeys().keySegments().flat().length).toBe(4);
    expect(message.transactionConfig).toEqual({ computeUnitLimit: 300_000, loadedAccountsDataSizeLimit: null, priorityFee: null, heapSize: null });
  });

  it("reads strictly: no trailing bytes, no unknown or half config bits, no index outside the account list", () => {
    const bytes = buildTransactionV1({ instructions: [transfer()], payer: payer.publicKey, recentBlockhash: BLOCKHASH }).serialize();
    const refused = (mutate: (copy: Uint8Array) => Uint8Array) => () => TransactionV1.deserialize(mutate(Uint8Array.from(bytes)));
    expect(refused((copy) => Uint8Array.from([...copy, 0]))).toThrow(/bytes follow the signatures/);
    expect(refused((copy) => copy.subarray(0, copy.length - 1))).toThrow(/cut short/);
    expect(refused((copy) => ((copy[0] = 128), copy))).toThrow(/not a version 1/);
    expect(refused((copy) => ((copy[4] = 0b100000 | 0b100), copy))).toThrow(/does not define/);
    expect(refused((copy) => ((copy[4] = 0b101), copy))).toThrow(/both of its config bits/);
    expect(refused((copy) => ((copy[3] = 3), copy))).toThrow(/does not fit/);
    expect(refused((copy) => ((copy[1] = 0), copy))).toThrow(/signer count/);
    expect(refused((copy) => ((copy[2] = 2), copy))).toThrow(/read-only/);
    // The program index (first byte of the instruction header, after the one config value).
    const header = 42 + 4 * 32 + 4;
    expect(refused((copy) => ((copy[header] = 4), copy))).toThrow(/not in the account list/);
    expect(refused((copy) => ((copy[header + 4 + 1] = 9), copy))).toThrow(/not in the account list/);
    expect(() => TransactionV1.deserialize(new Uint8Array(4097).fill(129))).toThrow(/longer than 4096/);
  });

  it("refuses a transaction over 4,096 bytes, and a signer that is not required", () => {
    const big = new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(4_000) });
    expect(() => buildTransactionV1({ instructions: [big], payer: payer.publicKey, recentBlockhash: BLOCKHASH })).toThrow(expect.objectContaining({ code: "TRANSACTION_TOO_LARGE" }));
    const transaction = buildTransactionV1({ instructions: [transfer()], payer: payer.publicKey, recentBlockhash: BLOCKHASH });
    expect(() => transaction.sign([Keypair.generate()])).toThrow(/not a required signer/);
    expect(() => buildTransactionV1({ instructions: [transfer()], payer: payer.publicKey, recentBlockhash: "short" })).toThrow(/blockhash/);
  });
});

describe("a v1 deposit through the screening checks", () => {
  const depositor = Keypair.generate();
  const screener = Keypair.generate();
  const args: TransactArgs = {
    proof: { a: Uint8Array.from([...field(1), ...field(2)]), b: Uint8Array.from([...field(3), ...field(4), ...field(5), ...field(6)]), c: Uint8Array.from([...field(7), ...field(8)]) },
    root: field(9),
    inputNullifiers: [field(10), field(11)],
    outputCommitments: [field(12), field(13)],
    extData: { recipient: depositor.publicKey, relayer: depositor.publicKey, extAmount: 1_000_000_000n, fee: 0n, encryptedOutput0: new Uint8Array(87).fill(3), encryptedOutput1: new Uint8Array(87).fill(4) },
  };
  const instruction = buildTransactInstruction(args, { signer: depositor.publicKey, screener: screener.publicKey });
  const deposit = (extra: TransactionInstruction[] = []) =>
    buildTransactionV1({ instructions: [instruction, ...extra], payer: depositor.publicKey, recentBlockhash: BLOCKHASH, loadedAccountsDataSizeLimit: DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT });

  it("is accepted as exactly one deposit, with the compute budget read from the message's config", () => {
    const transaction = deposit();
    const request = toScreenRequest(transaction);
    expect(validateScreenRequest(request).ok).toBe(true);
    const parsed = parseScreenTransaction(request);
    expect(parsed.ok && parsed.value).toBeInstanceOf(TransactionV1);
    if (!parsed.ok) return;
    const result = inspectDepositTransaction(parsed.value, { screener: screener.publicKey });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(1);
    expect(result.value.computeUnitLimit).toBe(300_000);
    expect(result.value.loadedAccountsDataSizeLimit).toBe(DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT);
    expect(result.value.computeUnitPrice).toBeNull();
    expect(result.value.priorityFeeLamports).toBeNull();
    expect(result.value.message).toEqual(transaction.message.serialize());
    expect(transaction.serialize().length).toBeLessThan(1_400);
  });

  it("takes the screener's signature after the wallet's, over the v1 message, with Lighthouse added", () => {
    const lighthouse = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [{ pubkey: depositor.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) });
    const signed = deposit([lighthouse]);
    signed.sign([depositor]);
    expect(inspectDepositTransaction(signed, { screener: screener.publicKey }).ok).toBe(true);
    const signature = ed25519.sign(signed.message.serialize(), screener.secretKey.subarray(0, 32));
    applyScreenerSignature(signed, { signature: base64.encode(signature), screener: screener.publicKey.toBase58() });
    const bytes = signed.serialize();
    const parsed = TransactionV1.deserialize(bytes);
    expect(ed25519.verify(parsed.signatures[0]!, parsed.message.serialize(), depositor.publicKey.toBytes())).toBe(true);
    expect(ed25519.verify(parsed.signatures[1]!, parsed.message.serialize(), screener.publicKey.toBytes())).toBe(true);
    // A signature over anything else is caught by the client.
    expect(() => applyScreenerSignature(deposit(), { signature: base64.encode(signature), screener: screener.publicKey.toBase58() })).toThrow(/does not match/);
  });

  it("refuses what it refuses in v0: another program's instruction, and a v1 message web3.js parsed", () => {
    const drain = SystemProgram.transfer({ fromPubkey: screener.publicKey, toPubkey: depositor.publicKey, lamports: 1 });
    const result = inspectDepositTransaction(deposit([drain]), { screener: screener.publicKey });
    expect(result.ok).toBe(false);
    const web3Parsed = VersionedTransaction.deserialize(deposit().serialize());
    const refused = inspectDepositTransaction(web3Parsed, { screener: screener.publicKey });
    expect(!refused.ok && refused.error.message).toMatch(/deserializeTransaction/);
    // A ComputeBudget instruction is a no-op in v1; the config is what is reported.
    const noop = inspectDepositTransaction(deposit([ComputeBudgetProgram.setComputeUnitLimit({ units: 5 })]), { screener: screener.publicKey });
    expect(noop.ok && noop.value.computeUnitLimit).toBe(300_000);
  });

  it("allows 4,096 bytes on the wire for v1 only", () => {
    const v1 = new Uint8Array(3_000);
    v1[0] = 129;
    expect(validateScreenRequest({ transaction: base64.encode(v1) }).ok).toBe(true);
    expect(validateScreenRequest({ transaction: base64.encode(new Uint8Array(3_000)) }).ok).toBe(false);
    expect(validateScreenRequest({ transaction: base64.encode(new Uint8Array(4_097).fill(129)) }).ok).toBe(false);
  });
});
