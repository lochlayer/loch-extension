import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { decodeTransaction, transfersFrom } from "../src/background/txdecode.js";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../src/shared/constants.js";

const wallet = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();
const me = wallet.publicKey.toBase58();

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function splTransfer(program: string, source: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([3]), u64(amount)]),
  });
}

function splTransferChecked(program: string, source: PublicKey, mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]),
  });
}

function legacy(instructions: TransactionInstruction[], signed = true): Uint8Array {
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(...instructions);
  if (signed) tx.sign(wallet);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

function v0(instructions: TransactionInstruction[], tables: AddressLookupTableAccount[] = []): Uint8Array {
  const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(tables);
  return new VersionedTransaction(message).serialize();
}

describe("reading transfers out of a transaction", () => {
  it("a system transfer, legacy", () => {
    const bytes = legacy([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 1_250_000_000 })]);
    const decoded = decodeTransaction(bytes);
    expect(decoded?.version).toBe("legacy");
    expect(transfersFrom(bytes, me)).toEqual([{ program: "system", source: me, authority: me, destination: recipient.toBase58(), amount: 1_250_000_000n }]);
  });

  it("a system transfer, version 0, unsigned", () => {
    const bytes = v0([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 5 })]);
    expect(decodeTransaction(bytes)?.version).toBe(0);
    expect(transfersFrom(bytes, me)).toEqual([{ program: "system", source: me, authority: me, destination: recipient.toBase58(), amount: 5n }]);
  });

  it("an SPL token Transfer names no mint", () => {
    const source = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const bytes = legacy([splTransfer(TOKEN_PROGRAM, source, destination, wallet.publicKey, 25_000_000n)]);
    expect(transfersFrom(bytes, me)).toEqual([{ program: "token", source: source.toBase58(), authority: me, destination: destination.toBase58(), amount: 25_000_000n }]);
  });

  it("an SPL token TransferChecked carries the mint and decimals, for both token programs", () => {
    const [source, mint, destination] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    for (const [program, name] of [
      [TOKEN_PROGRAM, "token"],
      [TOKEN_2022_PROGRAM, "token-2022"],
    ] as const) {
      const bytes = v0([splTransferChecked(program, source, mint, destination, wallet.publicKey, 1_500_000n, 6)]);
      expect(transfersFrom(bytes, me)).toEqual([
        { program: name, source: source.toBase58(), authority: me, destination: destination.toBase58(), amount: 1_500_000n, mint: mint.toBase58(), decimals: 6 },
      ]);
    }
  });

  it("several instructions: every transfer is found, the rest is skipped", () => {
    const other = Keypair.generate().publicKey;
    const [source, destination] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("hello") });
    const bytes = v0([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 1 }),
      memo,
      splTransfer(TOKEN_PROGRAM, source, destination, wallet.publicKey, 7n),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other, lamports: 2 }),
    ]);
    const decoded = decodeTransaction(bytes);
    expect(decoded?.instructions).toBe(5);
    expect(transfersFrom(bytes, me)?.map((t) => [t.program, t.destination, t.amount])).toEqual([
      ["system", recipient.toBase58(), 1n],
      ["token", destination.toBase58(), 7n],
      ["system", other.toBase58(), 2n],
    ]);
  });

  it("only transfers the wallet pays for count", () => {
    const someone = Keypair.generate();
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: someone.publicKey, toPubkey: recipient, lamports: 9 }),
    );
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    expect(decodeTransaction(bytes)?.transfers).toHaveLength(1);
    expect(transfersFrom(bytes, me)).toEqual([]);
  });

  it("other system and token instructions are not transfers", () => {
    const account = Keypair.generate().publicKey;
    const bytes = legacy(
      [
        SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: account, lamports: 1_000_000, space: 0, programId: SystemProgram.programId }),
        new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), keys: [{ pubkey: account, isSigner: false, isWritable: true }], data: Buffer.from([9]) }),
      ],
      false,
    );
    expect(transfersFrom(bytes, me)).toEqual([]);
  });

  it("a transfer whose accounts come from a lookup table cannot be read, and is not guessed at", () => {
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [recipient] },
    });
    const bytes = v0([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 5 })], [table]);
    const decoded = decodeTransaction(bytes);
    expect(decoded?.lookedUpAccounts).toBe(1);
    expect(decoded?.transfers).toEqual([]);
  });

  it("undecodable input yields null and is left byte for byte as it was", () => {
    const good = legacy([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 1 })]);
    const inputs: Uint8Array[] = [
      new Uint8Array(),
      Uint8Array.of(0),
      Uint8Array.of(1, 2, 3),
      good.slice(0, good.length - 1),
      Uint8Array.from([...good, 0]),
      crypto.getRandomValues(new Uint8Array(300)),
      (() => {
        const future = v0([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 1 })]);
        future[1 + 64] = 0x81; // version 1
        return future;
      })(),
    ];
    for (const input of inputs) {
      const copy = Uint8Array.from(input);
      expect(decodeTransaction(input)).toBeNull();
      expect(transfersFrom(input, me)).toBeNull();
      expect(Buffer.from(input).equals(Buffer.from(copy))).toBe(true);
    }
  });

  it("decoding never changes the bytes it reads", () => {
    const bytes = v0([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 77 })]);
    const copy = Uint8Array.from(bytes);
    transfersFrom(bytes, me);
    expect(Buffer.from(bytes).equals(Buffer.from(copy))).toBe(true);
  });

  it("agrees with web3.js about the accounts of a real transaction", () => {
    const bytes = v0([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 3 }),
    ]);
    const decoded = decodeTransaction(bytes);
    const reference = VersionedTransaction.deserialize(bytes).message.staticAccountKeys.map((key) => key.toBase58());
    expect(decoded?.accountKeys).toEqual(reference);
  });
});
