// The sheets: the three forms (dive in, send privately, surface), the flow in progress, the
// flow that failed, and the wallet menu. A sheet rises from the bed of the popup; the caution
// band stays above its scrim.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { amountProblemText, displaySol, exactSol, inputSol, parseAmountInput } from "../shared/amounts.js";
import { mainnetTestingEnabled } from "../shared/build.js";
import { DEPOSIT_OVERHEAD, SYSTEM_RENT_MINIMUM } from "../shared/constants.js";
import { ACTION_NAME, ACTION_RUNNING, DEPTH_COPY, OBSERVER, busyLabel, failureCopy, shortAddress, whenText } from "../shared/copy.js";
import type { AddressCheck, FlowView, PublicBalanceReply, Quote, Snapshot, SurfaceWarningView } from "../shared/view.js";
import type { Api, Draft } from "./api.js";
import type { View } from "./App.js";
import { Amount, AmountField, FailureBlock, Field, Icon, Observer, Progress, Sheet } from "./parts.js";
import { pub, shd } from "../shared/copy.js";

export type FormKind = "dive" | "send" | "surface";

// ------------------------------------------------------------------ in progress

function FlowRows({ flow, snapshot }: { flow: FlowView; snapshot: Snapshot }) {
  if (flow.kind === "unlock" || flow.kind === "consolidate") {
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
            <Amount lamports={DEPOSIT_OVERHEAD} exact /> SOL
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
  const label = ACTION_RUNNING[flow.kind];
  const isForm = flow.kind === "dive" || flow.kind === "send" || flow.kind === "surface";

  if (flow.status === "failed" && flow.failure) {
    const failure = flow.failure;
    const context = {
      kind: flow.kind,
      shielded: snapshot.shielded?.balance,
      walletName: flow.walletName,
      address: snapshot.active ?? undefined,
      connectUrl: flow.connectUrl ?? snapshot.settings.connectUrl,
      proofKept: flow.proofKept,
    };
    const copy = failureCopy(failure, context);
    const back = () => {
      dismiss();
      if (isForm) openForm(flow.kind as FormKind);
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
    ) : failure.retry || failure.code === "consolidation-needed" || failure.code === "fee-changed" ? (
      <button class="btn btn--secondary" type="button" onClick={dismiss}>
        Close
      </button>
    ) : null;

    return (
      <Sheet
        title={ACTION_NAME[flow.kind]}
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
      {flow.kind !== "unlock" && <Observer>{OBSERVER[flow.kind]}</Observer>}
    </Sheet>
  );
}

// ------------------------------------------------------------------------ forms

const ADDRESS_PROBLEM: Record<Exclude<AddressCheck, { ok: true }>["reason"], string> = {
  empty: "Enter an address.",
  encoding: "This is not a shielded address or a payment code. An address starts with loch1 and is 114 characters long. A code starts with lochpay1 and is 168.",
  prefix: "This is not a Loch address. A shielded address starts with loch1, a payment code with lochpay1.",
  checksum: "There is an error in it: its checksum does not match. Copy it again.",
  length: "It is not complete. A shielded address is 114 characters long, a payment code 168.",
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

/** What the send form says under a recipient it accepts. */
function recipientHint(address: Extract<AddressCheck, { ok: true }>): string {
  if (address.own) return address.code ? "This is one of your own payment codes." : "This is your own shielded address.";
  if (address.code) return "A payment code. What you send stays unreadable to others even if today’s encryption is broken later.";
  return "A shielded address. If the recipient gives you a payment code instead, the payment also stays private from a future quantum computer.";
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

export function FormSheet({ kind, snapshot, api, onClose, openSettings }: { kind: FormKind; snapshot: Snapshot; api: Api; onClose: () => void; openSettings: () => void }) {
  const [to, setTo] = useState("");
  /** Send: pay a claim link in place of an address, for someone who has no Loch yet. */
  const [asLink, setAsLink] = useState(false);
  const linked = kind === "send" && asLink;
  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<SurfaceWarningView[]>([]);
  const restored = useRef(false);
  const { quote, error: quoteError, reload } = useQuote(api, kind === "dive" ? "dive" : "spend");
  const address = useAddressCheck(api, kind === "send" ? "shielded" : "public", kind === "dive" || linked ? "" : to);
  const shielded = snapshot.shielded;
  const now = api.now();

  // Opening the dive-in form reads the public balance at once: a deposit is made from it.
  useEffect(() => {
    if (kind === "dive") void api.call<PublicBalanceReply>({ loch: "ui", type: "public-balance" });
  }, [api, kind]);

  // What was typed survives the popup closing.
  useEffect(() => {
    void api.draft().then((draft) => {
      if (draft && draft.kind === kind) {
        setTo(draft.to);
        setAmountText(draft.amount);
      }
      restored.current = true;
    });
  }, [api, kind]);
  useEffect(() => {
    if (!restored.current) return;
    const draft: Draft = { kind, to, amount: amountText };
    void api.setDraft(draft);
  }, [api, kind, to, amountText]);

  const parsed = parseAmountInput(amountText);
  const amount = parsed.ok ? parsed.lamports : null;
  const publicBalance = snapshot.publicBalance === null ? null : BigInt(snapshot.publicBalance);
  const fee = quote?.relayer ? BigInt(quote.relayer.fee) : null;
  const feeLimit = BigInt(snapshot.settings.maxFeeLamports);
  const spendable = shielded ? BigInt(shielded.spendable) : 0n;
  const largestPair = shielded ? BigInt(shielded.largestPair) : 0n;

  // ------------------------------------------------------------------ limits
  let ceiling: bigint | null = null;
  let amountError: string | null = null;
  let blocked: ComponentChildren = null;
  let needsConsolidation = false;

  if (kind === "dive") {
    const poolMax = quote?.pool ? BigInt(quote.pool.maxDeposit) : null;
    const screenerMax = quote?.screener ? BigInt(quote.screener.maxDeposit) : null;
    const budget = publicBalance === null ? null : max(0n, publicBalance - DEPOSIT_OVERHEAD - SYSTEM_RENT_MINIMUM);
    const limits = [poolMax, screenerMax, budget].filter((value): value is bigint => value !== null);
    ceiling = limits.length > 0 ? min(...limits) : null;
    if (amount !== null) {
      if (poolMax !== null && amount > poolMax) amountError = `The pool takes at most ${pub(exactSol(poolMax))} SOL in one deposit.`;
      else if (screenerMax !== null && amount > screenerMax) amountError = `The screening service signs at most ${pub(exactSol(screenerMax))} SOL in one deposit.`;
      else if (budget !== null && amount > budget) {
        amountError =
          budget === 0n
            ? `Your public balance does not cover the network fee and rent of a deposit. Add ${mainnetTestingEnabled() ? "SOL" : "test SOL"} to the wallet.`
            : `Your public balance covers at most ${pub(exactSol(budget))} SOL, after the network fee and rent and what must stay in the wallet.`;
      }
    }
    if (quote?.pool?.paused) {
      blocked = (
        <div class="notice notice--caution" role="alert">
          <p class="notice__title">
            <Icon name="caution" />
            Deposits are paused
          </p>
          <p>The pool&rsquo;s operator has paused diving in. Sending privately and surfacing still work.</p>
        </div>
      );
    } else if (quote && !quote.pool) {
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
    if (quote && !quote.relayer) {
      blocked = (
        <QuoteNotice title={quote.relayerError === "mismatch" ? "The relayer serves another network" : "The relayer did not answer"} onRetry={reload} openSettings={openSettings}>
          {quote.relayerError === "mismatch"
            ? "It works for a different pool or cluster than the RPC endpoint. Check the relayer in settings."
            : "Its fee is not known, so nothing can be proven yet. Try again, or choose another relayer in settings."}
        </QuoteNotice>
      );
    } else if (fee !== null && fee > feeLimit) {
      blocked = (
        <QuoteNotice title="The relayer&rsquo;s fee is above your limit" onRetry={reload} openSettings={openSettings}>
          It asks {exactSol(fee)} SOL. Your limit is {exactSol(feeLimit)} SOL. Choose another relayer, or raise the limit in settings.
        </QuoteNotice>
      );
    }
    if (fee !== null) {
      // A claim link carries a second fee: the one its recipient pays to collect it.
      const fees = linked ? 2n * fee : fee;
      // The most one transaction can move: the two largest notes, less the fee.
      ceiling = max(0n, largestPair - fees);
      const minimum = kind === "surface" ? max(SYSTEM_RENT_MINIMUM, BigInt(quote?.relayer?.minWithdrawal ?? "0")) : 0n;
      if (amount !== null) {
        if (amount + fees > spendable) {
          amountError =
            spendable <= fees
              ? linked
                ? "Your shielded balance does not cover the two relayer fees of a claim link."
                : "Your shielded balance does not cover the relayer’s fee."
              : `You can ${kind === "send" ? "send" : "surface"} at most ${exactSol(spendable - fees)} SOL: what can be spent now, less the relayer’s ${linked ? "fees" : "fee"}.`;
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

  const formatError = touched && !parsed.ok ? amountProblemText(parsed.problem) : null;
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

  const submit = async () => {
    setTouched(true);
    if (!ready || amount === null) return;
    setSubmitting(true);
    setSubmitError(null);
    const reply =
      kind === "dive"
        ? await api.call({ loch: "ui", type: "dive", amount: amount.toString() })
        : linked
          ? await api.call({ loch: "ui", type: "send-claim", amount: amount.toString(), fee: (fee ?? 0n).toString() })
          : kind === "send"
          ? await api.call({ loch: "ui", type: "send", to: destination ?? "", amount: amount.toString(), fee: (fee ?? 0n).toString() })
          : await api.call({ loch: "ui", type: "surface", to: destination ?? "", amount: amount.toString(), fee: (fee ?? 0n).toString() });
    setSubmitting(false);
    if (!reply.ok) setSubmitError("Loch could not start this. Close the sheet and try again. Nothing was sent.");
  };

  const consolidate = async () => {
    if (fee === null) return;
    setSubmitting(true);
    const reply = await api.call({ loch: "ui", type: "consolidate", fee: fee.toString() });
    setSubmitting(false);
    if (!reply.ok) setSubmitError("Loch could not start this. Close the sheet and try again. Nothing was sent.");
  };

  const total = amount !== null && fee !== null ? amount + (linked ? 2n * fee : fee) : null;
  // An earlier payment to the same address whose outcome is not known: its request is with a
  // relayer and may still land. A new one is a second payment, made from other notes. A payment
  // code is known to the activity list by the address inside it.
  const payee = !linked && address?.ok ? (address.payee ?? address.address) : null;
  const earlier = kind === "dive" || payee === null ? undefined : snapshot.activity.find((entry) => entry.kind === kind && entry.counterparty === payee && (entry.status === "unknown" || entry.status === "submitted"));
  const primaryLabel = needsConsolidation ? "Combine notes" : kind === "surface" && (warnings.length > 0 || earlier) ? "Surface anyway" : kind === "send" && earlier ? "Send anyway" : linked ? "Pay and make the link" : ACTION_NAME[kind];

  return (
    <Sheet
      title={ACTION_NAME[kind]}
      id={`form-${kind}`}
      onClose={onClose}
      foot={
        <>
          <button class="btn btn--secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            class="btn btn--primary"
            type="submit"
            form={`form-${kind}-form`}
            aria-busy={submitting || quote === null ? "true" : undefined}
            aria-disabled={needsConsolidation ? (fee === null || submitting ? "true" : undefined) : ready ? undefined : "true"}
          >
            {primaryLabel}
          </button>
        </>
      }
    >
      <form
        id={`form-${kind}-form`}
        class="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (needsConsolidation) void consolidate();
          else void submit();
        }}
      >
        {kind === "send" && (
          <label class="choice">
            <input class="toggle" type="checkbox" role="switch" checked={asLink} onChange={(event) => setAsLink(event.currentTarget.checked)} />
            <span>
              Pay with a claim link
              <small>For someone who has no Loch yet, and so no shielded address to give you.</small>
            </span>
          </label>
        )}
        {linked && (
          <p class="notice notice--inline">
            <Icon name="info" />
            <span>
              Loch pays the amount to a link you send them yourself. Whoever opens the link first collects it, into their own Loch or to any Solana address, so send it privately. Until then you can take it back.
            </span>
          </p>
        )}
        {kind !== "dive" && !linked && (
          <Field
            label={kind === "send" ? "To a shielded address or a payment code" : "To a public Solana address"}
            id={`${kind}-to`}
            error={addressError}
            hint={kind === "send" && address?.ok ? recipientHint(address) : undefined}
          >
            <div class="input-group input-group--address">
              <textarea
                class="input"
                id={`${kind}-to`}
                rows={kind === "send" ? 4 : 2}
                spellcheck={false}
                autocomplete="off"
                autocapitalize="off"
                placeholder={kind === "send" ? "loch1…" : "Paste an address"}
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
          </Field>
        )}

        <AmountField
          id={`${kind}-amount`}
          label={kind === "dive" ? "Amount to dive in with" : kind === "send" ? "Amount to send privately" : "Amount to surface"}
          value={amountText}
          shielded={kind === "send"}
          onInput={(value) => {
            setAmountText(value);
            setTouched(true);
          }}
          onMax={ceiling !== null && ceiling > 0n ? () => setAmountText(inputSol(ceiling!)) : undefined}
          error={formatError ?? amountError}
          hint={
            kind === "dive" ? (
              <>
                {publicBalance !== null ? (
                  <>
                    Public balance <Amount lamports={publicBalance} /> SOL.
                  </>
                ) : (
                  "Reading your public balance."
                )}{" "}
                {amountError ? null : quote?.pool ? (
                  <>
                    The pool takes at most <Amount lamports={BigInt(quote.pool.maxDeposit)} exact /> SOL in one deposit.
                  </>
                ) : quote === null ? (
                  "Reading the pool’s limits."
                ) : null}
              </>
            ) : (
              <>
                Shielded balance <Amount lamports={BigInt(shielded?.balance ?? "0")} shielded /> SOL.
                {kind === "surface" && !amountError && (
                  <>
                    {" "}
                    Surface at least <Amount lamports={max(SYSTEM_RENT_MINIMUM, BigInt(quote?.relayer?.minWithdrawal ?? "0"))} exact /> SOL.
                  </>
                )}
              </>
            )
          }
        />

        <dl class="deflist deflist--kv">
          {kind === "dive" ? (
            <>
              <div class="deflist__row">
                <dt>From</dt>
                <dd>
                  <span class="fig is-public">{shortAddress(snapshot.active ?? "")}</span>
                </dd>
              </div>
              <div class="deflist__row">
                <dt>Network fee and rent</dt>
                <dd>
                  <Amount lamports={DEPOSIT_OVERHEAD} exact /> SOL
                </dd>
              </div>
              <div class="deflist__row">
                <dt>Leaves your wallet</dt>
                <dd>{amount !== null ? <Amount lamports={amount + DEPOSIT_OVERHEAD} exact /> : <span class="t-quiet">Enter an amount</span>}{amount !== null && " SOL"}</dd>
              </div>
            </>
          ) : (
            <>
              <div class="deflist__row">
                <dt>Relayer fee</dt>
                <dd>{fee !== null ? <Amount lamports={fee} exact /> : <span class="t-quiet">{quote === null ? "Asking the relayer" : "Not known"}</span>}{fee !== null && " SOL"}</dd>
              </div>
              {linked && (
                <div class="deflist__row">
                  <dt>Fee for collecting, paid ahead</dt>
                  <dd>{fee !== null ? <Amount lamports={fee} exact /> : <span class="t-quiet">Not known</span>}{fee !== null && " SOL"}</dd>
                </div>
              )}
              <div class="deflist__row">
                <dt>Leaves your shielded balance</dt>
                <dd>{total !== null ? <Amount lamports={total} shielded exact /> : <span class="t-quiet">Enter an amount</span>}{total !== null && " SOL"}</dd>
              </div>
            </>
          )}
        </dl>

        {blocked}

        {needsConsolidation && fee !== null && (
          <div class="notice" role="status">
            <p class="notice__title">Combine notes first</p>
            <p>
              Your balance is in {shielded?.notes ?? "several"} notes, and one transaction can spend two. The two largest hold <Amount lamports={largestPair} shielded /> SOL; this needs{" "}
              {total !== null ? <Amount lamports={total} shielded exact /> : "more"}.
            </p>
            <p>
              Combining merges them into one, for one relayer fee (<Amount lamports={fee} exact /> SOL). Then send.
            </p>
          </div>
        )}

        {earlier && (
          <div class="notice notice--caution" role="status">
            <p class="notice__title">
              <Icon name="caution" />
              An earlier {kind === "send" ? "payment" : "withdrawal"} to this address is still open
            </p>
            <p>
              <Amount lamports={BigInt(earlier.amount)} shielded={kind === "send"} exact /> SOL, {whenText(earlier.at, now)}: a relayer has it and its outcome is not known yet. This would be a second one. If both land,
              the address is paid twice.
            </p>
          </div>
        )}

        {kind === "surface" && warnings.length > 0 && (
          <div class="notice notice--caution" role="status">
            <p class="notice__title">
              <Icon name="caution" />
              {warnings.every((warning) => warning.id === "shown") ? DEPTH_COPY.shownTitle : "This withdrawal points back at your deposit"}
            </p>
            <ul class="reasons">
              {warnings.map((warning) => (
                <li key={warning.id}>{SURFACE_WARNING[warning.id](warning, now)}</li>
              ))}
            </ul>
            <p>
              {warnings.some((warning) => warning.id !== "shown") ? "You can still surface. Another amount, later, to a fresh address gives less away." : "You can still surface."}
              {warnings.some((warning) => warning.id === "shown") ? ` ${DEPTH_COPY.shownAdvice}` : ""}
            </p>
          </div>
        )}

        {kind === "dive" && !blocked && (
          <p class="notice notice--inline">
            <Icon name="info" />
            <span>
              A screening service co-signs each deposit and may decline it. It sees your address and the amount.
              {quote?.screener?.policy ? ` Its policy: ${quote.screener.policy}` : ""}
            </span>
          </p>
        )}

        {submitError && (
          <p class="field__error" role="alert">
            <Icon name="caution" />
            <span>{submitError}</span>
          </p>
        )}

        {!(kind === "surface" && warnings.length > 0) && !blocked && <Observer>{OBSERVER[needsConsolidation ? "consolidate" : kind]}</Observer>}
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
            <span class="picklist__go">Endpoints, palette, this device</span>
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
