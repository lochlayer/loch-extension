// The move (docs/v2.md section 11): the earlier pool's two largest notes into the new pool, in
// one transaction the relayer pays for. A move is a surface to this wallet with no fee, beside a
// deposit of the same amount from this wallet, and the relayer's refund of that deposit's rent:
// the wallet ends where it started, and pays nothing.
//
// Its steps, after the surface's checking and proving (the deposit is proven with it):
//
//   signing    the move is built and shown to the wallet, with no signature in it
//   cosigning  the screening service co-signs what the wallet returned (the wallet may have
//              added its assertions); the deposit is screened like any other
//   sending    the relayer checks it, signs as fee payer and sends it
//   confirming as for any spend: the chain decides
//
// The rules of every spend hold (flows.ts): one set of notes per flow, and the chain decides.
// Until the relayer has the move, nobody can complete it: it needs the relayer's signature as
// fee payer. So a move that stops before "sending" lets its notes go.

import { ed25519 } from "@noble/curves/ed25519";
import { PROGRAM_ID, applyScreenerSignature, deserializeTransaction, encodeTransactArgs, parseProgramError, prepareWithdrawal, toRelayRequest, toScreenRequest } from "@loch/sdk";
import type { OwnedNote } from "@loch/sdk";
import {
  NATIVE_MINT,
  buildMoveTransaction,
  decodeTransactArgsV2,
  encodeTransactArgsV2,
  fetchAssetConfig,
  fetchPoolConfigV2,
  fetchTreeV2Account,
  inspectMoveTransaction,
  moveTermsOf,
  prepareDepositV2,
} from "@loch/sdk/v2";
import { fromRelayRequest } from "@loch/sdk/wire";
import { PublicKey, type VersionedTransaction } from "@solana/web3.js";

import { bytesEqual, fromBase64, toBase64 } from "../shared/bytes.js";
import { SYSTEM_RENT_MINIMUM, chainOf } from "../shared/constants.js";
import type { BridgeAnswer } from "../shared/messages.js";
import { closeBridgeTab } from "./bridge.js";
import { type Core, type FlowProof, type SpendRecord, fail } from "./core.js";
import {
  ask,
  base,
  begin,
  checkCancel,
  earlierProofs,
  letGo,
  programFailure,
  relayFailed,
  reserve,
  screeningFailure,
  succeed,
  synced,
  unlocked,
  walletFailure,
  wireDetail,
  wireReason,
} from "./flows.js";
import { assertAllowedCluster, readCluster } from "./network.js";
import { onlyNotes, spendableNotes, withLocks } from "./pending.js";
import { addRecord, recordOf } from "./records.js";
import type { WalletRuntime } from "./store.js";
import { syncWalletNow } from "./sync.js";

/** Starts a move of the earlier pool's two largest notes. */
export async function startMove(core: Core): Promise<void> {
  const runtime = await unlocked(core);
  const flow: SpendRecord = {
    ...base(core, "surface", runtime.address, "checking"),
    kind: "surface",
    address: runtime.address,
    amount: "0",
    fee: "0",
    reproved: 0,
    to: runtime.address,
    move: true,
    walletName: runtime.walletName,
    connectUrl: (await core.settings()).connectUrl,
  };
  await begin(core, flow);
}

/** The two largest notes, largest first. */
function largestTwo(notes: readonly OwnedNote[]): OwnedNote[] {
  return [...notes].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)).slice(0, 2);
}

/** Forgets the deposit half and the transactions built from it. */
function forgetMove(flow: SpendRecord): void {
  delete flow.moveDeposit;
  delete flow.moveOutputs;
  delete flow.moveUnsigned;
  delete flow.moveWalletSigned;
  delete flow.moveSigned;
}

/**
 * A move that failed or was cancelled before the relayer had it: nobody can complete what was
 * signed so far, so its notes go back to the balance and its proofs are forgotten.
 */
export async function releaseMove(core: Core, flow: SpendRecord): Promise<void> {
  if (!flow.move || flow.handed) return;
  const runtime = await core.store.runtime(flow.address).catch(() => null);
  if (runtime) await letGo(core, runtime, flow, "keep");
  forgetMove(flow);
}

export async function stepMove(core: Core, flow: SpendRecord): Promise<void> {
  const { settings, chain } = await core.chain();
  const runtime = await core.store.runtime(flow.address);
  if (!runtime) throw fail("locked");
  const wallet = new PublicKey(flow.address);
  const relayer = core.env.relayerV2(settings, chain);
  const relayerInfo = async () => {
    try {
      return await relayer.info();
    } catch (error) {
      throw fail("relayer-unreachable", { retry: true, detail: wireDetail(settings.relayerUrl, error), ...wireReason(error) });
    }
  };

  switch (flow.step) {
    case "checking": {
      const cluster = await readCluster(chain.connection);
      assertAllowedCluster(cluster);
      const sync = await syncWalletNow(core, flow.address);
      if (!synced(sync)) throw fail(sync.status === "mainnet" ? "mainnet" : "sync-failed", { retry: true, detail: sync.detail });
      const earlier = await earlierProofs(chain, runtime, flow);
      if (earlier === "landed") {
        await succeed(core, runtime, flow);
        return;
      }
      if (earlier === "dead") {
        await letGo(core, runtime, flow, "keep");
        forgetMove(flow);
      }

      const info = await relayerInfo();
      if (info.programId !== PROGRAM_ID.toBase58() || info.genesisHash !== cluster.genesisHash || info.cluster !== cluster.cluster) throw fail("relayer-mismatch");
      if (!info.move) throw fail("move-unavailable");
      const terms = moveTermsOf(info.move);
      // The new pool takes SOL now, and the screening service is the one it names.
      const [config, asset] = await Promise.all([fetchPoolConfigV2(chain.connection), fetchAssetConfig(chain.connection, NATIVE_MINT)]);
      if (config.paused || !asset.depositsEnabled) throw fail("deposits-paused");
      let screener;
      try {
        screener = await core.env.screener(settings, chain).info();
      } catch (error) {
        throw fail("screener-unreachable", { retry: true, detail: wireDetail(settings.screenerUrl, error), ...wireReason(error) });
      }
      if (screener.screener !== config.screener.toBase58() || screener.programId !== PROGRAM_ID.toBase58() || screener.cluster !== cluster.cluster) throw fail("screener-mismatch");

      if (flow.inputs && flow.request && flow.moveDeposit && flow.request.extData.relayer === info.relayer) {
        // Proven before, for this relayer: build it again with a fresh blockhash and ask the wallet.
        flow.relayer = info.relayer;
        await core.enter(flow, "signing");
        return;
      }
      delete flow.request;
      forgetMove(flow);
      flow.relayer = info.relayer;

      const others = runtime.pending.filter((entry) => entry.flowId !== flow.id);
      const free = spendableNotes(runtime.state, others);
      const bound = flow.inputs;
      const notes = bound ? free.filter((note) => bound.includes(note.commitment.toString())) : largestTwo(free);
      if (bound && notes.length !== bound.length) throw fail("reserved-short");
      const held = notes.reduce((sum, note) => sum + note.amount, 0n);
      if (held === 0n) throw fail("insufficient-shielded");
      // What one deposit may take; the rest stays in the earlier pool as change.
      const amount = held < asset.maxDeposit ? held : asset.maxDeposit;
      const minimum = terms.minLamports > SYSTEM_RENT_MINIMUM ? terms.minLamports : SYSTEM_RENT_MINIMUM;
      if (amount < minimum) throw fail("below-minimum", { limit: minimum.toString() });
      flow.amount = amount.toString();
      await core.enter(flow, "proving");
      return;
    }
    case "proving": {
      if (!flow.relayer) throw fail("internal");
      const amount = BigInt(flow.amount);
      const others = runtime.pending.filter((entry) => entry.flowId !== flow.id);
      const locked = withLocks(runtime.state, others);
      const chosen = flow.inputs ?? largestTwo(spendableNotes(runtime.state, others)).map((note) => note.commitment.toString());
      // The surface half: to this wallet, no fee.
      const withdrawal = await prepareWithdrawal({
        prover: core.env.prover,
        keys: runtime.keys,
        state: onlyNotes(locked, chosen),
        tree: core.store.tree(runtime),
        relayer: new PublicKey(flow.relayer),
        fee: 0n,
        maxFee: 0n,
        recipient: wallet,
        amount,
      });
      // The deposit half: the same amount from this wallet, to a note of its own in the new pool.
      const [config, asset, tree] = await Promise.all([fetchPoolConfigV2(chain.connection), fetchAssetConfig(chain.connection, NATIVE_MINT), fetchTreeV2Account(chain.connection)]);
      const deposit = await prepareDepositV2({ prover: core.env.proverV2, keys: runtime.v2.keys, mint: NATIVE_MINT, amount, depositor: wallet, root: tree.root, config, asset, emptyPadding: true });
      await checkCancel(core, flow);
      const spent = withdrawal.spent.map((note) => note.commitment.toString());
      if (spent.length === 0 || (flow.inputs && (spent.length !== flow.inputs.length || !spent.every((commitment) => flow.inputs!.includes(commitment))))) throw fail("reserved-short");
      const outputs = withdrawal.outputs.map((output) => output.commitment.toString());
      const proof: FlowProof = { outputs, root: withdrawal.publicInputs.root.toString(), leaves: runtime.state.leaves.length, fee: "0" };
      flow.request = toRelayRequest(withdrawal.args);
      flow.inputs ??= spent;
      flow.outputs = outputs;
      flow.proofs = [...(flow.proofs ?? []), proof];
      flow.moveDeposit = toBase64(encodeTransactArgsV2(deposit.args));
      flow.moveOutputs = deposit.outputs.map((output) => output.commitment.toString());
      runtime.ownOutputs.push(...outputs, ...flow.moveOutputs);
      runtime.records = addRecord(runtime.records, recordOf(flow.id, withdrawal, runtime.keys.publicKey, core.env.now()), runtime.state, core.env.now());
      await core.store.saveRecords(runtime);
      await reserve(core, runtime, flow);
      await core.enter(flow, "signing");
      return;
    }
    case "signing": {
      if (!flow.request || !flow.moveDeposit || !flow.relayer || !flow.walletName) throw fail("internal");
      if (!runtime.pending.some((entry) => entry.flowId === flow.id)) await reserve(core, runtime, flow);
      const info = await relayerInfo();
      if (!info.move) throw fail("move-unavailable");
      if (info.relayer !== flow.relayer) {
        await core.enter(flow, "checking");
        return;
      }
      const config = await fetchPoolConfigV2(chain.connection);
      const { blockhash } = await chain.connection.getLatestBlockhash("confirmed");
      const transaction = buildMoveTransaction({
        withdrawal: fromRelayRequest(flow.request),
        deposit: decodeTransactArgsV2(fromBase64(flow.moveDeposit)),
        relayer: new PublicKey(flow.relayer),
        wallet,
        screener: config.screener,
        terms: moveTermsOf(info.move),
        recentBlockhash: blockhash,
      });
      await simulateMove(core, runtime, flow, transaction);
      flow.moveUnsigned = toBase64(transaction.serialize());
      delete flow.moveWalletSigned;
      delete flow.moveSigned;
      const cluster = await readCluster(chain.connection);
      await core.saveFlow(flow);
      await ask(core, flow, { kind: "signTransaction", wallet: flow.walletName, address: flow.address, transaction: flow.moveUnsigned, chain: chainOf(cluster.cluster) });
      return;
    }
    case "cosigning": {
      if (!flow.moveWalletSigned) {
        await core.enter(flow, "signing");
        return;
      }
      const transaction = deserializeTransaction(fromBase64(flow.moveWalletSigned));
      try {
        applyScreenerSignature(transaction, await core.env.screener(settings, chain).screen(toScreenRequest(transaction)));
      } catch (error) {
        throw screeningFailure(settings.screenerUrl, error);
      }
      flow.moveSigned = toBase64(transaction.serialize());
      delete flow.moveWalletSigned;
      await core.enter(flow, "sending");
      return;
    }
    case "sending": {
      if (!flow.moveSigned || !flow.inputs) throw fail("internal");
      if (!runtime.pending.some((entry) => entry.flowId === flow.id)) await reserve(core, runtime, flow);
      // Written down before the move leaves: from here on the relayer has it, whatever it says.
      if (!flow.handed) {
        flow.handed = true;
        await core.saveFlow(flow);
      }
      let response;
      try {
        response = await relayer.move({ transaction: flow.moveSigned });
      } catch (error) {
        // A new attempt needs a new blockhash, and with it the wallet's signature again.
        delete flow.moveSigned;
        await relayFailed(core, chain, runtime, flow, error);
        return;
      }
      flow.signature = response.signature;
      await core.enter(flow, "confirming");
      return;
    }
    default:
      throw fail("internal");
  }
}

/** A move that would fail is stopped before the wallet is asked. */
async function simulateMove(core: Core, runtime: WalletRuntime, flow: SpendRecord, transaction: ReturnType<typeof buildMoveTransaction>): Promise<void> {
  const { chain } = await core.chain();
  let result;
  try {
    // web3.js sends whatever `serialize()` returns, so a TransactionV1 goes through as v1.
    result = await chain.connection.simulateTransaction(transaction as unknown as VersionedTransaction, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
  } catch {
    return;
  }
  const { err, logs } = result.value;
  if (!err) return;
  const program = parseProgramError({ err, logs: logs ?? [] });
  if (program?.kind === "UnknownRoot") {
    // A root one of the proofs names is gone: prove both again on the next try, with the same notes.
    await letGo(core, runtime, flow, "keep");
    forgetMove(flow);
  }
  if (program) throw programFailure(program.kind);
  if (err === "BlockhashNotFound") throw fail("expired", { retry: true });
  // The fee payer is the relayer: a balance it lacks is the relayer's, not this wallet's.
  if (err === "AccountNotFound" || err === "InsufficientFundsForFee") throw fail("relayer-unavailable", { retry: true, detail: "the relayer cannot pay for the move now" });
  throw fail("transaction-failed", { detail: JSON.stringify(err).slice(0, 140) });
}

/** The wallet answered the move it was shown. */
export async function moveAnswer(core: Core, flow: SpendRecord, answer: BridgeAnswer): Promise<void> {
  // A move holds two proofs and fits a version-1 transaction only.
  if (!answer.ok && answer.error.code === "unsupported-version") throw fail("move-wallet");
  if (!answer.ok) throw walletFailure(answer);
  if (answer.value.kind !== "signTransaction" || !flow.moveUnsigned) throw fail("wallet-failed", { retry: true });
  const wallet = new PublicKey(flow.address);
  let ours;
  let theirs;
  try {
    ours = deserializeTransaction(fromBase64(flow.moveUnsigned));
    theirs = deserializeTransaction(fromBase64(answer.value.signedTransaction));
  } catch {
    throw fail("wallet-changed-transaction", { retry: true });
  }
  // The wallet's own signature, over what it returned (Phantom may have added its assertions).
  let valid = false;
  try {
    const index = theirs.message.staticAccountKeys.findIndex((key) => key.equals(wallet));
    valid = index === 1 && ed25519.verify(theirs.signatures[1]!, theirs.message.serialize(), wallet.toBytes());
  } catch {
    valid = false;
  }
  if (!valid) throw fail("wallet-changed-transaction", { retry: true });
  // Still the same move: the same proofs, refund, fee payer and blockhash. The screening service
  // and the relayer check all of it again.
  const screener = ours.message.staticAccountKeys[2]!;
  const before = inspectMoveTransaction(ours, { screener });
  const after = inspectMoveTransaction(theirs, { screener, relayer: ours.message.staticAccountKeys[0]! });
  const same =
    before.ok &&
    after.ok &&
    theirs.message.recentBlockhash === ours.message.recentBlockhash &&
    after.value.refundLamports === before.value.refundLamports &&
    bytesEqual(encodeTransactArgs(after.value.withdrawal), encodeTransactArgs(before.value.withdrawal)) &&
    bytesEqual(encodeTransactArgsV2(after.value.deposit), encodeTransactArgsV2(before.value.deposit));
  // The wallet may also have raised the compute-unit limit or set a priority fee: the relayer pays
  // for it and says whether it takes it.
  if (!same) throw fail("wallet-changed-transaction", { retry: true, detail: after.ok ? "the wallet changed the move" : after.error.message });
  flow.moveWalletSigned = toBase64(theirs.serialize());
  await closeBridgeTab(core);
  await core.enter(flow, "cosigning");
}
