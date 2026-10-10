import { sha256 } from "@noble/hashes/sha2";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { bytesToBigIntLE, bytesToHex, concatBytes, hexToBytes, randomBytes, utf8 } from "../src/bytes.js";
import { MERKLE_TREE_DISCRIMINATOR, NULLIFIER_RECORD_DISCRIMINATOR, POOL_CONFIG_DISCRIMINATOR } from "../src/constants.js";
import {
  DEFAULT_COMPUTE_UNIT_LIMIT,
  FIELD_MODULUS,
  LochError,
  NEW_COMMITMENT_DISCRIMINATOR,
  NEW_NULLIFIERS_DISCRIMINATOR,
  PROGRAM_ERROR_CODES,
  PROGRAM_ID,
  TRANSACT_DISCRIMINATOR,
  type TransactArgs,
  buildTransactInstruction,
  buildTransactTransaction,
  configPda,
  decodeProof,
  proofEncodingProblem,
  decodeTransactArgs,
  decodeTransactInstruction,
  encodeProof,
  encodeTransactArgs,
  fieldToBytes,
  nullifierPda,
  transactAccountsProblem,
  treePda,
  vaultPda,
} from "../src/index.js";
import { IDL_PATH, VECTOR_PATH, address, fileExists, readJson } from "./helpers/fixtures.js";

const vector = readJson(VECTOR_PATH);
const BLOCKHASH = "11111111111111111111111111111111";

function sampleArgs(overrides: Partial<TransactArgs["extData"]> = {}): TransactArgs {
  return {
    proof: { a: hexToBytes(vector.program.proofA), b: hexToBytes(vector.program.proofB), c: hexToBytes(vector.program.proofC) },
    root: hexToBytes(vector.program.root),
    inputNullifiers: [hexToBytes(vector.program.inputNullifiers[0]), hexToBytes(vector.program.inputNullifiers[1])],
    outputCommitments: [hexToBytes(vector.program.outputCommitments[0]), hexToBytes(vector.program.outputCommitments[1])],
    extData: {
      recipient: address("recipient"),
      relayer: address("relayer"),
      extAmount: -1_500_000_000n,
      fee: 5_000n,
      encryptedOutput0: randomBytes(87),
      encryptedOutput1: randomBytes(87),
      ...overrides,
    },
  };
}

const discriminator = (preimage: string) => sha256(utf8(preimage)).subarray(0, 8);

describe("discriminators", () => {
  it("are the Anchor hashes", () => {
    expect(TRANSACT_DISCRIMINATOR).toEqual(discriminator("global:transact"));
    expect(NEW_COMMITMENT_DISCRIMINATOR).toEqual(discriminator("event:NewCommitment"));
    expect(NEW_NULLIFIERS_DISCRIMINATOR).toEqual(discriminator("event:NewNullifiers"));
    expect(POOL_CONFIG_DISCRIMINATOR).toEqual(discriminator("account:PoolConfig"));
    expect(MERKLE_TREE_DISCRIMINATOR).toEqual(discriminator("account:MerkleTree"));
    expect(NULLIFIER_RECORD_DISCRIMINATOR).toEqual(discriminator("account:NullifierRecord"));
  });

  // The IDL is a build product and may be absent or mid-regeneration.
  const idl = (() => {
    try {
      return fileExists(IDL_PATH) ? readJson(IDL_PATH) : null;
    } catch {
      return null;
    }
  })();

  it.skipIf(!idl)("match target/idl/loch_pool.json", () => {
    const find = (list: any[], name: string) => list.find((item) => item.name === name);
    expect([...TRANSACT_DISCRIMINATOR]).toEqual(find(idl.instructions, "transact").discriminator);
    expect([...NEW_COMMITMENT_DISCRIMINATOR]).toEqual(find(idl.events, "NewCommitment").discriminator);
    expect([...NEW_NULLIFIERS_DISCRIMINATOR]).toEqual(find(idl.events, "NewNullifiers").discriminator);
    expect([...POOL_CONFIG_DISCRIMINATOR]).toEqual(find(idl.accounts, "PoolConfig").discriminator);
    expect([...MERKLE_TREE_DISCRIMINATOR]).toEqual(find(idl.accounts, "MerkleTree").discriminator);
    expect(idl.address).toBe(PROGRAM_ID.toBase58());
  });

  it.skipIf(!idl)("builds the accounts in the IDL's order with the IDL's flags", () => {
    const accounts: any[] = idl.instructions.find((item: any) => item.name === "transact").accounts;
    expect(accounts.map((account) => account.name)).toEqual([
      "config", "tree", "vault", "nullifier0", "nullifier1", "recipient", "relayer", "screener", "signer", "system_program",
    ]);
    const args = sampleArgs({ extAmount: 1n });
    const instruction = buildTransactInstruction(args, { signer: address("depositor"), screener: address("screener") });
    expect(instruction.keys).toHaveLength(accounts.length);
    accounts.forEach((account, i) => {
      expect(instruction.keys[i]!.isWritable, account.name).toBe(account.writable === true);
      expect(instruction.keys[i]!.isSigner, account.name).toBe(account.signer === true);
    });
  });

  it.skipIf(!idl)("knows every error code in the IDL that it claims to know", () => {
    for (const [name, code] of Object.entries(PROGRAM_ERROR_CODES)) {
      const entry = idl.errors.find((item: any) => item.name === name);
      expect(entry?.code, name).toBe(code);
    }
  });
});

describe("transact instruction data", () => {
  it("decode(encode(x)) equals x", () => {
    for (const args of [
      sampleArgs(),
      sampleArgs({ extAmount: 0n, fee: 0n, encryptedOutput0: new Uint8Array(0), encryptedOutput1: new Uint8Array(0) }),
      sampleArgs({ extAmount: (1n << 63n) - 1n, fee: (1n << 64n) - 1n, encryptedOutput0: randomBytes(256), encryptedOutput1: randomBytes(1) }),
      sampleArgs({ extAmount: -(1n << 63n) }),
    ]) {
      const decoded = decodeTransactArgs(encodeTransactArgs(args));
      expect(decoded).toEqual(args);
      expect(decoded.extData.recipient.equals(args.extData.recipient)).toBe(true);
      expect(decoded.extData.extAmount).toBe(args.extData.extAmount);
      expect(encodeTransactArgs(decoded)).toEqual(encodeTransactArgs(args));
    }
  });

  it("is discriminator, proof, root, nullifiers, commitments, Borsh ext data", () => {
    const args = sampleArgs();
    const data = encodeTransactArgs(args);
    expect(data).toHaveLength(8 + 256 + 32 + 64 + 64 + 32 + 32 + 8 + 8 + 4 + 87 + 4 + 87);
    expect(data.subarray(0, 8)).toEqual(TRANSACT_DISCRIMINATOR);
    expect(data.subarray(8, 72)).toEqual(args.proof.a);
    expect(data.subarray(72, 200)).toEqual(args.proof.b);
    expect(data.subarray(200, 264)).toEqual(args.proof.c);
    expect(data.subarray(264, 296)).toEqual(args.root);
    expect(data.subarray(296, 328)).toEqual(args.inputNullifiers[0]);
    expect(data.subarray(360, 392)).toEqual(args.outputCommitments[0]);
    expect(data.subarray(424, 456)).toEqual(args.extData.recipient.toBytes());
    expect(bytesToBigIntLE(data.subarray(488, 496))).toBe(BigInt.asUintN(64, args.extData.extAmount));
    expect(bytesToBigIntLE(data.subarray(496, 504))).toBe(5_000n);
    expect(bytesToBigIntLE(data.subarray(504, 508))).toBe(87n);
  });

  it("returns plain Uint8Arrays, also when given a Buffer", () => {
    const decoded = decodeTransactArgs(Buffer.from(encodeTransactArgs(sampleArgs())));
    for (const bytes of [decoded.proof.a, decoded.root, decoded.inputNullifiers[1], decoded.extData.encryptedOutput0]) {
      expect(Buffer.isBuffer(bytes)).toBe(false);
      expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    }
  });

  it("rejects a wrong discriminator", () => {
    const data = encodeTransactArgs(sampleArgs());
    data[0]! ^= 1;
    expect(() => decodeTransactArgs(data)).toThrow(expect.objectContaining({ code: "DECODE_FAILED" }));
    expect(() => decodeTransactArgs(new Uint8Array(4))).toThrow(LochError);
  });

  it("rejects data cut off at any point", () => {
    const data = encodeTransactArgs(sampleArgs());
    for (const length of [8, 9, 263, 264, 423, 503, 507, 508, data.length - 88, data.length - 1]) {
      expect(() => decodeTransactArgs(data.subarray(0, length)), `length ${length}`).toThrow(/malformed/);
    }
  });

  it("rejects trailing bytes unless told the data already executed", () => {
    const padded = concatBytes(encodeTransactArgs(sampleArgs()), Uint8Array.of(0));
    expect(() => decodeTransactArgs(padded)).toThrow(/malformed/);
    expect(decodeTransactArgs(padded, { allowTrailingBytes: true }).extData.fee).toBe(5_000n);
  });

  it("rejects an encrypted output longer than the program allows", () => {
    const data = encodeTransactArgs(sampleArgs({ encryptedOutput0: randomBytes(256) }));
    data[504] = 1; // length 256 -> 257
    expect(() => decodeTransactArgs(concatBytes(data, Uint8Array.of(0)))).toThrow(/malformed/);
    expect(() => encodeTransactArgs(sampleArgs({ encryptedOutput1: randomBytes(257) }))).toThrow(/256/);
  });

  it("refuses to encode malformed arguments", () => {
    expect(() => encodeTransactArgs({ ...sampleArgs(), root: new Uint8Array(31) })).toThrow(/root/);
    expect(() => encodeTransactArgs({ ...sampleArgs(), proof: { ...sampleArgs().proof, b: new Uint8Array(64) } })).toThrow(/proof/);
    expect(() => encodeTransactArgs(sampleArgs({ extAmount: 1n << 63n }))).toThrow(/extAmount/);
    expect(() => encodeTransactArgs(sampleArgs({ fee: -1n }))).toThrow(/fee/);
  });
});

describe("proof encoding", () => {
  it("negates A with the base field modulus and swaps the limbs of B", () => {
    const proof = vector.snarkjs.proof;
    const q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
    const encoded = encodeProof(proof);
    const be = (v: bigint) => bytesToHex(fieldToBytesUnchecked(v));
    expect(bytesToHex(encoded.a)).toBe(be(BigInt(proof.pi_a[0])) + be(q - BigInt(proof.pi_a[1])));
    expect(bytesToHex(encoded.b)).toBe(
      be(BigInt(proof.pi_b[0][1])) + be(BigInt(proof.pi_b[0][0])) + be(BigInt(proof.pi_b[1][1])) + be(BigInt(proof.pi_b[1][0])),
    );
    expect(bytesToHex(encoded.c)).toBe(be(BigInt(proof.pi_c[0])) + be(BigInt(proof.pi_c[1])));
    expect(decodeProof(encoded)).toEqual(proof);
  });

  it("rejects other proof systems and out-of-range coordinates", () => {
    expect(() => encodeProof({ ...vector.snarkjs.proof, protocol: "plonk" })).toThrow(/groth16/);
    expect(() => encodeProof({ ...vector.snarkjs.proof, curve: "bls12381" })).toThrow(/bn128/);
    const q = "21888242871839275222246405745257275088696311157297823662689037894645226208583";
    expect(() => encodeProof({ ...vector.snarkjs.proof, pi_a: [q, "1", "1"] })).toThrow(/base field/);
    expect(() => encodeProof({ ...vector.snarkjs.proof, pi_c: ["0x10", "1", "1"] })).toThrow(/decimal/);
  });

  it("decodes strictly: a part of the wrong length, an all-zero part or a coordinate of q or more is refused", () => {
    const q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
    const good = encodeProof(vector.snarkjs.proof);
    expect(proofEncodingProblem(good)).toBeNull();
    const withWord = (part: "a" | "b" | "c", word: number, value: bigint) => {
      const bytes = Uint8Array.from(good[part]);
      bytes.set(fieldToBytesUnchecked(value), word * 32);
      return { ...good, [part]: bytes };
    };
    const word = (part: "a" | "b" | "c", index: number) => BigInt(`0x${bytesToHex(good[part].subarray(index * 32, index * 32 + 32))}`);
    for (const [part, index] of [["a", 0], ["a", 1], ["b", 0], ["b", 1], ["b", 2], ["b", 3], ["c", 0], ["c", 1]] as const) {
      const aliased = withWord(part, index, word(part, index) + q);
      expect(proofEncodingProblem(aliased), `${part}[${index}] + q`).toMatch(/not below the base field modulus/);
      expect(() => decodeProof(aliased)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    }
    expect(proofEncodingProblem(withWord("c", 1, q))).toMatch(/proof\.c/);
    expect(proofEncodingProblem(withWord("c", 1, q - 1n))).toBeNull();
    expect(() => decodeProof({ ...good, a: new Uint8Array(64) })).toThrow(/proof\.a is all zero/);
    expect(() => decodeProof({ ...good, b: new Uint8Array(128) })).toThrow(/all zero/);
    expect(() => decodeProof({ ...good, c: good.c.subarray(1) })).toThrow(/64 bytes/);
    expect(proofEncodingProblem({ a: good.a } as never)).toMatch(/proof\.b must be 128 bytes/);
  });
});

/** 32-byte big-endian without the scalar-field range check (coordinates live in the base field). */
function fieldToBytesUnchecked(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

describe("transact instruction", () => {
  const relayer = address("relayer");

  it("derives the PDAs from their seeds", () => {
    const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
    expect(configPda()).toEqual(pda(utf8("config")));
    expect(treePda()).toEqual(pda(utf8("tree")));
    expect(vaultPda()).toEqual(pda(utf8("vault")));
    const nullifier = hexToBytes(vector.program.inputNullifiers[0]);
    expect(nullifierPda(nullifier)).toEqual(pda(utf8("nullifier"), nullifier));
    expect(nullifierPda(BigInt(vector.snarkjs.publicSignals[3]))).toEqual(nullifierPda(nullifier));
    const other = address("another program");
    expect(configPda(other).equals(configPda())).toBe(false);
    expect(configPda(other)).toEqual(PublicKey.findProgramAddressSync([utf8("config")], other)[0]);
    expect(() => nullifierPda(FIELD_MODULUS)).toThrow(/field element/);
  });

  it("lists the accounts in program order, with the program id standing in for a missing screener", () => {
    const args = sampleArgs({ relayer });
    const instruction = buildTransactInstruction(args, { signer: relayer });
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true);
    expect(instruction.keys.map((key) => key.pubkey.toBase58())).toEqual(
      [
        configPda(),
        treePda(),
        vaultPda(),
        nullifierPda(args.inputNullifiers[0]),
        nullifierPda(args.inputNullifiers[1]),
        args.extData.recipient,
        relayer,
        PROGRAM_ID,
        relayer,
        SystemProgram.programId,
      ].map((key) => key.toBase58()),
    );
    expect(instruction.keys.map((key) => key.isWritable)).toEqual([false, true, true, true, true, true, true, false, true, false]);
    expect(instruction.keys.map((key) => key.isSigner)).toEqual([false, false, false, false, false, false, false, false, true, false]);
    expect(new Uint8Array(instruction.data)).toEqual(encodeTransactArgs(args));
    // web3.js types the data as Buffer, and callers get a real one.
    expect(Buffer.isBuffer(instruction.data)).toBe(true);
  });

  it("makes the screener a read-only signer on a deposit", () => {
    const depositor = address("depositor");
    const screener = address("screener");
    const args = sampleArgs({ recipient: depositor, relayer: depositor, extAmount: 1_000_000n, fee: 0n });
    const instruction = buildTransactInstruction(args, { signer: depositor, screener });
    expect(instruction.keys[7]).toEqual({ pubkey: screener, isSigner: true, isWritable: false });
    expect(instruction.keys[8]).toEqual({ pubkey: depositor, isSigner: true, isWritable: true });
  });

  it("refuses to build an instruction around a nullifier that is not below r", () => {
    // N and N + r are the same field element but different PDA seeds: the program answers 6011.
    const args = sampleArgs();
    const aliased = { ...args, inputNullifiers: [fieldToBytesUnchecked(FIELD_MODULUS + 5n), args.inputNullifiers[1]] as [Uint8Array, Uint8Array] };
    expect(() => buildTransactInstruction(aliased, { signer: relayer })).toThrow(/field element/);
  });

  it("uses another program id everywhere when told to", () => {
    const programId = address("another program");
    const args = sampleArgs();
    const instruction = buildTransactInstruction(args, { signer: relayer, programId });
    expect(instruction.programId.equals(programId)).toBe(true);
    expect(instruction.keys[0]!.pubkey.equals(configPda(programId))).toBe(true);
    expect(instruction.keys[3]!.pubkey.equals(nullifierPda(args.inputNullifiers[0], programId))).toBe(true);
    expect(instruction.keys[7]!.pubkey.equals(programId)).toBe(true);
    // An instruction for another program is well formed only when that program is the one expected.
    const decoded = decodeTransactInstruction(instruction);
    expect(transactAccountsProblem(decoded)).toMatch(/not addressed to the expected loch_pool program/);
    expect(transactAccountsProblem(decoded, programId)).toBeNull();
    expect(transactAccountsProblem(decodeTransactInstruction(buildTransactInstruction(args, { signer: relayer })), programId)).toMatch(/not addressed/);
  });

  it("decodes an instruction back to arguments and named accounts", () => {
    const args = sampleArgs({ relayer });
    const decoded = decodeTransactInstruction(buildTransactInstruction(args, { signer: relayer }));
    expect(decoded.args).toEqual(args);
    expect(decoded.programId.equals(PROGRAM_ID)).toBe(true);
    expect(decoded.accounts.screener).toBeNull();
    expect(decoded.accounts.signer.equals(relayer)).toBe(true);
    expect(decoded.accounts.recipient.equals(args.extData.recipient)).toBe(true);
    expect(decoded.accounts.tree.equals(treePda())).toBe(true);
    expect(decoded.accounts.systemProgram.equals(SystemProgram.programId)).toBe(true);
    expect(transactAccountsProblem(decoded)).toBeNull();
  });

  it("decodes a compiled instruction with the message's account keys", () => {
    const depositor = address("depositor");
    const screener = address("screener");
    const args = sampleArgs({ recipient: depositor, relayer: depositor, extAmount: 1_000_000n, fee: 0n });
    const transaction = buildTransactTransaction({
      instruction: buildTransactInstruction(args, { signer: depositor, screener }),
      payer: depositor,
      recentBlockhash: BLOCKHASH,
    });
    const { message } = VersionedTransaction.deserialize(transaction.serialize());
    const compiled = message.compiledInstructions[1]!;
    const decoded = decodeTransactInstruction(compiled, message.staticAccountKeys);
    expect(decoded.args).toEqual(args);
    expect(decoded.accounts.screener?.equals(screener)).toBe(true);
    expect(decoded.accounts.signer.equals(depositor)).toBe(true);
    expect(transactAccountsProblem(decoded)).toBeNull();
    expect(() => decodeTransactInstruction(compiled, message.staticAccountKeys.slice(0, 3))).toThrow(/does not have/);
    expect(() => decodeTransactInstruction(compiled as never)).toThrow(/account keys/);
  });

  it("refuses instructions that are not a well-formed transact call", () => {
    const args = sampleArgs();
    const good = buildTransactInstruction(args, { signer: relayer });
    const fewer = { programId: good.programId, keys: good.keys.slice(0, 9), data: good.data };
    expect(() => decodeTransactInstruction(fewer as never)).toThrow(/ten accounts/);
    const transfer = SystemProgram.transfer({ fromPubkey: relayer, toPubkey: relayer, lamports: 1 });
    expect(() => decodeTransactInstruction(transfer)).toThrow(/not a loch_pool transact/);
  });

  it("names what is wrong with accounts the program would reject", () => {
    const args = sampleArgs();
    const decoded = decodeTransactInstruction(buildTransactInstruction(args, { signer: relayer }));
    const swap = (name: keyof typeof decoded.accounts) => ({ ...decoded, accounts: { ...decoded.accounts, [name]: address("evil") } });
    expect(transactAccountsProblem(swap("config"))).toMatch(/config/);
    expect(transactAccountsProblem(swap("tree"))).toMatch(/tree/);
    expect(transactAccountsProblem(swap("vault"))).toMatch(/vault/);
    expect(transactAccountsProblem(swap("nullifier1"))).toMatch(/nullifier1/);
    expect(transactAccountsProblem(swap("recipient"))).toMatch(/recipient/);
    expect(transactAccountsProblem(swap("relayer"))).toMatch(/relayer/);
    expect(transactAccountsProblem(swap("systemProgram"))).toMatch(/system program/);
    const aliased = { ...decoded, args: { ...args, inputNullifiers: [fieldToBytesUnchecked(FIELD_MODULUS + 5n), args.inputNullifiers[1]] as [Uint8Array, Uint8Array] } };
    expect(transactAccountsProblem(aliased)).toMatch(/field modulus/);
  });
});

describe("transaction", () => {
  const relayer = address("relayer");
  const depositor = address("depositor");
  const screener = address("screener");
  const transferArgs = sampleArgs({ recipient: relayer, relayer, extAmount: 0n });
  const transferInstruction = buildTransactInstruction(transferArgs, { signer: relayer });

  it("is a v0 transaction: compute-unit limit, then transact", () => {
    const transaction = buildTransactTransaction({ instruction: transferInstruction, payer: relayer, recentBlockhash: BLOCKHASH });
    expect(transaction.version).toBe(0);
    const decompiled = TransactionMessage.decompile(transaction.message);
    expect(decompiled.payerKey.equals(relayer)).toBe(true);
    expect(decompiled.instructions).toHaveLength(2);
    expect(decompiled.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(decompiled.instructions[0]!.data[0]).toBe(2);
    expect(decompiled.instructions[0]!.data.readUInt32LE(1)).toBe(DEFAULT_COMPUTE_UNIT_LIMIT);
    expect(DEFAULT_COMPUTE_UNIT_LIMIT).toBe(300_000);
    expect(decodeTransactInstruction(decompiled.instructions[1]!).args).toEqual(transferArgs);
    expect(transaction.signatures).toHaveLength(1);
  });

  it("takes a custom limit and an optional price", () => {
    const transaction = buildTransactTransaction({
      instruction: transferInstruction,
      payer: relayer,
      recentBlockhash: BLOCKHASH,
      computeUnitLimit: 250_000,
      computeUnitPrice: 1234n,
    });
    const { instructions } = TransactionMessage.decompile(transaction.message);
    expect(instructions).toHaveLength(3);
    expect(instructions[0]!.data.readUInt32LE(1)).toBe(250_000);
    expect(instructions[1]!.data[0]).toBe(3);
    expect(instructions[1]!.data.readBigUInt64LE(1)).toBe(1234n);
    expect(instructions[2]!.programId.equals(PROGRAM_ID)).toBe(true);
    expect(() => buildTransactTransaction({ instruction: transferInstruction, payer: relayer, recentBlockhash: BLOCKHASH, computeUnitLimit: 0 })).toThrow(/computeUnitLimit/);
    expect(() => buildTransactTransaction({ instruction: transferInstruction, payer: relayer, recentBlockhash: BLOCKHASH, computeUnitPrice: -1 })).toThrow(/computeUnitPrice/);
  });

  it("fits in a packet with 87-byte encrypted notes, for every transaction type", () => {
    const sizes: Record<string, number> = {};
    const build = (name: string, args: TransactArgs, payer: PublicKey, signers: { signer: PublicKey; screener?: PublicKey }) => {
      const transaction = buildTransactTransaction({
        instruction: buildTransactInstruction(args, signers),
        payer,
        recentBlockhash: BLOCKHASH,
        computeUnitPrice: 1000,
      });
      sizes[name] = transaction.serialize().length;
    };
    build("transfer", transferArgs, relayer, { signer: relayer });
    build("withdrawal", sampleArgs({ relayer }), relayer, { signer: relayer });
    build("deposit", sampleArgs({ recipient: depositor, relayer: depositor, extAmount: 1n, fee: 0n }), depositor, { signer: depositor, screener });
    expect(sizes.transfer).toBeLessThanOrEqual(1232);
    expect(sizes.withdrawal).toBeLessThanOrEqual(1232);
    expect(sizes.deposit).toBeLessThanOrEqual(1232);
    // Pinned so that a change in layout is noticed: these are the real sizes.
    expect(sizes).toEqual({ transfer: 1112, withdrawal: 1144, deposit: 1208 });
  });

  it("refuses a transaction that exceeds 1232 bytes", () => {
    const big = sampleArgs({ relayer, encryptedOutput0: randomBytes(256), encryptedOutput1: randomBytes(256) });
    expect(() =>
      buildTransactTransaction({ instruction: buildTransactInstruction(big, { signer: relayer }), payer: relayer, recentBlockhash: BLOCKHASH }),
    ).toThrow(expect.objectContaining({ code: "TRANSACTION_TOO_LARGE" }));
  });

  it("shrinks with an address lookup table", () => {
    const lookupTable = new AddressLookupTableAccount({
      key: address("lookup table"),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [configPda(), treePda(), vaultPda(), SystemProgram.programId, ComputeBudgetProgram.programId],
      },
    });
    const plain = buildTransactTransaction({ instruction: transferInstruction, payer: relayer, recentBlockhash: BLOCKHASH });
    const compressed = buildTransactTransaction({ instruction: transferInstruction, payer: relayer, recentBlockhash: BLOCKHASH, lookupTable });
    expect(compressed.message.addressTableLookups).toHaveLength(1);
    expect(compressed.serialize().length).toBeLessThan(plain.serialize().length);
  });

  it("reports an unusable blockhash as an argument error, not as a size problem", () => {
    expect(() => buildTransactTransaction({ instruction: transferInstruction, payer: relayer, recentBlockhash: "not base58!" })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
});

describe("fieldToBytes", () => {
  it("is 32 bytes big-endian and refuses values outside the field", () => {
    expect(bytesToHex(fieldToBytes(1n))).toBe("00".repeat(31) + "01");
    expect(bytesToHex(fieldToBytes(FIELD_MODULUS - 1n))).toBe("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000");
    expect(() => fieldToBytes(FIELD_MODULUS)).toThrow(/field element/);
    expect(() => fieldToBytes(-1n)).toThrow(/field element/);
  });
});
