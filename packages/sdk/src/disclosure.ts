// Disclosure: what a wallet can choose to show about its own transactions, and
// how anyone checks it against the chain. No circuit and no program is
// involved: everything rests on two hashes.
//
//   commitment = Poseidon(amount, publicKey, blinding)
//   nullifier  = Poseidon(commitment, leafIndex, tag),  tag = Poseidon(privateKey, commitment, leafIndex)
//
// Opening a note (amount, publicKey, blinding) shows what a commitment on
// chain holds. Giving the note's `tag` as well shows which nullifier on chain
// spent it, and so in which transaction, without giving the spending key: the
// tag is a hash of the key and good for that one note only.
//
// Two documents are built from this. A payment receipt opens one output of one
// transaction: this much was paid to this address. A source-of-funds report
// opens the inputs of a withdrawal and of the transactions behind it, back to
// the deposits: this is where the withdrawn lamports came from. Both show what
// they open to whoever holds the document and nothing else about the wallet.
// docs/protocol.md section 16.

import { base58 } from "@scure/base";
import { PublicKey } from "@solana/web3.js";
import type { Connection, Finality } from "@solana/web3.js";
import { poseidon3 } from "poseidon-lite/poseidon3";

import { type ShieldedAddress, decodeShieldedAddress, encodeShieldedAddress } from "./address.js";
import { bytesToBigIntBE } from "./bytes.js";
import type { TransactArgs } from "./codec.js";
import { DEFAULT_COMMITMENT, FIELD_MODULUS, MAX_AMOUNT, PROGRAM_ID, TREE_DEPTH } from "./constants.js";
import { LochError } from "./errors.js";
import { type TransactionLike, type TransactionTime, parseEventLogs, transactCallsOf, transactionTime } from "./events.js";
import { type CompiledInstructionLike, decodeTransactInstruction } from "./instruction.js";
import { type Note, createNote, noteCommitment } from "./note.js";
import { nullifierPda } from "./pda.js";

/** An input note of a transaction, opened: the note, where it sat, and the tag that ties it to its nullifier. */
export interface InputOpening {
  note: Note;
  /** Position of the note's commitment in the tree. 0 for a dummy, which is in no tree. */
  leafIndex: number;
  /** `Poseidon(privateKey, commitment, leafIndex)`. Shows when this one note was spent; spends nothing. */
  tag: bigint;
}

/** `Poseidon(privateKey, commitment, leafIndex)`: the inner hash of a note's nullifier. */
export function spendTag(note: Note, leafIndex: number | bigint, privateKey: bigint): bigint {
  const index = BigInt(leafIndex);
  return poseidon3([privateKey, noteCommitment(note), index]);
}

/** Opens an input note of a transaction for a later disclosure. */
export function openInput(note: Note, leafIndex: number | bigint, privateKey: bigint): InputOpening {
  return { note: { amount: note.amount, publicKey: note.publicKey, blinding: note.blinding }, leafIndex: Number(leafIndex), tag: spendTag(note, leafIndex, privateKey) };
}

/** The nullifier an opened input has on chain: `Poseidon(commitment, leafIndex, tag)`. */
export function nullifierOfOpening(input: InputOpening): bigint {
  return poseidon3([noteCommitment(input.note), BigInt(input.leafIndex), input.tag]);
}

// ------------------------------------------------------------- documents

/**
 * A payment receipt: one output note of one transaction, opened.
 *
 * It shows that the transaction created a note of `note.amount` lamports for
 * the owner key in `recipient`. It does not show who paid: the payer and the
 * recipient can both make this receipt, and nobody else can.
 */
export interface PaymentReceipt {
  programId: PublicKey;
  /** One of the two nullifiers of the paying transaction: public, and enough to find it. */
  nullifier: bigint;
  /** The transaction id, if the wallet has one. A hint: the check does not rely on it. */
  signature?: string;
  /** The address that was paid. Only its owner key is bound by the chain; see {@link verifyReceipt}. */
  recipient: ShieldedAddress;
  /** The note that was created for the recipient. */
  note: Note;
}

/** The inputs of one transaction, opened. */
export interface TransactDisclosure {
  /** The transaction id, if the wallet has one. A hint: the check does not rely on it. */
  signature?: string;
  /** Both inputs, in any order, dummies included. */
  inputs: [InputOpening, InputOpening];
}

/** A {@link TransactDisclosure} as a wallet keeps it: with the commitments the transaction created. */
export interface TransactRecord extends TransactDisclosure {
  outputs: [bigint, bigint];
}

/**
 * A source-of-funds report for one withdrawal: its inputs opened, and the
 * inputs of the wallet's earlier transactions that created those notes, as far
 * back as the wallet has them.
 */
export interface SourceReport {
  programId: PublicKey;
  withdrawal: TransactDisclosure;
  history: TransactDisclosure[];
}

/** The most transactions a report may carry. Checking one costs the verifier at least one request. */
export const MAX_REPORT_TRANSACTIONS = 256;

/**
 * Chooses, from the records of the wallet's own transactions, the ones a
 * report on `withdrawal` needs: every transaction that created a note the
 * withdrawal spent, and so on backwards. A note no record accounts for (it
 * came from someone else, or from a device that kept no record) ends its
 * branch; the verifier reports it as an origin that is not disclosed.
 *
 * @throws LochError `INVALID_ARGUMENT` if the trail is longer than {@link MAX_REPORT_TRANSACTIONS}.
 */
export function buildSourceReport(withdrawal: TransactRecord, records: readonly TransactRecord[], programId: PublicKey = PROGRAM_ID): SourceReport {
  const byOutput = new Map<string, TransactRecord>();
  for (const record of records) for (const commitment of record.outputs) byOutput.set(commitment.toString(), record);
  const history: TransactRecord[] = [];
  const seen = new Set<TransactRecord>([withdrawal]);
  const queue = [withdrawal];
  for (let record = queue.shift(); record; record = queue.shift()) {
    for (const input of record.inputs) {
      if (input.note.amount === 0n) continue;
      const creator = byOutput.get(noteCommitment(input.note).toString());
      if (!creator || seen.has(creator)) continue;
      seen.add(creator);
      history.push(creator);
      queue.push(creator);
      if (history.length >= MAX_REPORT_TRANSACTIONS) throw new LochError("INVALID_ARGUMENT", "the trail behind this withdrawal is too long for one report");
    }
  }
  const disclose = ({ signature, inputs }: TransactRecord): TransactDisclosure => ({ ...(signature ? { signature } : {}), inputs });
  return { programId, withdrawal: disclose(withdrawal), history: history.map(disclose) };
}

// ---------------------------------------------------------------- as text

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** Larger than any document this module writes. */
const MAX_DOCUMENT_LENGTH = 512 * 1024;

function malformed(what: string): never {
  throw new LochError("DECODE_FAILED", `not a valid Loch disclosure: ${what}`);
}

function decimal(value: unknown, limit: bigint, what: string): bigint {
  if (typeof value !== "string" || value.length > 78 || !DECIMAL.test(value)) return malformed(`${what} is not a decimal number`);
  const parsed = BigInt(value);
  return parsed < limit ? parsed : malformed(`${what} is out of range`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : malformed(`${what} is not an object`);
}

function programOf(value: unknown): PublicKey {
  try {
    if (typeof value === "string" && new PublicKey(value).toBase58() === value) return new PublicKey(value);
  } catch {
    // Reported below.
  }
  return malformed("programId is not a base58 public key");
}

function signatureOf(value: unknown): { signature?: string } {
  if (value === undefined) return {};
  return typeof value === "string" && SIGNATURE.test(value) ? { signature: value } : malformed("signature is not a transaction id");
}

function noteOf(value: Record<string, unknown>, publicKey: bigint): Note {
  return { amount: decimal(value.amount, MAX_AMOUNT + 1n, "amount"), publicKey, blinding: decimal(value.blinding, 1n << 248n, "blinding") };
}

function inputToJson(input: InputOpening) {
  const { amount, publicKey, blinding } = createNote(input.note.amount, input.note.publicKey, input.note.blinding);
  return { amount: amount.toString(), publicKey: publicKey.toString(), blinding: blinding.toString(), leafIndex: input.leafIndex, tag: input.tag.toString() };
}

function inputOf(value: unknown): InputOpening {
  const item = record(value, "an input");
  const { leafIndex } = item;
  if (typeof leafIndex !== "number" || !Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= 2 ** TREE_DEPTH) return malformed("leafIndex is outside the tree");
  return { note: noteOf(item, decimal(item.publicKey, FIELD_MODULUS, "publicKey")), leafIndex, tag: decimal(item.tag, FIELD_MODULUS, "tag") };
}

function disclosureToJson(disclosure: TransactDisclosure) {
  return { ...(disclosure.signature ? { signature: disclosure.signature } : {}), inputs: disclosure.inputs.map(inputToJson) };
}

function disclosureOf(value: unknown): TransactDisclosure {
  const item = record(value, "a transaction");
  if (!Array.isArray(item.inputs) || item.inputs.length !== 2) return malformed("a transaction has exactly two inputs");
  return { ...signatureOf(item.signature), inputs: [inputOf(item.inputs[0]), inputOf(item.inputs[1])] };
}

function parse(text: string, kind: string): Record<string, unknown> {
  if (typeof text !== "string" || text.length > MAX_DOCUMENT_LENGTH) return malformed("too long");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return malformed("not JSON");
  }
  const parsed = record(value, "the document");
  if (parsed.loch !== kind) return malformed(`not a ${kind}`);
  if (parsed.version !== 1) return malformed("unknown version");
  return parsed;
}

/**
 * A receipt as text: one line of JSON, `{"loch":"receipt","version":1,...}`,
 * numbers as decimal strings. Not secret from the payer or the recipient, who
 * know all of it; to anyone else it gives the amount and the recipient of this
 * one payment.
 */
export function encodeReceipt(receipt: PaymentReceipt): string {
  const { amount, blinding } = createNote(receipt.note.amount, receipt.note.publicKey, receipt.note.blinding);
  if (receipt.recipient.publicKey !== receipt.note.publicKey) throw new LochError("INVALID_ARGUMENT", "the receipt's note does not belong to its recipient");
  return JSON.stringify({
    loch: "receipt",
    version: 1,
    programId: receipt.programId.toBase58(),
    nullifier: receipt.nullifier.toString(),
    ...(receipt.signature ? { signature: receipt.signature } : {}),
    recipient: encodeShieldedAddress(receipt.recipient),
    amount: amount.toString(),
    blinding: blinding.toString(),
  });
}

/** @throws LochError `DECODE_FAILED` if `text` is not a receipt of version 1. */
export function decodeReceipt(text: string): PaymentReceipt {
  const parsed = parse(text, "receipt");
  let recipient: ShieldedAddress;
  try {
    recipient = decodeShieldedAddress(parsed.recipient as string);
  } catch {
    return malformed("recipient is not a shielded address");
  }
  return {
    programId: programOf(parsed.programId),
    nullifier: decimal(parsed.nullifier, FIELD_MODULUS, "nullifier"),
    ...signatureOf(parsed.signature),
    recipient,
    note: noteOf(parsed, recipient.publicKey),
  };
}

/**
 * A report as text: JSON, `{"loch":"source-report","version":1,...}`. It holds
 * the amounts of the wallet's notes on the trail and the tags that show when
 * each was spent. Give it only to whoever is meant to see that.
 */
export function encodeSourceReport(report: SourceReport): string {
  if (report.history.length > MAX_REPORT_TRANSACTIONS) throw new LochError("INVALID_ARGUMENT", "too many transactions for one report");
  return JSON.stringify({
    loch: "source-report",
    version: 1,
    programId: report.programId.toBase58(),
    withdrawal: disclosureToJson(report.withdrawal),
    history: report.history.map(disclosureToJson),
  });
}

/** @throws LochError `DECODE_FAILED` if `text` is not a report of version 1. */
export function decodeSourceReport(text: string): SourceReport {
  const parsed = parse(text, "source-report");
  if (!Array.isArray(parsed.history) || parsed.history.length > MAX_REPORT_TRANSACTIONS) return malformed("history is missing or too long");
  return { programId: programOf(parsed.programId), withdrawal: disclosureOf(parsed.withdrawal), history: parsed.history.map(disclosureOf) };
}

// ------------------------------------------------------- finding the chain's side

/** The RPC methods a check uses. A web3.js `Connection` satisfies it. */
export type DisclosureConnection = Pick<Connection, "getSignaturesForAddress" | "getTransaction">;

/** Options of the two checks. */
export interface VerifyOptions {
  /** `confirmed` (default) or `finalized`. */
  commitment?: Finality;
}

/** A successful `transact` call, as the chain has it. */
export interface LocatedTransact extends TransactionTime {
  signature: string;
  args: TransactArgs;
  /** The account that signed for and funded the call: the depositor of a deposit. Null for a call made by another program. */
  signer: PublicKey | null;
  /** Leaf index of each output, where the transaction's logs give it. */
  leafIndices: [number | null, number | null];
}

const MAX_TRANSACTION_VERSION = 1;
const LISTING_PAGE = 1000;
const LISTING_PAGES = 4;
/** Transactions fetched at most while looking for the one that created a nullifier record. */
const MAX_CANDIDATES = 12;

type Fetched = TransactionLike & { transaction: { message: { compiledInstructions: readonly (CompiledInstructionLike | { programIdIndex: number; data: Uint8Array })[] } } };

/** The `transact` call of `tx` that spent `nullifier`, if `tx` succeeded and made one. */
function callSpending(tx: Fetched | null, signature: string, nullifier: bigint, programId: PublicKey): LocatedTransact | null {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const spends = (args: TransactArgs) => args.inputNullifiers.some((bytes) => bytesToBigIntBE(bytes) === nullifier);
  const args = transactCallsOf(tx, programId).find(spends);
  if (!args) return null;
  const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  let signer: PublicKey | null = null;
  for (const instruction of tx.transaction.message.compiledInstructions) {
    if (!("accountKeyIndexes" in instruction) || !keys[instruction.programIdIndex]?.equals(programId)) continue;
    try {
      const decoded = decodeTransactInstruction(instruction, keys);
      if (spends(decoded.args)) signer = decoded.accounts.signer;
    } catch {
      // Not a transact call, or one with other accounts than the program takes.
    }
  }
  const indexOf = new Map(parseEventLogs(tx.meta.logMessages, programId).commitments.map((event) => [event.commitment, event.index]));
  const leaf = (bytes: Uint8Array) => indexOf.get(bytesToBigIntBE(bytes)) ?? null;
  return { signature, args, signer, leafIndices: [leaf(args.outputCommitments[0]), leaf(args.outputCommitments[1])], ...transactionTime(tx) };
}

/**
 * Finds the successful `transact` call that spent `nullifier`.
 *
 * A transaction id given as `hint` is tried first. Without one, or if it is
 * not that transaction, the history of the nullifier's record address is
 * read: the transaction that spent the nullifier created that account, so it
 * is in the list. Other transactions can name the address too (anyone can,
 * for a fee), which is why each candidate is read and checked, oldest first,
 * and why the search gives up after a few of them.
 *
 * Returns null when no such call is found. RPC failures are thrown as they come.
 */
export async function locateTransact(
  connection: DisclosureConnection,
  nullifier: bigint,
  options: VerifyOptions & { hint?: string; programId?: PublicKey } = {},
): Promise<LocatedTransact | null> {
  const programId = options.programId ?? PROGRAM_ID;
  const commitment = options.commitment ?? DEFAULT_COMMITMENT;
  const read = async (signature: string) =>
    callSpending((await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION })) as Fetched | null, signature, nullifier, programId);
  if (options.hint && SIGNATURE.test(options.hint) && isSignature(options.hint)) {
    const found = await read(options.hint);
    if (found) return found;
  }
  const listed: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < LISTING_PAGES; page++) {
    const entries = await connection.getSignaturesForAddress(nullifierPda(nullifier, programId), { before, limit: LISTING_PAGE }, commitment);
    for (const entry of entries) if (entry.err === null && !listed.includes(entry.signature)) listed.push(entry.signature);
    if (entries.length < LISTING_PAGE) break;
    before = entries[entries.length - 1]!.signature;
  }
  // Newest first as listed; the one that created the account is the oldest that succeeded.
  for (const signature of listed.reverse().slice(0, MAX_CANDIDATES)) {
    if (signature === options.hint) continue;
    const found = await read(signature);
    if (found) return found;
  }
  return null;
}

function isSignature(text: string): boolean {
  try {
    return base58.decode(text).length === 64;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- checking

/** What a receipt that checks out says. */
export interface VerifiedReceipt extends TransactionTime {
  ok: true;
  /** The transaction that made the payment. */
  signature: string;
  /** Lamports paid. */
  amount: bigint;
  /** The address in the receipt. */
  recipient: string;
  commitment: bigint;
  /** Where the note sits in the tree, where the transaction's logs say. */
  leafIndex: number | null;
}

/** A document that does not check out, and why, in words fit to show. */
export interface Rejected {
  ok: false;
  problem: string;
}

/**
 * Checks a receipt against the chain: the transaction that spent the
 * receipt's nullifier exists, succeeded, and one of the two commitments it
 * created is `Poseidon(amount, recipient's owner key, blinding)`.
 *
 * What that proves: this transaction created a note of this amount that only
 * the holder of that owner key can spend. Of the address in the receipt only
 * the owner key is bound; compare the address with the one you expect.
 *
 * Privacy: the RPC learns which transaction is being asked about.
 */
export async function verifyReceipt(connection: DisclosureConnection, receipt: PaymentReceipt, options: VerifyOptions = {}): Promise<VerifiedReceipt | Rejected> {
  const located = await locateTransact(connection, receipt.nullifier, { ...options, hint: receipt.signature, programId: receipt.programId });
  if (!located) return { ok: false, problem: "no successful pool transaction with this receipt's nullifier was found" };
  const commitment = noteCommitment(receipt.note);
  const position = located.args.outputCommitments.findIndex((bytes) => bytesToBigIntBE(bytes) === commitment);
  if (position < 0) return { ok: false, problem: "the transaction did not create the note this receipt describes" };
  const { slot, blockTime } = located;
  return {
    ok: true,
    signature: located.signature,
    amount: receipt.note.amount,
    recipient: encodeShieldedAddress(receipt.recipient),
    commitment,
    leafIndex: located.leafIndices[position as 0 | 1],
    ...(slot === undefined ? {} : { slot }),
    ...(blockTime === undefined ? {} : { blockTime }),
  };
}

/** Where lamports on the trail entered it. */
export type FundsOrigin =
  | ({
      /** A deposit: public lamports that entered the pool in a transaction on the trail. */
      kind: "deposit";
      signature: string;
      /** The account that paid the deposit. Null if the deposit was made through another program. */
      depositor: string | null;
      /** Lamports deposited. */
      amount: bigint;
    } & TransactionTime)
  | {
      /**
       * A note the report opens but does not trace further: it was received
       * from another wallet, or the wallet has no record of the transaction
       * that created it.
       */
      kind: "undisclosed";
      /** Lamports in the note. */
      amount: bigint;
      leafIndex: number;
      commitment: bigint;
    };

/** What a report that checks out says. */
export interface VerifiedSource {
  ok: true;
  withdrawal: {
    signature: string;
    /** The account that was paid. */
    recipient: string;
    /** Lamports paid out. */
    amount: bigint;
    /** Lamports paid to the relayer. */
    fee: bigint;
  } & TransactionTime;
  /** Every place lamports entered the trail. */
  origins: FundsOrigin[];
  /** True when every origin is a deposit: the trail is closed. */
  complete: boolean;
  /** Transactions on the trail, the withdrawal included. */
  transactions: number;
}

interface Checked {
  located: LocatedTransact;
  inputs: [InputOpening, InputOpening];
}

async function checkDisclosure(connection: DisclosureConnection, disclosure: TransactDisclosure, programId: PublicKey, options: VerifyOptions): Promise<Checked | Rejected> {
  const nullifiers = disclosure.inputs.map(nullifierOfOpening);
  if (nullifiers[0] === nullifiers[1]) return { ok: false, problem: "a transaction in the report opens the same input twice" };
  const located = await locateTransact(connection, nullifiers[0]!, { ...options, hint: disclosure.signature, programId });
  if (!located) return { ok: false, problem: "a transaction in the report was not found on chain" };
  const onChain = located.args.inputNullifiers.map(bytesToBigIntBE);
  if (!nullifiers.every((nullifier) => onChain.includes(nullifier))) {
    return { ok: false, problem: `the report does not open both inputs of transaction ${located.signature}` };
  }
  return { located, inputs: disclosure.inputs };
}

/**
 * Checks a source-of-funds report against the chain and follows it back.
 *
 * For every transaction in the report: the two opened inputs hash to exactly
 * the two nullifiers of a successful `transact` call on chain. That fixes
 * what the transaction spent, value for value, because a nullifier is a hash
 * of its note's commitment and the commitment a hash of the amount. An input
 * of amount zero carried nothing in. Every other input is looked up among the
 * outputs of the other transactions in the report; where one of them created
 * it, the trail goes on there, and where none did, the note is an origin that
 * the report does not disclose. A transaction that took a deposit is an
 * origin of that deposit.
 *
 * The result lists where the lamports behind the withdrawal entered the
 * trail. It does not split the withdrawn amount among them: notes are merged
 * and split on the way, and the pool has no notion of which lamport is which.
 *
 * One request per transaction at least. Privacy: the RPC learns which
 * transactions are being asked about, which is the trail.
 */
export async function verifySourceReport(connection: DisclosureConnection, report: SourceReport, options: VerifyOptions = {}): Promise<VerifiedSource | Rejected> {
  const { programId } = report;
  const first = await checkDisclosure(connection, report.withdrawal, programId, options);
  if ("ok" in first) return first;
  const { extData } = first.located.args;
  if (extData.extAmount >= 0n) return { ok: false, problem: "the transaction the report is about is not a withdrawal" };

  const byOutput = new Map<bigint, { checked: Checked; position: 0 | 1 }>();
  for (const disclosure of report.history) {
    const checked = await checkDisclosure(connection, disclosure, programId, options);
    if ("ok" in checked) return checked;
    checked.located.args.outputCommitments.forEach((bytes, position) => byOutput.set(bytesToBigIntBE(bytes), { checked, position: position as 0 | 1 }));
  }

  const origins: FundsOrigin[] = [];
  const seen = new Set<string>([first.located.signature]);
  const queue = [first];
  for (let current = queue.shift(); current; current = queue.shift()) {
    const { located } = current;
    const deposited = located.args.extData.extAmount;
    if (deposited > 0n) {
      const { slot, blockTime } = located;
      origins.push({
        kind: "deposit",
        signature: located.signature,
        depositor: located.signer?.toBase58() ?? null,
        amount: deposited,
        ...(slot === undefined ? {} : { slot }),
        ...(blockTime === undefined ? {} : { blockTime }),
      });
    }
    for (const input of current.inputs) {
      if (input.note.amount === 0n) continue;
      const commitment = noteCommitment(input.note);
      const creator = byOutput.get(commitment);
      // The leaf index is part of the nullifier, so it is the chain's word where the note sat; a
      // transaction whose logs put that commitment elsewhere created another leaf, not this note.
      const index = creator?.checked.located.leafIndices[creator.position];
      if (!creator || (index !== null && index !== undefined && index !== input.leafIndex)) {
        origins.push({ kind: "undisclosed", amount: input.note.amount, leafIndex: input.leafIndex, commitment });
        continue;
      }
      if (seen.has(creator.checked.located.signature)) continue;
      seen.add(creator.checked.located.signature);
      queue.push(creator.checked);
    }
  }

  const { slot, blockTime } = first.located;
  return {
    ok: true,
    withdrawal: {
      signature: first.located.signature,
      recipient: extData.recipient.toBase58(),
      amount: -extData.extAmount,
      fee: extData.fee,
      ...(slot === undefined ? {} : { slot }),
      ...(blockTime === undefined ? {} : { blockTime }),
    },
    origins,
    complete: origins.every((origin) => origin.kind === "deposit"),
    transactions: seen.size,
  };
}
