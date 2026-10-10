// Reads plain transfers out of a serialised Solana transaction, legacy or version 0, without
// changing a byte of it. Used by the wrapper to warn before a public transfer is signed.
//
// It understands exactly three instructions, and only when every account they name is in the
// transaction's static account list:
//
//   System program   Transfer                       (instruction 2)
//   SPL Token and Token-2022   Transfer             (instruction 3)
//   SPL Token and Token-2022   TransferChecked      (instruction 12)
//
// Anything else is not an error: the instruction is skipped. A transaction that cannot be parsed
// at all (truncated, an unknown version, trailing bytes) yields null, and the caller passes it to
// the wallet untouched.

import { base58 } from "@scure/base";

import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../shared/constants.js";

export interface DecodedTransfer {
  program: "system" | "token" | "token-2022";
  /** The account that pays: the wallet for SOL, the source token account for a token. */
  source: string;
  /** Who authorises it: the wallet. For SOL the same as `source`. */
  authority: string;
  /** The recipient wallet for SOL, the destination token account for a token. */
  destination: string;
  /** Lamports, or token base units. */
  amount: bigint;
  /** Token transfers that name their mint (TransferChecked). */
  mint?: string;
  decimals?: number;
}

export interface DecodedTransaction {
  version: "legacy" | 0;
  /** Static account keys, base58. */
  accountKeys: string[];
  /** Number of accounts loaded from address lookup tables (their addresses are not in the transaction). */
  lookedUpAccounts: number;
  instructions: number;
  transfers: DecodedTransfer[];
}

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  u8(): number {
    if (this.remaining < 1) throw new RangeError("truncated");
    return this.bytes[this.offset++]!;
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.remaining < length) throw new RangeError("truncated");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /** Solana's compact-u16: 1 to 3 bytes, 7 bits each, canonical encodings only. */
  compactU16(): number {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.u8();
      value |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) {
        if (i > 0 && byte === 0) throw new RangeError("non-canonical length");
        if (value > 0xffff) throw new RangeError("length out of range");
        return value;
      }
    }
    throw new RangeError("length too long");
  }
}

function u64le(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]!);
  return value;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/**
 * Parses a serialised transaction (signatures and message). Returns null when the bytes are not
 * one complete legacy or version-0 transaction.
 */
export function decodeTransaction(bytes: Uint8Array): DecodedTransaction | null {
  try {
    const reader = new Reader(bytes);
    const signatureCount = reader.compactU16();
    reader.take(signatureCount * 64);

    let version: "legacy" | 0 = "legacy";
    const first = reader.u8();
    let requiredSignatures = first;
    if ((first & 0x80) !== 0) {
      if ((first & 0x7f) !== 0) return null; // a version this code does not know
      version = 0;
      requiredSignatures = reader.u8();
    }
    reader.u8(); // read-only signed accounts
    reader.u8(); // read-only unsigned accounts
    if (requiredSignatures !== signatureCount) return null;

    const keyCount = reader.compactU16();
    if (keyCount === 0 || keyCount < requiredSignatures) return null;
    const accountKeys: string[] = [];
    for (let i = 0; i < keyCount; i++) accountKeys.push(base58.encode(reader.take(32)));
    reader.take(32); // recent blockhash

    const instructionCount = reader.compactU16();
    const raw: { program: number; accounts: number[]; data: Uint8Array }[] = [];
    for (let i = 0; i < instructionCount; i++) {
      const program = reader.u8();
      const accountCount = reader.compactU16();
      const accounts = Array.from(reader.take(accountCount));
      const dataLength = reader.compactU16();
      raw.push({ program, accounts, data: reader.take(dataLength) });
    }

    let lookedUpAccounts = 0;
    if (version === 0) {
      const lookupCount = reader.compactU16();
      for (let i = 0; i < lookupCount; i++) {
        reader.take(32);
        const writable = reader.compactU16();
        reader.take(writable);
        const readonly = reader.compactU16();
        reader.take(readonly);
        lookedUpAccounts += writable + readonly;
      }
    }
    if (reader.remaining !== 0) return null;

    const total = accountKeys.length + lookedUpAccounts;
    const transfers: DecodedTransfer[] = [];
    for (const instruction of raw) {
      if (instruction.program >= total || instruction.accounts.some((index) => index >= total)) return null;
      const program = accountKeys[instruction.program];
      if (program === undefined) continue; // a program loaded from a lookup table: cannot be one of the three
      const key = (position: number): string | undefined => {
        const index = instruction.accounts[position];
        return index === undefined ? undefined : accountKeys[index];
      };
      const { data } = instruction;
      if (program === SYSTEM_PROGRAM) {
        if (data.length !== 12 || u32le(data, 0) !== 2) continue;
        const source = key(0);
        const destination = key(1);
        if (source === undefined || destination === undefined) continue;
        transfers.push({ program: "system", source, authority: source, destination, amount: u64le(data, 4) });
      } else if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
        const name = program === TOKEN_PROGRAM ? "token" : "token-2022";
        if (data.length === 9 && data[0] === 3) {
          const [source, destination, authority] = [key(0), key(1), key(2)];
          if (source === undefined || destination === undefined || authority === undefined) continue;
          transfers.push({ program: name, source, authority, destination, amount: u64le(data, 1) });
        } else if (data.length === 10 && data[0] === 12) {
          const [source, mint, destination, authority] = [key(0), key(1), key(2), key(3)];
          if (source === undefined || mint === undefined || destination === undefined || authority === undefined) continue;
          transfers.push({ program: name, source, authority, destination, amount: u64le(data, 1), mint, decimals: data[9]! });
        }
      }
    }
    return { version, accountKeys, lookedUpAccounts, instructions: raw.length, transfers };
  } catch {
    return null;
  }
}

/** The transfers in `bytes` that `wallet` pays for. Null when the transaction cannot be read. */
export function transfersFrom(bytes: Uint8Array, wallet: string): DecodedTransfer[] | null {
  const decoded = decodeTransaction(bytes);
  if (decoded === null) return null;
  return decoded.transfers.filter((transfer) => transfer.authority === wallet);
}
