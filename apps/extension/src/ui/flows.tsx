// The sheets: the three forms (dive in, send privately, surface), the flow in progress, the
// flow that failed, and the wallet menu. A sheet rises from the bed of the popup; the caution
// band stays above its scrim.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { amountProblemText, displaySol, exactSol, inputSol, parseAmountInput } from "../shared/amounts.js";
import { mainnetTestingEnabled } from "../shared/build.js";
import { DEPOSIT_OVERHEAD, SYSTEM_RENT_MINIMUM } from "../shared/constants.js";
import { ACTION_NAME, ACTION_RUNNING, DEPTH_COPY, DOCS_ANCHOR, EARLIER_COPY, FORM_COPY, OBSERVER, SETTINGS_COPY, SWAP_COPY, assetText, busyLabel, failureCopy, shortAddress, whenText } from "../shared/copy.js";
import { NATIVE_MINT, assetMeta, formatUnits, isNative, parseUnits } from "../shared/assets.js";
import type { AddressCheck, FlowView, PublicBalanceReply, Quote, Snapshot, SurfaceWarningView } from "../shared/view.js";
import type { Api, Draft } from "./api.js";
import type { View } from "./App.js";
import { Amount, AmountField, AssetAmount, AssetPicker, FailureBlock, Field, HowItWorks, Icon, Observer, Progress, Rich, Sheet } from "./parts.js";
import { pub, shd } from "../shared/copy.js";

/** The three forms, and "move": the earlier pool's balance surfaced to this wallet. */
export type FormKind = "dive" | "send" | "surface" | "move";

// ------------------------------------------------------------------ in progress

function FlowRows({ flow, snapshot }: { flow: FlowView; snapshot: Snapshot }) {
  if (flow.kind === "unlock" || (flow.kind === "consolidate" && flow.pool !== 2)) {
    if (flow.kind === "consolidate" && flow.fee) {
      return (
        <dl class="deflist deflist--kv">
          <div class="deflist__row">
            <dt>Relayer fee</dt>
            <dd>
              <Amount lamports={BigInt(flow.fee)} exact /> SOL
            </dd>
          </div>
        </dl>
      );
    }
    return null;
  }
  const amount = BigInt(flow.amount ?? "0");
  if (flow.pool === 2) {
    // v2: every figure in the flow's asset (the deposit's network fee stays in SOL).
    const fee = BigInt(flow.fee ?? "0");
    return (
      <dl class="deflist deflist--kv">
        {flow.kind === "dive" ? (
          <div class="deflist__row">
            <dt>From</dt>
            <dd>
              <span class="fig is-public">{shortAddress(snapshot.active ?? "")}</span>
            </dd>
          </div>
        ) : flow.kind === "swap" ? (
          <div class="deflist__row">
            <dt>{SWAP_COPY.minimum}</dt>
            <dd class="fig is-shielded">{assetText(BigInt(flow.minOut ?? "0"), flow.toMint, true)}</dd>
          </div>
        ) : flow.kind === "consolidate" ? null : (
          <div class="deflist__row">
            <dt>To</dt>
            <dd>
              <span class={`fig ${flow.kind === "send" ? "is-shielded" : "is-public"}`} title={flow.to}>
                {shortAddress(flow.to ?? "")}
              </span>
            </dd>
          </div>
        )}
        {flow.kind !== "consolidate" && (
          <div class="deflist__row">
            <dt>Amount</dt>
            <dd class={`fig ${flow.kind === "send" || flow.kind === "swap" ? "is-shielded" : "is-public"}`}>{assetText(amount, flow.mint, true)}</dd>
          </div>
        )}
        <div class="deflist__row">
          <dt>{flow.kind === "dive" ? "Network fee and rent" : "Relayer fee"}</dt>
          <dd class="fig is-public">{flow.kind === "dive" ? `${exactSol(BigInt(flow.overhead ?? DEPOSIT_OVERHEAD))} SOL` : assetText(fee, flow.mint, true)}</dd>
        </div>
      </dl>
    );
  }
  if (flow.kind === "claim") {
    const fee = BigInt(flow.fee ?? "0");
    return (
      <dl class="deflist deflist--kv">
        <div class="deflist__row">
          <dt>In the link</dt>
          <dd>
            <Amount lamports={amount} shielded exact /> SOL
          </dd>
        </div>
        <div class="deflist__row">
          <dt>Relayer fee</dt>
          <dd>
            <Amount lamports={fee} exact /> SOL
          </dd>
        </div>
        <div class="deflist__row">
          <dt>Arrives in your shielded balance</dt>
          <dd>
            <Amount lamports={amount > fee ? amount - fee : 0n} shielded exact /> SOL
          </dd>
        </div>
      </dl>
    );
  }
  return (
    <dl class="deflist deflist--kv">
      {flow.kind === "dive" ? (
        <div class="deflist__row">
          <dt>From</dt>
          <dd>
            <span class="fig is-public">{shortAddress(snapshot.active ?? "")}</span>
          </dd>
        </div>
      ) : (
        <div class="deflist__row">
          <dt>To</dt>
          <dd>
            {flow.claim ? (
              <span class="is-shielded">A claim link</span>
            ) : (
              <span class={`fig ${flow.kind === "send" ? "is-shielded" : "is-public"}`} title={flow.to}>
                {shortAddress(flow.to ?? "")}
              </span>
            )}
          </dd>
        </div>
      )}
      <div class="deflist__row">
        <dt>Amount</dt>
        <dd>
          <Amount lamports={amount} shielded={flow.kind === "send"} exact /> SOL
        </dd>
      </div>
      {flow.kind === "dive" ? (
        <div class="deflist__row">
          <dt>Network fee and rent</dt>
          <dd>
            <Amount lamports={BigInt(flow.overhead ?? DEPOSIT_OVERHEAD)} exact /> SOL
          </dd>
        </div>
      ) : (
        <div class="deflist__row">
          <dt>Relayer fee</dt>
          <dd>
            <Amount lamports={BigInt(flow.fee ?? "0")} exact /> SOL
          </dd>
        </div>
      )}
    </dl>
  );
}

/** The connect page as a person compares it with what their wallet shows: host and path, no scheme. */
export function connectPlace(url: string | undefined): string {
  if (!url) return "the connect page";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "the connect page";
  }
}

function UnlockBody({ flow, api }: { flow: FlowView; api: Api }) {
  const choosing = flow.step === "choosing";
  const wallets = flow.wallets ?? [];
  return (
    <>
      <div class="notice">
        <p class="notice__title">One signature unlocks your shielded balance</p>
        <p>
          Your wallet will show the message &ldquo;Loch key derivation v1&rdquo;. Signing it derives the keys of your shielded balance on this device. It moves nothing and costs nothing.
        </p>
        {flow.firstTime && <p>The first time, your wallet asks twice, so Loch can check that it signs the same way every time.</p>}
      </div>
      <p class="notice notice--inline notice--caution">
        <Icon name="caution" />
        <span>Never sign this message for a website. Whoever has the signature has your shielded funds. Loch asks only on its own connect page, after you press Connect or Unlock here.</span>
      </p>
      <dl class="deflist deflist--kv">
        <div class="deflist__row">
          <dt>Your wallet is asked on</dt>
          <dd class="connect-place" title={flow.connectUrl}>
            {connectPlace(flow.connectUrl)}
          </dd>
        </div>
      </dl>
      {choosing && (
        <div class="stack--tight">
          <p class="t-label" id="choose-label">
            Wallets found on the connect page
          </p>
          <ul class="picklist" aria-labelledby="choose-label">
            {wallets.map((wallet, index) => (
              <li key={wallet.name}>
                <button class="picklist__row" type="button" data-autofocus={index === 0 ? "" : undefined} onClick={() => void api.call({ loch: "ui", type: "choose-wallet", wallet: wallet.name })}>
                  <Icon name="wallet" />
                  <span class="picklist__name">{wallet.name}</span>
                  <span class="picklist__go">Connect</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function FlowSheet({
  snapshot,
  flow,
  api,
  toast,
  openForm,
  openSettings,
}: {
  snapshot: Snapshot;
  flow: FlowView;
  api: Api;
  toast: (text: string, kind?: "done" | "caution" | "plain") => void;
  openForm: (kind: FormKind) => void;
  openSettings: () => void;
}) {
  const dismiss = () => void api.call({ loch: "ui", type: "flow-dismiss" });
  const cancel = () => void api.call({ loch: "ui", type: "flow-cancel" });
  const retry = () => void api.call({ loch: "ui", type: "flow-retry" });
  const label = flow.move ? "Moving to the new pool" : ACTION_RUNNING[flow.kind];
  const isForm = flow.kind === "dive" || flow.kind === "send" || flow.kind === "surface";

  if (flow.status === "failed" && flow.failure) {
    const failure = flow.failure;
    // A v2 flow's balance is the asset's in the v2 pool; its figures are in that asset.
    const v2Balance = flow.pool === 2 ? snapshot.loch2?.assets.find((asset) => asset.mint === (flow.mint ?? NATIVE_MINT))?.balance : undefined;
    const context = {
      kind: flow.kind,
      ...(flow.pool === 2 && flow.mint ? { mint: flow.mint } : {}),
      shielded: flow.pool === 2 ? v2Balance : snapshot.shielded?.balance,
      walletName: flow.walletName,
      address: snapshot.active ?? undefined,
      connectUrl: flow.connectUrl ?? snapshot.settings.connectUrl,
      proofKept: flow.proofKept,
    };
    const copy = failureCopy(failure, context);
    const back = () => {
      dismiss();
      if (isForm) openForm(flow.move ? "move" : (flow.kind as FormKind));
    };
    let primary: ComponentChildren;
    if (failure.code === "consolidation-needed") {
      primary = (
        <button
          class="btn btn--primary"
          type="button"
          data-autofocus=""
          onClick={() => {
            void api.call({ loch: "ui", type: "flow-dismiss" }).then(() => api.call({ loch: "ui", type: "consolidate", fee: flow.fee ?? "0" }));
          }}
        >
          Combine notes
        </button>
      );
    } else if (failure.code === "price-moved" && flow.kind === "swap") {
      primary = <NewPrice flow={flow} api={api} />;
    } else if (failure.code === "fee-changed" && failure.amount !== undefined && BigInt(failure.amount) <= BigInt(snapshot.settings.maxFeeLamports)) {
      // The flow goes on in place with the fee the user now agrees to. A spend whose earlier
      // attempt is still with a relayer keeps its notes that way; starting over would not.
      const fee = failure.amount;
      primary = (
        <button class="btn btn--primary" type="button" data-autofocus="" onClick={() => void api.call({ loch: "ui", type: "flow-retry", fee })}>
          Agree and try again
        </button>
      );
    } else if (failure.retry) {
      primary = (
        <button class="btn btn--primary" type="button" data-autofocus="" onClick={retry}>
          Try again
        </button>
      );
    } else if (isForm && ["fee-changed", "above-max", "insufficient-public", "insufficient-shielded", "below-minimum"].includes(failure.code)) {
      primary = (
        <button class="btn btn--primary" type="button" data-autofocus="" onClick={back}>
          {failure.code === "fee-changed" ? "See the new fee" : "Change the amount"}
        </button>
      );
    } else {
      primary = (
        <button class="btn btn--primary" type="button" data-autofocus="" onClick={dismiss}>
          Close
        </button>
      );
    }
    const secondary = copy.forget ? (
      <button
        class="btn btn--secondary"
        type="button"
        onClick={() => {
          if (!snapshot.active) return;
          void api.call({ loch: "ui", type: "forget", address: snapshot.active }).then(() => toast("Forgotten on this device. Nothing on chain changed."));
        }}
      >
        Forget this wallet
      </button>
    ) : copy.settings ? (
      <button
        class="btn btn--secondary"
        type="button"
        onClick={() => {
          openSettings();
        }}
      >
        Settings
      </button>
    ) : failure.retry || failure.code === "consolidation-needed" || failure.code === "fee-changed" || failure.code === "price-moved" ? (
      <button class="btn btn--secondary" type="button" onClick={dismiss}>
        Close
      </button>
    ) : null;

    return (
      <Sheet
        title={flow.move ? EARLIER_COPY.title : ACTION_NAME[flow.kind]}
        id={`flow-${flow.id}-failed`}
        alert
        onClose={dismiss}
        foot={
          <>
            {secondary}
            {primary}
          </>
        }
      >
        {failure.code !== "cancelled" && failure.code !== "consolidation-needed" && <Progress flow={flow} now={api.now} label={label} />}
        <FailureBlock failure={failure} context={context} />
      </Sheet>
    );
  }

  const waitingForChoice = flow.kind === "unlock" && flow.step === "choosing";
  return (
    <Sheet
      title={flow.kind === "unlock" ? (flow.firstTime ? "Connect wallet" : "Unlock") : label}
      id={`flow-${flow.id}`}
      foot={
        <>
          <button class="btn btn--secondary" type="button" onClick={cancel} disabled={!flow.cancellable} title={flow.cancellable ? undefined : "It is on its way and cannot be stopped now."}>
            Cancel
          </button>
          {!waitingForChoice && (
            <button class="btn btn--primary" type="button" aria-busy="true">
              {flow.status === "waiting" ? "Waiting for wallet" : busyLabel(flow.kind, flow.firstTime)}
            </button>
          )}
        </>
      }
    >
      {flow.kind === "unlock" ? <UnlockBody flow={flow} api={api} /> : <FlowRows flow={flow} snapshot={snapshot} />}
      {!waitingForChoice && <Progress flow={flow} now={api.now} label={label} />}
      {flow.kind !== "unlock" && <Observer>{flow.move ? EARLIER_COPY.observer : OBSERVER[flow.kind]}</Observer>}
    </Sheet>
  );
}

// ------------------------------------------------------------------------ forms

const ADDRESS_PROBLEM: Record<Exclude<AddressCheck, { ok: true }>["reason"], string> = {
  empty: "Enter an address.",
  encoding: "This is not a shielded address or a payment code. An address starts with loch1, a code with lochpay1.",
  prefix: "This is not a Loch address. A shielded address starts with loch1, a payment code with lochpay1.",
  checksum: "There is an error in it: its checksum does not match. Copy it again.",
  length: "It is not complete, or it is cut short. Copy the whole address or code again.",
  unusable: "This address cannot receive. Ask the recipient to copy it again from their Loch.",
  "public-address": "That is a public Solana address. Sending privately needs a shielded address, which starts with loch1. To pay a public address, use Surface.",
  "shielded-address": "That is a shielded address or a payment code. Surfacing pays a public Solana address. To pay a shielded address, use Send privately.",
  "not-an-address": "That is not a Solana address. One is 32 to 44 letters and digits.",
};

export function useQuote(api: Api, want: "dive" | "spend"): { quote: Quote | null; error: string | null; reload: () => void } {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    void api.call<Quote>({ loch: "ui", type: "quote", want }).then((reply) => {
      if (!live) return;
      if (reply.ok) setQuote(reply.value);
      else setError(reply.error.code);
    });
    return () => {
      live = false;
    };
  }, [api, want, round]);
  return { quote, error, reload: () => setRound((value) => value + 1) };
}

function useAddressCheck(api: Api, kind: "shielded" | "public", text: string): AddressCheck | null {
  const [check, setCheck] = useState<AddressCheck | null>(null);
  useEffect(() => {
    if (text.trim() === "") {
      setCheck(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api.call<AddressCheck>({ loch: "ui", type: "check-address", kind, text }).then((reply) => {
        if (live && reply.ok) setCheck(reply.value);
      });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, kind, text]);
  return check;
}

/** What the send form says under a recipient it accepts: only that it is the wallet's own. */
function recipientHint(address: Extract<AddressCheck, { ok: true }>): string | undefined {
  if (address.own) return address.code ? FORM_COPY.ownCode : FORM_COPY.ownAddress;
  return undefined;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));

function QuoteNotice({ title, children, onRetry, openSettings }: { title: string; children: ComponentChildren; onRetry: () => void; openSettings: () => void }) {
  return (
    <div class="notice notice--caution" role="alert">
      <p class="notice__title">
        <Icon name="caution" />
        {title}
      </p>
      <p>{children}</p>
      <div class="notice__actions">
        <button class="btn btn--secondary btn--sm" type="button" onClick={onRetry}>
          Ask again
        </button>
        <button class="btn btn--quiet btn--sm" type="button" onClick={openSettings}>
          Settings
        </button>
      </div>
    </div>
  );
}

const SURFACE_WARNING: Record<SurfaceWarningView["id"], (warning: SurfaceWarningView, now: number) => string> = {
  "same-address": (warning) => (warning.amount ? "It goes to the address you dived in from." : "It goes to an address that is connected to Loch on this device."),
  "same-amount": (warning, now) => `It is the same amount as your dive-in ${warning.at ? whenText(warning.at, now) : "recently"}.`,
  "soon-after": (warning, now) => `It comes soon after it: you dived in ${warning.at ? whenText(warning.at, now) : "a short while ago"}.`,
  shown: () => DEPTH_COPY.shownWarning,
};

/** One asset a form can be about: its symbol, precision, and what the wallet holds of it. */
interface FormAsset {
  mint: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  spendable: bigint;
  largestPair: bigint;
  /** A deposit's limit in this asset, when the pool says. */
  maxDeposit: bigint | null;
}

/** Parses what was typed as an amount of `asset`: SOL by the design system's rule, a token in its own precision. */
function parseAssetAmount(text: string, asset: FormAsset): { ok: true; units: bigint } | { ok: false; problem: string } {
  if (isNative(asset.mint)) {
    const parsed = parseAmountInput(text);
    return parsed.ok ? { ok: true, units: parsed.lamports } : { ok: false, problem: amountProblemText(parsed.problem) };
  }
  if (text.trim() === "") return { ok: false, problem: "Enter an amount." };
  const units = parseUnits(text, asset.decimals);
  if (units === null) return { ok: false, problem: `Write the amount with digits and a point, with at most ${asset.decimals} decimals.` };
  if (units === 0n) return { ok: false, problem: "The amount must be more than zero." };
  return { ok: true, units };
}

/** The text to put into an amount field for exactly `units` of `asset`. */
function inputUnits(units: bigint, asset: FormAsset): string {
  return isNative(asset.mint) ? inputSol(units) : formatUnits(units, asset.decimals).replace(/,/g, "");
}

export function FormSheet({ kind: formKind, snapshot, api, onClose, openSettings }: { kind: FormKind; snapshot: Snapshot; api: Api; onClose: () => void; openSettings: () => void }) {
  // "move" is a surface from the earlier pool to this wallet's own public address.
  const moving = formKind === "move";
  const kind = moving ? "surface" : formKind;
  const [to, setTo] = useState(moving ? (snapshot.active ?? "") : "");
  /** Send: pay a claim link in place of an address, for someone who has no Loch yet. Earlier pool only. */
  const [asLink, setAsLink] = useState(false);
  const linked = kind === "send" && asLink;
  const [mint, setMint] = useState(NATIVE_MINT);
  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<SurfaceWarningView[]>([]);
  const restored = useRef(false);
  const { quote, error: quoteError, reload } = useQuote(api, kind === "dive" ? "dive" : "spend");
  const address = useAddressCheck(api, kind === "send" ? "shielded" : "public", kind === "dive" || linked ? "" : to);
  const shielded = snapshot.shielded;
  const loch2 = snapshot.loch2;
  const now = api.now();

  // Which pool: v2 when the cluster has it, except to move the earlier pool's balance, a claim
  // link, or a send to an address of the earlier pool.
  const pool: 1 | 2 = !loch2 || moving || linked || (kind === "send" && address?.ok === true && !address.v2) ? 1 : 2;

  // The assets the form offers: in v2 those the pool has registered (a deposit) or the wallet holds (a spend).
  const assets: FormAsset[] = (() => {
    if (pool === 1) return [{ mint: NATIVE_MINT, symbol: "SOL", decimals: 9, balance: BigInt(shielded?.balance ?? "0"), spendable: BigInt(shielded?.spendable ?? "0"), largestPair: BigInt(shielded?.largestPair ?? "0"), maxDeposit: quote?.pool ? BigInt(quote.pool.maxDeposit) : null }];
    const held = loch2?.assets ?? [];
    const registered = quote?.v2?.assets ?? [];
    const list = (kind === "dive" ? registered.filter((asset) => asset.depositsEnabled).map((asset) => asset.mint) : held.filter((asset) => BigInt(asset.balance) > 0n || isNative(asset.mint)).map((asset) => asset.mint)).filter((item, index, all) => all.indexOf(item) === index);
    return list.map((item) => {
      const view = held.find((asset) => asset.mint === item);
      const reg = registered.find((asset) => asset.mint === item);
      return {
        mint: item,
        symbol: view?.symbol ?? reg?.symbol ?? "SOL",
        decimals: reg?.decimals ?? view?.decimals ?? 9,
        balance: BigInt(view?.balance ?? "0"),
        spendable: BigInt(view?.spendable ?? "0"),
        largestPair: BigInt(view?.largestPair ?? "0"),
        maxDeposit: reg ? BigInt(reg.maxDeposit) : null,
      };
    });
  })();
  const asset = assets.find((item) => item.mint === mint) ?? assets[0] ?? { mint: NATIVE_MINT, symbol: "SOL", decimals: 9, balance: 0n, spendable: 0n, largestPair: 0n, maxDeposit: null };
  const native = isNative(asset.mint);
  const show = (units: bigint, options: { shielded?: boolean; exact?: boolean } = {}) => <AssetAmount units={units} mint={asset.mint} decimals={asset.decimals} symbol={asset.symbol} {...options} />;

  // Opening the dive-in form reads the public balance at once: a deposit is made from it.
  useEffect(() => {
    if (kind === "dive") void api.call<PublicBalanceReply>({ loch: "ui", type: "public-balance" });
  }, [api, kind]);

  // What was typed survives the popup closing.
  useEffect(() => {
    void api.draft().then((draft) => {
      if (draft && draft.kind === formKind) {
        if (!moving) setTo(draft.to);
        setAmountText(draft.amount);
      }
      restored.current = true;
    });
  }, [api, formKind]);
  useEffect(() => {
    if (!restored.current) return;
    const draft: Draft = { kind: formKind, to, amount: amountText };
    void api.setDraft(draft);
  }, [api, formKind, to, amountText]);

  const parsed = parseAssetAmount(amountText, asset);
  const amount = parsed.ok ? parsed.units : null;
  const publicBalance = snapshot.publicBalance === null ? null : BigInt(snapshot.publicBalance);
  // What a deposit costs beyond its amount, at the cluster's rent; the earlier, higher figures until it is known.
  const overhead = quote?.deposit ? BigInt(quote.deposit.overhead) : DEPOSIT_OVERHEAD;
  const accountMinimum = quote?.deposit ? BigInt(quote.deposit.minimum) : SYSTEM_RENT_MINIMUM;
  const feeText = pool === 2 ? quote?.v2?.relayer?.fees[asset.mint] : quote?.relayer?.fee;
  // A token surfaced to a wallet with no account for it costs that account's rent on top. The fee
  // agreed to covers it; the relayer is paid it only when it creates the account.
  const accountFee = pool === 2 && kind === "surface" && !native ? BigInt(quote?.v2?.relayer?.accountFees[asset.mint] ?? "0") : 0n;
  const fee = feeText !== undefined ? BigInt(feeText) + accountFee : null;
  const feeLimit = native ? BigInt(snapshot.settings.maxFeeLamports) : BigInt(assetMeta(snapshot.cluster, asset.mint).maxFee);
  const relayerKnown = pool === 2 ? Boolean(quote?.v2?.relayer) : Boolean(quote?.relayer);
  const relayerError = pool === 2 ? quote?.v2?.relayerError : quote?.relayerError;
  const spendable = asset.spendable;
  const largestPair = asset.largestPair;

  // ------------------------------------------------------------------ limits
  let ceiling: bigint | null = null;
  let amountError: string | null = null;
  let blocked: ComponentChildren = null;
  let needsConsolidation = false;

  if (kind === "dive") {
    const poolMax = asset.maxDeposit;
    // The screening service's cap and the public budget are in lamports: they bound SOL only.
    const screenerMax = native && quote?.screener ? BigInt(quote.screener.maxDeposit) : null;
    const budget = !native || publicBalance === null ? null : max(0n, publicBalance - overhead - accountMinimum);
    const limits = [poolMax, screenerMax, budget].filter((value): value is bigint => value !== null);
    ceiling = limits.length > 0 ? min(...limits) : null;
    if (amount !== null) {
      if (poolMax !== null && amount > poolMax) amountError = `The pool takes at most ${pub(assetText(poolMax, asset.mint, true))} in one deposit.`;
      else if (screenerMax !== null && amount > screenerMax) amountError = `The screening service signs at most ${pub(exactSol(screenerMax))} SOL in one deposit.`;
      else if (budget !== null && amount > budget) {
        amountError =
          budget === 0n
            ? `Your public balance does not cover the network fee and rent of a deposit. Add ${mainnetTestingEnabled() ? "SOL" : "test SOL"} to the wallet.`
            : `Your public balance covers at most ${pub(exactSol(budget))} SOL, after the network fee and rent and what must stay in the wallet.`;
      }
    }
    const paused = pool === 2 ? quote?.v2?.paused : quote?.pool?.paused;
    if (paused) {
      blocked = (
        <div class="notice notice--caution" role="alert">
          <p class="notice__title">
            <Icon name="caution" />
            Deposits are paused
          </p>
          <p>The pool&rsquo;s operator has paused diving in. Sending privately and surfacing still work.</p>
        </div>
      );
    } else if (quote && (pool === 2 ? assets.length === 0 : !quote.pool)) {
      blocked = (
        <QuoteNotice title="The Loch was not found on this network" onRetry={reload} openSettings={openSettings}>
          The RPC endpoint knows no Loch pool. Check the pool's RPC endpoint in settings.
        </QuoteNotice>
      );
    } else if (quote && !quote.screener) {
      blocked = (
        <QuoteNotice title="The screening service did not answer" onRetry={reload} openSettings={openSettings}>
          A deposit needs its signature. Nothing can be sent until it answers.
        </QuoteNotice>
      );
    }
  } else {
    if (quote && !relayerKnown) {
      blocked = (
        <QuoteNotice title={relayerError === "mismatch" ? "The relayer serves another network" : "The relayer did not answer"} onRetry={reload} openSettings={openSettings}>
          {relayerError === "mismatch"
            ? "It works for a different pool or cluster than the RPC endpoint. Check the relayer in settings."
            : "Its fee is not known, so nothing can be proven yet. Try again, or choose another relayer in settings."}
        </QuoteNotice>
      );
    } else if (quote && pool === 2 && fee === null) {
      blocked = (
        <QuoteNotice title="The relayer does not take this asset" onRetry={reload} openSettings={openSettings}>
          It is paid in the asset it moves, and it takes no {asset.symbol}. Choose another asset, or another relayer in settings.
        </QuoteNotice>
      );
    } else if (fee !== null && fee > feeLimit) {
      blocked = (
        <QuoteNotice title="The relayer&rsquo;s fee is above your limit" onRetry={reload} openSettings={openSettings}>
          It asks {assetText(fee, asset.mint, true)}. Your limit is {assetText(feeLimit, asset.mint, true)}. Choose another relayer{native ? ", or raise the limit in settings" : ""}.
        </QuoteNotice>
      );
    }
    if (fee !== null) {
      // A claim link carries a second fee: the one its recipient pays to collect it.
      const fees = linked ? 2n * fee : fee;
      // The most one transaction can move: the two largest notes, less the fee.
      ceiling = max(0n, largestPair - fees);
      const minimum = kind === "surface" && native ? max(SYSTEM_RENT_MINIMUM, BigInt((pool === 2 ? quote?.v2?.relayer?.minWithdrawal : quote?.relayer?.minWithdrawal) ?? "0")) : 0n;
      if (amount !== null) {
        if (amount + fees > spendable) {
          amountError =
            spendable <= fees
              ? linked
                ? "Your shielded balance does not cover the two relayer fees of a claim link."
                : "Your shielded balance does not cover the relayer’s fee."
              : `You can ${kind === "send" ? "send" : "surface"} at most ${assetText(spendable - fees, asset.mint, true)}: what can be spent now, less the relayer’s ${linked ? "fees" : "fee"}.`;
        } else if (kind === "surface" && amount < minimum) {
          amountError = `Surface at least ${pub(exactSol(minimum))} SOL. A new address must hold ${pub(exactSol(SYSTEM_RENT_MINIMUM))} SOL to exist.`;
        } else if (amount + fees > largestPair) {
          needsConsolidation = true;
        }
      }
    }
  }
  if (quoteError === "failed" || (quoteError && !quote)) {
    blocked = (
      <QuoteNotice title="The RPC endpoint did not answer" onRetry={reload} openSettings={openSettings}>
        Loch could not read the network&rsquo;s state. Check your connection, or choose another endpoint in settings.
      </QuoteNotice>
    );
  }

  const formatError = touched && !parsed.ok ? parsed.problem : null;
  const addressError = kind === "dive" || linked ? null : touched && to.trim() === "" ? ADDRESS_PROBLEM.empty : address && !address.ok ? ADDRESS_PROBLEM[address.reason] : null;
  const addressOk = kind === "dive" || linked || (address?.ok ?? false);
  const ready = quote !== null && blocked === null && amount !== null && amountError === null && addressOk && !needsConsolidation && !submitting;

  // Surfacing: what would tie this withdrawal to a deposit.
  const destination = address?.ok ? address.address : null;
  useEffect(() => {
    if (kind !== "surface" || destination === null || amount === null || fee === null) {
      setWarnings([]);
      return;
    }
    let live = true;
    void api.call<SurfaceWarningView[]>({ loch: "ui", type: "surface-warnings", to: destination, amount: amount.toString(), fee: fee.toString() }).then((reply) => {
      if (live && reply.ok) setWarnings(reply.value);
    });
    return () => {
      live = false;
    };
  }, [api, kind, destination, amount?.toString(), fee?.toString()]);

  const v2Fields = pool === 2 ? { mint: asset.mint, pool: 2 as const } : { pool: 1 as const };
  const submit = async () => {
    setTouched(true);
    if (!ready || amount === null) return;
    setSubmitting(true);
    setSubmitError(null);
    const reply =
      kind === "dive"
        ? await api.call({ loch: "ui", type: "dive", amount: amount.toString(), ...(pool === 2 ? { mint: asset.mint } : {}) })
        : linked
          ? await api.call({ loch: "ui", type: "send-claim", amount: amount.toString(), fee: (fee ?? 0n).toString() })
          : kind === "send"
            ? await api.call({ loch: "ui", type: "send", to: destination ?? "", amount: amount.toString(), fee: (fee ?? 0n).toString(), ...v2Fields })
            : await api.call({ loch: "ui", type: "surface", to: destination ?? "", amount: amount.toString(), fee: (fee ?? 0n).toString(), ...v2Fields });
    setSubmitting(false);
    if (!reply.ok) setSubmitError("Loch could not start this. Close the sheet and try again. Nothing was sent.");
  };

  const consolidate = async () => {
    if (fee === null) return;
    setSubmitting(true);
    const reply = await api.call({ loch: "ui", type: "consolidate", fee: fee.toString(), ...v2Fields });
    setSubmitting(false);
    if (!reply.ok) setSubmitError("Loch could not start this. Close the sheet and try again. Nothing was sent.");
  };

  const total = amount !== null && fee !== null ? amount + (linked ? 2n * fee : fee) : null;
  // An earlier payment to the same address whose outcome is not known: its request is with a
  // relayer and may still land. A new one is a second payment, made from other notes. A payment
  // code is known to the activity list by the address inside it.
  const payee = !linked && address?.ok ? (address.payee ?? address.address) : null;
  const earlier = kind === "dive" || payee === null ? undefined : snapshot.activity.find((entry) => entry.kind === kind && entry.counterparty === payee && (entry.status === "unknown" || entry.status === "submitted"));
  const title = moving ? EARLIER_COPY.title : ACTION_NAME[kind];
  const primaryLabel = needsConsolidation ? "Combine notes" : moving ? EARLIER_COPY.title : kind === "surface" && (warnings.length > 0 || earlier) ? "Surface anyway" : kind === "send" && earlier ? "Send anyway" : linked ? "Pay and make the link" : ACTION_NAME[kind];
  const pickable = pool === 2 && !moving ? assets : [];

  return (
    <Sheet
      title={title}
      id={`form-${formKind}`}
      onClose={onClose}
      foot={
        <>
          <button class="btn btn--secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            class="btn btn--primary"
            type="submit"
            form={`form-${formKind}-form`}
            aria-busy={submitting || quote === null ? "true" : undefined}
            aria-disabled={needsConsolidation ? (fee === null || submitting ? "true" : undefined) : ready ? undefined : "true"}
          >
            {primaryLabel}
          </button>
        </>
      }
    >
      <form
        id={`form-${formKind}-form`}
        class="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (needsConsolidation) void consolidate();
          else void submit();
        }}
      >
        {moving && <p class="t-small">{EARLIER_COPY.line}</p>}
        {linked && (
          <div class="field">
            <p class="t-small">{FORM_COPY.linkLine}</p>
            <button class="link link--quiet form__switch" type="button" onClick={() => setAsLink(false)}>
              {FORM_COPY.asAddress}
            </button>
          </div>
        )}
        <AssetPicker
          assets={pickable}
          value={asset.mint}
          onChange={(next) => {
            setMint(next);
            setAmountText("");
          }}
        />
        {kind !== "dive" && !linked && !moving && (
          <Field label={kind === "send" ? FORM_COPY.toSend : FORM_COPY.toSurface} id={`${kind}-to`} error={addressError} hint={kind === "send" && address?.ok ? recipientHint(address) : undefined}>
            <div class="input-group input-group--address">
              <textarea
                class="input"
                id={`${kind}-to`}
                rows={kind === "send" ? 4 : 2}
                spellcheck={false}
                autocomplete="off"
                autocapitalize="off"
                placeholder={kind === "send" ? FORM_COPY.toSendPlaceholder : FORM_COPY.toSurfacePlaceholder}
                value={to}
                aria-invalid={addressError ? "true" : undefined}
                aria-describedby={addressError ? `${kind}-to-error` : undefined}
                onInput={(event) => setTo(event.currentTarget.value.replace(/\s+/g, ""))}
                onBlur={() => setTouched(true)}
              />
              {address?.ok && (
                <span class="input-group__ok">
                  <Icon name="check" label={address.code ? "A valid payment code" : "A valid address"} />
                </span>
              )}
            </div>
            {kind === "send" && !loch2 && (
              <button class="link link--quiet form__switch" type="button" onClick={() => setAsLink(true)}>
                {FORM_COPY.asLink}
              </button>
            )}
          </Field>
        )}

        <AmountField
          id={`${kind}-amount`}
          label={FORM_COPY.amount}
          value={amountText}
          unit={asset.symbol}
          shielded={kind === "send"}
          onInput={(value) => {
            setAmountText(value);
            setTouched(true);
          }}
          onMax={ceiling !== null && ceiling > 0n ? () => setAmountText(inputUnits(ceiling!, asset)) : undefined}
          error={formatError ?? amountError}
          hint={
            kind === "dive" ? (
              native ? (
                publicBalance !== null ? (
                  <>
                    Public balance <Amount lamports={publicBalance} /> SOL.
                  </>
                ) : (
                  "Reading your public balance."
                )
              ) : (
                `From your wallet's ${asset.symbol}.`
              )
            ) : (
              <>
                {moving ? EARLIER_COPY.label : "Shielded balance"} {show(asset.balance, { shielded: true })}.
              </>
            )
          }
        />

        <dl class="deflist deflist--kv">
          {kind === "dive" ? (
            <>
              <div class="deflist__row">
                <dt>{FORM_COPY.networkFee}</dt>
                <dd>
                  <Amount lamports={overhead} exact /> SOL
                </dd>
              </div>
              {native && (
                <div class="deflist__row">
                  <dt>{FORM_COPY.total}</dt>
                  <dd>{amount !== null ? <Amount lamports={amount + overhead} exact /> : <span class="t-quiet">{FORM_COPY.enterAmount}</span>}{amount !== null && " SOL"}</dd>
                </div>
              )}
            </>
          ) : (
            <>
              <div class="deflist__row">
                <dt>{FORM_COPY.fee}</dt>
                <dd>{fee !== null ? show(fee - accountFee, { exact: true }) : <span class="t-quiet">{quote === null ? "Asking the relayer" : "Not known"}</span>}</dd>
              </div>
              {accountFee > 0n && (
                <div class="deflist__row">
                  <dt>{FORM_COPY.accountFee(asset.symbol)}</dt>
                  <dd>{show(accountFee, { exact: true })}</dd>
                </div>
              )}
              {linked && (
                <div class="deflist__row">
                  <dt>{FORM_COPY.collectFee}</dt>
                  <dd>{fee !== null ? show(fee, { exact: true }) : <span class="t-quiet">Not known</span>}</dd>
                </div>
              )}
              <div class="deflist__row">
                <dt>{FORM_COPY.total}</dt>
                <dd>{total !== null ? show(total, { shielded: true, exact: true }) : <span class="t-quiet">{FORM_COPY.enterAmount}</span>}</dd>
              </div>
            </>
          )}
        </dl>

        {blocked}

        {needsConsolidation && fee !== null && (
          <div class="notice" role="status">
            <p class="notice__title">{FORM_COPY.combineTitle}</p>
            <p>{FORM_COPY.combineLine}</p>
          </div>
        )}

        {earlier && (
          <div class="notice notice--caution" role="status">
            <p class="notice__title">
              <Icon name="caution" />
              An earlier {kind === "send" ? "payment" : "withdrawal"} to this address is still open
            </p>
            <p>
              {assetText(BigInt(earlier.amount), earlier.mint, true)}, {whenText(earlier.at, now)}: a relayer has it and its outcome is not known yet. This would be a second one. If both land, the address is paid twice.
            </p>
          </div>
        )}

        {kind === "surface" && warnings.length > 0 && (
          <div class="notice notice--caution" role="status">
            <p class="notice__title">
              <Icon name="caution" />
              {warnings.every((warning) => warning.id === "shown") ? DEPTH_COPY.shownTitle : FORM_COPY.warningTitle}
            </p>
            <ul class="reasons">
              {warnings.map((warning) => (
                <li key={warning.id}>{SURFACE_WARNING[warning.id](warning, now)}</li>
              ))}
            </ul>
            <p>
              {warnings.some((warning) => warning.id !== "shown") ? FORM_COPY.warningAdvice : ""}
              {warnings.some((warning) => warning.id === "shown") ? ` ${DEPTH_COPY.shownAdvice}` : ""}
            </p>
          </div>
        )}

        {submitError && (
          <p class="field__error" role="alert">
            <Icon name="caution" />
            <span>{submitError}</span>
          </p>
        )}

        {!blocked && (
          <HowItWorks anchor={DOCS_ANCHOR[kind === "send" && address?.ok && address.code ? "paymentCode" : kind]}>
            <Observer>{OBSERVER[needsConsolidation ? "consolidate" : kind]}</Observer>
            {kind === "dive" && <p>{FORM_COPY.screening(quote?.screener?.policy)}</p>}
            {kind === "dive" && asset.maxDeposit !== null && (
              <p>
                <Rich text={`The pool takes at most ${pub(assetText(asset.maxDeposit, asset.mint, true))} in one deposit.`} />
              </p>
            )}
            {kind === "surface" && native && (
              <p>
                <Rich text={FORM_COPY.surfaceMin(exactSol(max(SYSTEM_RENT_MINIMUM, BigInt(quote?.relayer?.minWithdrawal ?? "0"))))} />
              </p>
            )}
            {kind === "send" && address?.ok && address.code && <p>{FORM_COPY.code}</p>}
          </HowItWorks>
        )}
      </form>
    </Sheet>
  );
}

/**
 * Move: the earlier pool's two largest notes into the new pool, in one transaction that the
 * wallet approves and the relayer pays for. Nothing to type: what moves is what two notes hold.
 */
export function MoveSheet({ snapshot, api, onClose, openSettings }: { snapshot: Snapshot; api: Api; onClose: () => void; openSettings: () => void }) {
  const { quote, error: quoteError, reload } = useQuote(api, "spend");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const balance = BigInt(snapshot.shielded?.balance ?? "0");
  const pair = BigInt(snapshot.shielded?.largestPair ?? "0");
  const sol = quote?.v2?.assets.find((asset) => isNative(asset.mint));
  const cap = sol ? BigInt(sol.maxDeposit) : null;
  const moves = cap !== null && pair > cap ? cap : pair;
  const terms = quote?.v2?.relayer?.move ?? null;
  const minimum = terms ? max(BigInt(terms.min), SYSTEM_RENT_MINIMUM) : null;

  let blocked: ComponentChildren = null;
  if (quoteError === "failed" || (quoteError && !quote)) {
    blocked = (
      <QuoteNotice title="The RPC endpoint did not answer" onRetry={reload} openSettings={openSettings}>
        Loch could not read the network&rsquo;s state. Check your connection, or choose another endpoint in settings.
      </QuoteNotice>
    );
  } else if (quote && !quote.v2?.relayer) {
    blocked = (
      <QuoteNotice title="The relayer did not answer" onRetry={reload} openSettings={openSettings}>
        A move needs it. Try again, or choose another relayer in settings.
      </QuoteNotice>
    );
  } else if (quote && !terms) {
    blocked = (
      <QuoteNotice title="The relayer does not pay for moves" onRetry={reload} openSettings={openSettings}>
        {EARLIER_COPY.unavailable}
      </QuoteNotice>
    );
  } else if (quote?.v2?.paused || (sol && !sol.depositsEnabled)) {
    blocked = (
      <div class="notice notice--caution" role="alert">
        <p class="notice__title">
          <Icon name="caution" />
          Deposits are paused
        </p>
        <p>The new pool&rsquo;s operator has paused diving in, and a move dives in. Your balance stays in the earlier pool.</p>
      </div>
    );
  } else if (minimum !== null && moves < minimum) {
    blocked = (
      <div class="notice" role="status">
        <p class="notice__title">Too little to move</p>
        <p>
          <Rich text={`One move takes at least ${shd(exactSol(minimum))} SOL. Surface it instead.`} />
        </p>
      </div>
    );
  }
  const ready = quote !== null && blocked === null && moves > 0n && !submitting;
  const submit = async () => {
    if (!ready) return;
    setSubmitting(true);
    setSubmitError(null);
    const reply = await api.call({ loch: "ui", type: "move" });
    setSubmitting(false);
    if (!reply.ok) setSubmitError("Loch could not start this. Close the sheet and try again. Nothing was sent.");
  };

  return (
    <Sheet
      title={EARLIER_COPY.title}
      id="form-move"
      onClose={onClose}
      foot={
        <>
          <button class="btn btn--secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button class="btn btn--primary" type="button" aria-busy={submitting || quote === null ? "true" : undefined} aria-disabled={ready ? undefined : "true"} onClick={() => void submit()}>
            {EARLIER_COPY.move}
          </button>
        </>
      }
    >
      <div class="stack">
        <p class="t-small">{EARLIER_COPY.line}</p>
        <dl class="deflist deflist--kv">
          <div class="deflist__row">
            <dt>{EARLIER_COPY.label}</dt>
            <dd>
              <Amount lamports={balance} shielded exact /> SOL
            </dd>
          </div>
          <div class="deflist__row">
            <dt>{EARLIER_COPY.moves}</dt>
            <dd>
              <Amount lamports={moves} shielded exact /> SOL
            </dd>
          </div>
          <div class="deflist__row">
            <dt>{EARLIER_COPY.fee}</dt>
            <dd>{EARLIER_COPY.free}</dd>
          </div>
        </dl>
        {blocked}
        {!blocked && balance > moves && <p class="t-small">{EARLIER_COPY.rest}</p>}
        {submitError && (
          <p class="field__error" role="alert">
            <Icon name="caution" />
            <span>{submitError}</span>
          </p>
        )}
        {!blocked && (
          <HowItWorks anchor={DOCS_ANCHOR.move}>
            <Observer>{EARLIER_COPY.observer}</Observer>
          </HowItWorks>
        )}
      </div>
    </Sheet>
  );
}

/** How far under the quote a swap's minimum is set: 1% (100 basis points). */
const SWAP_SLIPPAGE_BPS = 100n;
const swapMinimum = (quoted: bigint) => (quoted * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;

/**
 * A swap whose price moved: a new quote, then the same flow again at the new minimum. The flow
 * keeps its notes (an earlier proof of them may still be with the relayer), so the swap goes on
 * in place rather than starting over.
 */
function NewPrice({ flow, api }: { flow: FlowView; api: Api }) {
  const [minimum, setMinimum] = useState<bigint | null | "asking">(null);
  const ask = () => {
    setMinimum("asking");
    void api.call<{ amountOut: string }>({ loch: "ui", type: "swap-quote", from: flow.mint ?? NATIVE_MINT, to: flow.toMint ?? "", amount: flow.amount ?? "0" }).then((reply) => {
      setMinimum(reply.ok && BigInt(reply.value.amountOut) > 0n ? swapMinimum(BigInt(reply.value.amountOut)) : null);
    });
  };
  if (typeof minimum === "bigint") {
    return (
      <button class="btn btn--primary" type="button" data-autofocus="" onClick={() => void api.call({ loch: "ui", type: "flow-retry", minOut: minimum.toString() })}>
        {SWAP_COPY.again(assetText(minimum, flow.toMint, true))}
      </button>
    );
  }
  return (
    <button class="btn btn--primary" type="button" data-autofocus="" disabled={minimum === "asking"} onClick={ask}>
      {minimum === "asking" ? SWAP_COPY.asking : SWAP_COPY.newQuote}
    </button>
  );
}

/**
 * Swap inside the Loch (v2): spend one asset, get another, as a shielded note. The relayer's
 * router quotes; the minimum the proof binds is 1% under the quote, and the swap is refused
 * rather than paid less.
 */
export function SwapSheet({ snapshot, api, onClose, openSettings }: { snapshot: Snapshot; api: Api; onClose: () => void; openSettings: () => void }) {
  const loch2 = snapshot.loch2!;
  const { quote, error: quoteError, reload } = useQuote(api, "spend");
  const registered = quote?.v2?.assets ?? [];
  const held = loch2.assets.filter((asset) => BigInt(asset.spendable) > 0n);
  const [from, setFrom] = useState(held[0]?.mint ?? NATIVE_MINT);
  const targets = registered.filter((asset) => asset.mint !== from && asset.depositsEnabled);
  const [into, setInto] = useState<string>("");
  const target = targets.find((asset) => asset.mint === into) ?? targets[0];
  const source = held.find((asset) => asset.mint === from) ?? loch2.assets[0]!;
  const sourceAsset: FormAsset = { mint: source.mint, symbol: source.symbol, decimals: source.decimals, balance: BigInt(source.balance), spendable: BigInt(source.spendable), largestPair: BigInt(source.largestPair), maxDeposit: null };
  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [out, setOut] = useState<{ key: string; amount: bigint | null } | null>(null);

  const parsed = parseAssetAmount(amountText, sourceAsset);
  const amount = parsed.ok ? parsed.units : null;
  const feeText = quote?.v2?.relayer?.fees[from];
  const fee = feeText !== undefined ? BigInt(feeText) : null;
  const feeLimit = isNative(from) ? BigInt(snapshot.settings.maxFeeLamports) : BigInt(assetMeta(snapshot.cluster, from).maxFee);
  const swaps = quote?.v2?.relayer?.swaps === true;

  // A quote for what is typed, asked once the typing stops.
  const key = `${from}:${target?.mint ?? ""}:${amount ?? ""}`;
  useEffect(() => {
    if (!target || amount === null || !swaps) {
      setOut(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api.call<{ amountOut: string }>({ loch: "ui", type: "swap-quote", from, to: target.mint, amount: amount.toString() }).then((reply) => {
        if (live) setOut({ key, amount: reply.ok ? BigInt(reply.value.amountOut) : null });
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, key, swaps]);

  const quoted = out && out.key === key ? out.amount : undefined;
  const minimum = quoted ? swapMinimum(quoted) : null;
  let amountError: string | null = touched && !parsed.ok ? parsed.problem : null;
  if (amount !== null && fee !== null) {
    if (amount + fee > sourceAsset.spendable) amountError = `You can swap at most ${assetText(max(0n, sourceAsset.spendable - fee), from, true)}: what can be spent now, less the relayer’s fee.`;
    else if (amount + fee > sourceAsset.largestPair) amountError = FORM_COPY.combineLine;
  }
  let blocked: ComponentChildren = null;
  if (quoteError) {
    blocked = (
      <QuoteNotice title="The RPC endpoint did not answer" onRetry={reload} openSettings={openSettings}>
        Loch could not read the network&rsquo;s state. Check your connection, or choose another endpoint in settings.
      </QuoteNotice>
    );
  } else if (quote && !swaps) {
    blocked = (
      <QuoteNotice title="The relayer does no swaps" onRetry={reload} openSettings={openSettings}>
        Choose a relayer that swaps in settings.
      </QuoteNotice>
    );
  } else if (quote && fee === null) {
    blocked = (
      <QuoteNotice title="The relayer does not take this asset" onRetry={reload} openSettings={openSettings}>
        It is paid in the asset the swap spends, and it takes no {source.symbol}.
      </QuoteNotice>
    );
  } else if (fee !== null && fee > feeLimit) {
    blocked = (
      <QuoteNotice title="The relayer&rsquo;s fee is above your limit" onRetry={reload} openSettings={openSettings}>
        It asks {assetText(fee, from, true)}. Your limit is {assetText(feeLimit, from, true)}.
      </QuoteNotice>
    );
  }
  const ready = !blocked && target !== undefined && amount !== null && amountError === null && minimum !== null && minimum > 0n && fee !== null && !submitting;

  const submit = async () => {
    setTouched(true);
    if (!ready || !target || amount === null || minimum === null || fee === null) return;
    setSubmitting(true);
    setSubmitError(null);
    const reply = await api.call({ loch: "ui", type: "swap", from, to: target.mint, amount: amount.toString(), minOut: minimum.toString(), fee: fee.toString() });
    setSubmitting(false);
    if (!reply.ok) setSubmitError("Loch could not start this. Close the sheet and try again. Nothing was sent.");
  };

  return (
    <Sheet
      title={SWAP_COPY.title}
      id="form-swap"
      onClose={onClose}
      foot={
        <>
          <button class="btn btn--secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button class="btn btn--primary" type="submit" form="form-swap-form" aria-busy={submitting || quote === null ? "true" : undefined} aria-disabled={ready ? undefined : "true"}>
            {SWAP_COPY.title}
          </button>
        </>
      }
    >
      <form
        id="form-swap-form"
        class="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <AssetPicker
          label={SWAP_COPY.from}
          assets={held.length > 0 ? held : loch2.assets.slice(0, 1)}
          value={from}
          onChange={(next) => {
            setFrom(next);
            setAmountText("");
          }}
        />
        <AssetPicker label={SWAP_COPY.to} assets={targets} value={target?.mint ?? ""} onChange={setInto} />
        <AmountField
          id="swap-amount"
          label={FORM_COPY.amount}
          value={amountText}
          unit={source.symbol}
          shielded
          onInput={(value) => {
            setAmountText(value);
            setTouched(true);
          }}
          onMax={fee !== null && sourceAsset.largestPair > fee ? () => setAmountText(inputUnits(sourceAsset.largestPair - fee, sourceAsset)) : undefined}
          error={amountError}
          hint={<>Shielded balance <AssetAmount units={sourceAsset.balance} mint={from} decimals={source.decimals} symbol={source.symbol} shielded />.</>}
        />
        <dl class="deflist deflist--kv">
          <div class="deflist__row">
            <dt>{SWAP_COPY.quote}</dt>
            <dd>
              {target && quoted ? (
                <AssetAmount units={quoted} mint={target.mint} decimals={target.decimals} symbol={target.symbol} shielded />
              ) : (
                <span class="t-quiet">{amount === null ? FORM_COPY.enterAmount : quoted === null ? SWAP_COPY.noQuote : SWAP_COPY.asking}</span>
              )}
            </dd>
          </div>
          <div class="deflist__row">
            <dt>{SWAP_COPY.minimum}</dt>
            <dd>{target && minimum !== null ? <AssetAmount units={minimum} mint={target.mint} decimals={target.decimals} symbol={target.symbol} shielded exact /> : <span class="t-quiet">—</span>}</dd>
          </div>
          <div class="deflist__row">
            <dt>{FORM_COPY.fee}</dt>
            <dd>{fee !== null ? <AssetAmount units={fee} mint={from} decimals={source.decimals} symbol={source.symbol} exact /> : <span class="t-quiet">{quote === null ? "Asking the relayer" : "Not known"}</span>}</dd>
          </div>
        </dl>
        {blocked}
        {submitError && (
          <p class="field__error" role="alert">
            <Icon name="caution" />
            <span>{submitError}</span>
          </p>
        )}
        {!blocked && (
          <HowItWorks>
            <Observer>{OBSERVER.swap}</Observer>
            <p>{SWAP_COPY.slippage}</p>
          </HowItWorks>
        )}
      </form>
    </Sheet>
  );
}


// ---------------------------------------------------------------- wallets menu

export function WalletsSheet({ snapshot, api, onClose, go }: { snapshot: Snapshot; api: Api; onClose: () => void; go: (view: View) => void }) {
  const busy = snapshot.flow !== null && (snapshot.flow.status === "running" || snapshot.flow.status === "waiting");
  const anyUnlocked = snapshot.wallets.some((wallet) => wallet.unlocked);
  return (
    <Sheet title="Wallets" id="wallets" onClose={onClose}>
      <ul class="picklist" aria-label="Wallets on this device">
        {snapshot.wallets.map((wallet) => {
          const active = wallet.address === snapshot.active;
          return (
            <li key={wallet.address}>
              <button
                class="picklist__row"
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  void api.call({ loch: "ui", type: "select", address: wallet.address });
                  onClose();
                }}
              >
                <Icon name={active ? "check" : "wallet"} />
                <span class="picklist__name">
                  {wallet.walletName} <span class="picklist__note fig">{shortAddress(wallet.address)}</span>
                </span>
                <span class="picklist__go">{wallet.unlocked ? (active ? "Showing" : "Show") : "Locked"}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div class="cluster">
        <button
          class="btn btn--secondary btn--sm"
          type="button"
          disabled={busy}
          onClick={() => {
            onClose();
            void api.call({ loch: "ui", type: "connect" });
          }}
        >
          Connect another wallet
        </button>
        <button
          class="btn btn--secondary btn--sm"
          type="button"
          disabled={!anyUnlocked || busy}
          onClick={() => {
            onClose();
            void api.call({ loch: "ui", type: "lock" });
          }}
        >
          Lock now
        </button>
      </div>
      <p class="t-fine">Locking drops the keys from memory. Your data stays on this device, encrypted, until the wallet signs again.</p>
      <ul class="picklist" aria-label="More">
        <li>
          <button class="picklist__row" type="button" onClick={() => go("settings")}>
            <Icon name="settings" />
            <span class="picklist__name">Settings</span>
            <span class="picklist__go">{SETTINGS_COPY.settingsNote}</span>
          </button>
        </li>
        {api.popup && (
          <li>
            <button class="picklist__row" type="button" onClick={() => api.openExpanded()}>
              <Icon name="external" />
              <span class="picklist__name">Open in a tab</span>
              <span class="picklist__go">Stays open while your wallet asks</span>
            </button>
          </li>
        )}
      </ul>
    </Sheet>
  );
}
