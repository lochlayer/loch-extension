// The views under the waterline that are not the home view: all activity, receive, the leak
// report and settings. In the popup one replaces the home view; in the expanded view they are
// the panel beside it.

import { byHourSvg, counterpartiesSvg, statementHtml, steppedBedSvg } from "@loch/design/charts";
import { groupAddress } from "@loch/design/numerals";
import { useEffect, useRef, useState } from "preact/hooks";

import { amountProblemText, exactSol, inputSol, parseAmountInput } from "../shared/amounts.js";
import { mainnetTestingEnabled } from "../shared/build.js";
import { CLAIM_PAGE, VERIFY_PAGE } from "../shared/constants.js";
import { DEPTH_COPY, activityObserver, activityStatusText, depthErrorText, isPublicActivity, shortAddress, verdict, whenText } from "../shared/copy.js";
import { activityCsv } from "../shared/export.js";
import type { ActivityEntry, ClaimCheck, ClaimCodeReply, DepthProofReply, PaymentCodeReply, ReceiptReply, Snapshot, SourceReportReply, ViewingKeyReply } from "../shared/view.js";
import type { Api } from "./api.js";
import { ActivityRow } from "./App.js";
import { connectPlace, useQuote } from "./flows.js";
import { Amount, AmountField, Field, Icon, Rich, ViewHead } from "./parts.js";

type ToastFn = (text: string, kind?: "done" | "caution" | "plain") => void;

interface ViewProps {
  snapshot: Snapshot;
  api: Api;
  onClose?: () => void;
}

// --------------------------------------------------------------------- activity

/**
 * What can be taken out of the wallet about one confirmed entry, to show someone: a receipt for
 * a payment, the link of a payment made to a claim link, a source-of-funds report for a
 * withdrawal. Each is made when its button is pressed and goes to the clipboard, nowhere else.
 */
function ActivityProof({ entry, api, toast }: { entry: ActivityEntry; api: Api; toast: ToastFn }) {
  const [report, setReport] = useState<SourceReportReply | null>(null);
  if (!entry.record) return null;
  const copied = (ok: boolean, what: string) => toast(ok ? `${what} copied.` : "Could not copy. Try again from the expanded view.", ok ? "done" : "caution");
  const unavailable = () => toast("This device has no record of that transaction any more.", "caution");

  if (entry.kind === "send" && entry.claim) {
    const link = async () => {
      const reply = await api.call<ClaimCodeReply>({ loch: "ui", type: "claim-code", id: entry.id });
      if (!reply.ok) return unavailable();
      copied(await api.copy(`${CLAIM_PAGE}#${reply.value.code}`), "Claim link");
    };
    return (
      <div class="activity__proof">
        <button class="btn btn--secondary btn--sm" type="button" onClick={() => void link()}>
          <Icon name="copy" small />
          Copy the claim link
        </button>
        <p class="t-fine">
          The link is the money: whoever opens it first collects it. Send it privately, to one person. To take the payment back while nobody has collected it, paste the link under Receive and collect it yourself.
        </p>
      </div>
    );
  }
  if (entry.kind === "send") {
    const receipt = async () => {
      const reply = await api.call<ReceiptReply>({ loch: "ui", type: "receipt", id: entry.id });
      if (!reply.ok) return unavailable();
      copied(await api.copy(reply.value.receipt), "Receipt");
    };
    return (
      <div class="activity__proof">
        <button class="btn btn--secondary btn--sm" type="button" onClick={() => void receipt()}>
          <Icon name="copy" small />
          Copy a receipt
        </button>
        <p class="t-fine">
          A receipt shows whoever you give it to that this transaction paid this amount to this address, and nothing else about your wallet. They check it at {VERIFY_PAGE}.
        </p>
      </div>
    );
  }
  if (entry.kind === "surface") {
    const make = async () => {
      const reply = await api.call<SourceReportReply>({ loch: "ui", type: "source-report", id: entry.id });
      if (!reply.ok) return unavailable();
      setReport(reply.value);
      copied(await api.copy(reply.value.report), "Report");
    };
    return (
      <div class="activity__proof">
        <button class="btn btn--secondary btn--sm" type="button" onClick={() => void make()}>
          <Icon name="copy" small />
          Copy a source-of-funds report
        </button>
        {report && (
          <p class="t-small" role="status">
            It opens {report.transactions} of your transactions.{" "}
            {report.undisclosed === 0
              ? "Every path in it ends at a deposit."
              : `${report.undisclosed} ${report.undisclosed === 1 ? "note in it is" : "notes in it are"} not traced further: received from someone else, or made before this device kept records.`}
          </p>
        )}
        <p class="t-fine">
          For an exchange or anyone else who asks where a withdrawal came from. It shows them the path from this withdrawal back to the deposits behind it, with the amounts of your notes on that path. Give it only to who should see that. They check it at {VERIFY_PAGE}.
        </p>
      </div>
    );
  }
  return null;
}

function ActivityDetail({ entry, api, toast }: { entry: ActivityEntry; api: Api; toast: ToastFn }) {
  const status = activityStatusText(entry);
  const shielded = !isPublicActivity(entry);
  return (
    <div class="activity__detail">
      <p>{activityObserver(entry)}</p>
      <dl class="deflist deflist--kv">
        <div class="deflist__row">
          <dt>Status</dt>
          <dd>{status ?? "Confirmed"}</dd>
        </div>
        <div class="deflist__row">
          <dt>When</dt>
          <dd class="fig">{whenText(entry.at, api.now(), true)}</dd>
        </div>
        {entry.kind !== "consolidate" && (
          <div class="deflist__row">
            <dt>Amount</dt>
            <dd>
              <Amount lamports={BigInt(entry.amount)} shielded={shielded} exact /> SOL
            </dd>
          </div>
        )}
        {entry.fee && (
          <div class="deflist__row">
            <dt>Relayer fee</dt>
            <dd>
              <Amount lamports={BigInt(entry.fee)} exact /> SOL
            </dd>
          </div>
        )}
        {entry.counterparty && (
          <div class="deflist__row">
            <dt>{entry.kind === "dive" ? "From" : "To"}</dt>
            <dd>
              <span class={`fig ${entry.kind === "send" ? "is-shielded" : "is-public"}`} title={entry.counterparty}>
                {shortAddress(entry.counterparty)}
              </span>
            </dd>
          </div>
        )}
        {entry.signature && (
          <div class="deflist__row">
            <dt>Transaction</dt>
            <dd>
              <button
                class="copy-link fig"
                type="button"
                title={entry.signature}
                onClick={() => void api.copy(entry.signature ?? "").then((ok) => toast(ok ? "Transaction id copied." : "Could not copy. Select the text instead."))}
              >
                {shortAddress(entry.signature)}
                <Icon name="copy" small label="Copy the transaction id" />
              </button>
            </dd>
          </div>
        )}
      </dl>
      <ActivityProof entry={entry} api={api} toast={toast} />
    </div>
  );
}

export function ActivityView({ snapshot, api, onClose, toast }: ViewProps & { toast: ToastFn }) {
  const [open, setOpen] = useState<string | null>(null);
  const now = api.now();
  return (
    <>
      <ViewHead title="Activity" onClose={onClose} />
      {snapshot.activity.length === 0 ? (
        <div class="empty">
          <p class="empty__title">No activity yet</p>
          <p>Dive in to move {mainnetTestingEnabled() ? "SOL" : "test SOL"} from your public wallet into your shielded balance. The deposit is public. What you do after it is not.</p>
        </div>
      ) : (
        <ul class="activity activity--full">
          {snapshot.activity.map((entry) => {
            const expanded = open === entry.id;
            return (
              <li key={entry.id}>
                <button
                  class={`activity__row ${isPublicActivity(entry) ? "is-public" : "is-shielded"}`}
                  type="button"
                  data-state={entry.status === "confirmed" ? undefined : "pending"}
                  aria-expanded={expanded ? "true" : "false"}
                  onClick={() => setOpen(expanded ? null : entry.id)}
                >
                  <ActivityRow entry={entry} now={now} />
                </button>
                {expanded && <ActivityDetail entry={entry} api={api} toast={toast} />}
              </li>
            );
          })}
        </ul>
      )}
      <p class="legend view-legend">
        <span>Upright is public on-chain.</span>
        <span class="is-shielded">Italic is shielded.</span>
      </p>
      <p class="t-fine">This list is kept on this device, encrypted. The chain cannot give it back: a sender cannot read the notes it sent.</p>
      {snapshot.activity.length > 0 && (
        <p>
          <button
            class="btn btn--secondary btn--sm"
            type="button"
            onClick={() => {
              const ok = api.save(`loch-activity-${new Date(api.now()).toISOString().slice(0, 10)}.csv`, activityCsv(snapshot.activity), "text/csv");
              toast(ok ? "Saved as a CSV file. It is not encrypted: it lists your shielded payments in plain text." : "The browser would not save the file.", ok ? "done" : "caution");
            }}
          >
            Export as CSV
          </button>
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------- receive

/** The shielded address with its copy button. `compact` leaves the explanations to the tab's own view. */
export function ReceiveBlock({ snapshot, api, toast, compact }: { snapshot: Snapshot; api: Api; toast: ToastFn; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const address = snapshot.shielded?.address ?? "";
  const copy = () =>
    void api.copy(address).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
      toast(ok ? "Shielded address copied." : "Could not copy. Select the address instead.", ok ? "done" : "caution");
    });
  return (
    <div class="receive">
      {!compact && (
        <p class="t-label" id="receive-label">
          Your shielded address
        </p>
      )}
      <p class="address-full is-shielded receive__address" aria-label="Your shielded address">
        {groupAddress(address)}
      </p>
      <button class={`btn ${compact ? "btn--secondary btn--sm" : "btn--primary"}`} type="button" onClick={copy}>
        <Icon name={copied ? "check" : "copy"} />
        {copied ? "Copied" : "Copy address"}
      </button>
      <p class="t-small">Give it to whoever pays you from their own Loch. The payment shows up here after the next sync.</p>
      {!compact && (
        <>
          <p class="observer">
            <span class="observer__label">An observer sees</span> a proof and a fee when someone pays you. Nothing in it points to you.
          </p>
          <p class="notice notice--inline">
            <Icon name="info" />
            <span>The address is the same every time: two people who compare the addresses they pay can tell it is one person.</span>
          </p>
          <PaymentCodeBlock api={api} toast={toast} />
          <CollectBlock api={api} snapshot={snapshot} />
        </>
      )}
    </div>
  );
}

const CLAIM_PROBLEM: Record<Exclude<ClaimCheck, { ok: true }>["reason"], string> = {
  empty: "Paste the link.",
  "not-a-code": "This is not a claim link. One ends in a code that starts with lochclaim1.",
  checksum: "There is an error in it: its checksum does not match. Copy the link again.",
};

/**
 * Collecting a claim link: the payment someone made to a link is moved into this wallet's
 * shielded balance. Once started it is a flow like the others, and its sheet takes over.
 */
function CollectBlock({ api, snapshot }: { api: Api; snapshot: Snapshot }) {
  const [text, setText] = useState("");
  const [check, setCheck] = useState<ClaimCheck | null>(null);
  const [failed, setFailed] = useState(false);
  const { quote } = useQuote(api, "spend");
  useEffect(() => {
    if (text.trim() === "") {
      setCheck(null);
      return;
    }
    let live = true;
    void api.call<ClaimCheck>({ loch: "ui", type: "claim-check", code: text }).then((reply) => {
      if (live && reply.ok) setCheck(reply.value);
    });
    return () => {
      live = false;
    };
  }, [api, text]);
  const fee = quote?.relayer ? BigInt(quote.relayer.fee) : null;
  const amount = check?.ok ? BigInt(check.amount) : null;
  const tooSmall = amount !== null && fee !== null && amount <= fee;
  const aboveLimit = fee !== null && fee > BigInt(snapshot.settings.maxFeeLamports);
  const ready = amount !== null && fee !== null && !tooSmall && !aboveLimit;
  const collect = async () => {
    if (!ready || fee === null) return;
    setFailed(false);
    const reply = await api.call({ loch: "ui", type: "claim", code: text, fee: fee.toString() });
    if (reply.ok) setText("");
    else setFailed(true);
  };
  const error = check && !check.ok ? CLAIM_PROBLEM[check.reason] : tooSmall ? "The link holds less than the relayer’s fee for collecting it." : aboveLimit ? "The relayer’s fee is above your limit. Raise it or choose another relayer in settings." : failed ? "Loch could not start this. Finish what is in progress and try again." : null;
  return (
    <section class="receive__code" aria-labelledby="collect-title">
      <h3 class="t-label" id="collect-title">
        A claim link, from someone who paid you
      </h3>
      <p class="t-small">Paste the link they sent. The payment in it moves to your shielded balance; the relayer&rsquo;s fee comes out of it.</p>
      <Field label="Claim link" id="collect-link" error={error}>
        <textarea
          class="input"
          id="collect-link"
          rows={3}
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          placeholder="https://lochlayer.com/claim#lochclaim1…"
          value={text}
          aria-invalid={error ? "true" : undefined}
          onInput={(event) => setText(event.currentTarget.value.replace(/\s+/g, ""))}
        />
      </Field>
      {amount !== null && (
        <dl class="deflist deflist--kv">
          <div class="deflist__row">
            <dt>In the link</dt>
            <dd>
              <Amount lamports={amount} shielded exact /> SOL
            </dd>
          </div>
          <div class="deflist__row">
            <dt>Relayer fee</dt>
            <dd>{fee !== null ? <Amount lamports={fee} exact /> : <span class="t-quiet">{quote === null ? "Asking the relayer" : "Not known"}</span>}{fee !== null && " SOL"}</dd>
          </div>
          {fee !== null && amount > fee && (
            <div class="deflist__row">
              <dt>Arrives in your shielded balance</dt>
              <dd>
                <Amount lamports={amount - fee} shielded exact /> SOL
              </dd>
            </div>
          )}
        </dl>
      )}
      {check?.ok && check.own && (
        <p class="notice notice--inline">
          <Icon name="info" />
          <span>You made this link. Collecting it takes the payment back, less one relayer fee.</span>
        </p>
      )}
      <div class="receive__actions">
        <button class="btn btn--primary" type="button" aria-disabled={ready ? undefined : "true"} onClick={() => void collect()}>
          {check?.ok && check.own ? "Take it back" : "Collect"}
        </button>
      </div>
    </section>
  );
}

/**
 * The viewing key: shown only when asked for, with what it gives away said first. Nothing is
 * kept here: closing the view forgets it.
 */
function ViewingKeySection({ api, toast, unlocked }: { api: Api; toast: ToastFn; unlocked: boolean }) {
  const [key, setKey] = useState<string | null>(null);
  const show = async () => {
    const reply = await api.call<ViewingKeyReply>({ loch: "ui", type: "viewing-key" });
    if (reply.ok) setKey(reply.value.key);
    else toast("Unlock the wallet to see its viewing key.", "caution");
  };
  return (
    <section class="settings__section" aria-labelledby="set-viewing">
      <h3 class="settings__title" id="set-viewing">
        Viewing key
      </h3>
      <p class="t-small">
        For an accountant or an auditor. Whoever holds it sees every payment this wallet receives, with its amount: payments from others, your own deposits and your change, past and future. They cannot spend, and they cannot see which notes you have spent, so not your balance or what you paid out.
      </p>
      <p class="notice notice--inline">
        <Icon name="caution" />
        <span>It cannot be taken back. Once someone has it, they can read what this wallet receives for as long as the wallet exists. For one payment, give a receipt instead.</span>
      </p>
      {key && (
        <p class="address-full is-shielded receive__address" aria-label="Your viewing key">
          {groupAddress(key)}
        </p>
      )}
      <div class="cluster">
        {key ? (
          <>
            <button class="btn btn--secondary btn--sm" type="button" onClick={() => void api.copy(key).then((ok) => toast(ok ? "Viewing key copied." : "Could not copy. Select the key instead.", ok ? "done" : "caution"))}>
              <Icon name="copy" small />
              Copy viewing key
            </button>
            <button class="btn btn--quiet btn--sm" type="button" onClick={() => setKey(null)}>
              Hide
            </button>
          </>
        ) : (
          <button class="btn btn--secondary btn--sm" type="button" disabled={!unlocked} onClick={() => void show()}>
            Show viewing key
          </button>
        )}
      </div>
      <p class="t-fine">They read it at {VERIFY_PAGE}, or with the SDK.</p>
    </section>
  );
}

/**
 * A depth proof: at least this much, answering the challenge of whoever asked. The amount is
 * public once the proof is handed over, so it is entered and shown upright. Nothing is kept
 * here: the worker remembers only which notes were shown, to warn before surfacing from them.
 */
export function DepthProofSection({ api, toast, unlocked }: { api: Api; toast: ToastFn; unlocked: boolean }) {
  const [amountText, setAmountText] = useState("");
  const [challenge, setChallenge] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [made, setMade] = useState<DepthProofReply | null>(null);
  const parsed = parseAmountInput(amountText);
  const challengeBytes = new TextEncoder().encode(challenge.normalize("NFC").trim()).length;
  const challengeError = challengeBytes === 0 ? DEPTH_COPY.challengeEmpty : challengeBytes > 128 ? DEPTH_COPY.challengeLong : null;
  const ready = parsed.ok && challengeError === null && unlocked && !busy;
  const make = async () => {
    setTouched(true);
    if (!ready || !parsed.ok) return;
    setBusy(true);
    setFailure(null);
    const reply = await api.call<DepthProofReply>({ loch: "ui", type: "depth-proof", threshold: parsed.lamports.toString(), challenge });
    setBusy(false);
    if (reply.ok) setMade(reply.value);
    else setFailure(depthErrorText(reply.error.code));
  };
  const copy = (text: string, what: string) => void api.copy(text).then((ok) => toast(ok ? `${what} copied.` : "Could not copy. Select it instead.", ok ? "done" : "caution"));
  return (
    <section class="settings__section" aria-labelledby="set-depth">
      <h3 class="settings__title" id="set-depth">
        {DEPTH_COPY.title}
      </h3>
      <p class="t-small">{DEPTH_COPY.lede}</p>
      {made ? (
        <>
          <p class="address-full receive__address" aria-label={DEPTH_COPY.codeLabel}>
            {groupAddress(made.code)}
          </p>
          <p class="t-small" role="status">
            <Rich text={DEPTH_COPY.result(exactSol(BigInt(made.threshold)))} />
          </p>
          <div class="cluster">
            <button class="btn btn--secondary btn--sm" type="button" onClick={() => copy(made.link, "Link")}>
              <Icon name="copy" small />
              {DEPTH_COPY.copyLink}
            </button>
            <button class="btn btn--secondary btn--sm" type="button" onClick={() => copy(made.code, "Proof")}>
              <Icon name="copy" small />
              {DEPTH_COPY.copyCode}
            </button>
            <button class="btn btn--quiet btn--sm" type="button" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
          <p class="t-fine">{DEPTH_COPY.checkAt}</p>
        </>
      ) : (
        <>
          <AmountField
            id="depth-amount"
            label={DEPTH_COPY.amountLabel}
            value={amountText}
            shielded={false}
            onInput={(value) => {
              setAmountText(value);
              setTouched(true);
            }}
            error={touched && !parsed.ok ? amountProblemText(parsed.problem) : null}
            disabled={!unlocked}
          />
          <Field label={DEPTH_COPY.challengeLabel} id="depth-challenge" hint={DEPTH_COPY.challengeHint} error={touched ? challengeError : null}>
            <input
              class="input"
              id="depth-challenge"
              type="text"
              spellcheck={false}
              autocomplete="off"
              value={challenge}
              disabled={!unlocked}
              aria-invalid={touched && challengeError ? "true" : undefined}
              onInput={(event) => setChallenge(event.currentTarget.value)}
            />
          </Field>
          {failure && (
            <p class="field__error" role="alert">
              <Icon name="caution" />
              <span>{failure}</span>
            </p>
          )}
          <div class="cluster">
            <button class="btn btn--secondary btn--sm" type="button" aria-disabled={ready ? undefined : "true"} disabled={!unlocked} onClick={() => void make()}>
              {busy ? DEPTH_COPY.making : DEPTH_COPY.make}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Making a payment code: the address with a secret for one payer. Each press makes a new one,
 * and the worker counts it. Nothing is kept here: a code that was not copied is made again.
 */
function PaymentCodeBlock({ api, toast }: { api: Api; toast: ToastFn }) {
  const [made, setMade] = useState<PaymentCodeReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const make = async () => {
    setBusy(true);
    const reply = await api.call<PaymentCodeReply>({ loch: "ui", type: "payment-code" });
    setBusy(false);
    if (reply.ok) {
      setMade(reply.value);
      setCopied(false);
    } else toast("Could not make a payment code. Unlock the wallet and try again.", "caution");
  };
  const copy = () =>
    void api.copy(made?.code ?? "").then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
      toast(ok ? "Payment code copied." : "Could not copy. Select the code instead.", ok ? "done" : "caution");
    });
  return (
    <section class="receive__code" aria-labelledby="receive-code-title">
      <h3 class="t-label" id="receive-code-title">
        A payment code, for one payer
      </h3>
      <p class="t-small">
        Your address with a secret added. What that payer sends you stays unreadable even to someone who records the chain today and breaks today&rsquo;s encryption later, which is what a quantum computer could do. A payment to the plain address does not.
      </p>
      {made && (
        <>
          <p class="address-full is-shielded receive__address" aria-label="Your payment code">
            {groupAddress(made.code)}
          </p>
          {made.status === "limit" && (
            <p class="notice notice--inline">
              <Icon name="info" />
              <span>Twenty codes are waiting to be paid, so no new one was made. This is the newest of them: use it again, or make another once one of them has been paid.</span>
            </p>
          )}
        </>
      )}
      <div class="receive__actions">
        {made && (
          <button class="btn btn--primary" type="button" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} />
            {copied ? "Copied" : "Copy code"}
          </button>
        )}
        <button class={`btn ${made ? "btn--secondary" : "btn--primary"}`} type="button" aria-busy={busy ? "true" : undefined} onClick={() => void make()}>
          {made ? "Make another" : "Make a payment code"}
        </button>
      </div>
      {made && (
        <p class="t-small">
          Send it to that one person, privately, and make another for the next. The code is a secret: someone who has it and can also break today&rsquo;s encryption could read what was paid to it. Nobody can spend with it.
        </p>
      )}
    </section>
  );
}

export function ReceiveView({ snapshot, api, onClose, toast }: ViewProps & { toast: ToastFn }) {
  return (
    <>
      <ViewHead title="Receive privately" onClose={onClose} />
      {snapshot.shielded ? (
        <ReceiveBlock snapshot={snapshot} api={api} toast={toast} />
      ) : (
        <div class="empty">
          <p class="empty__title">Locked</p>
          <p>Unlock the wallet to see its shielded address.</p>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ leak report

function Chart({ draw, deps, className }: { draw: (width: number) => string; deps: unknown[]; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const figure = ref.current;
    if (!figure) return;
    const measure = () => setWidth(Math.floor(figure.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(figure);
    return () => observer.disconnect();
  }, []);
  // The helpers return markup they escape themselves: no script, no handler, no outside reference.
  return <figure class={`chart ${className ?? ""}`} ref={ref} dangerouslySetInnerHTML={{ __html: width > 0 ? draw(width) : "" }} data-deps={deps.length} />;
}

export function ReportView({ snapshot, api, onClose }: ViewProps) {
  const { scan } = snapshot;
  const address = snapshot.active ?? "";
  const wasRunning = useRef(false);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (scan.status === "running") wasRunning.current = true;
    else if (scan.status === "done" && wasRunning.current) {
      wasRunning.current = false;
      setFresh(true);
    }
  }, [scan.status]);

  const start = () => void api.call({ loch: "ui", type: "scan-start" });
  const cancel = () => void api.call({ loch: "ui", type: "scan-cancel" });
  const locked = snapshot.shielded === null;
  const rpcHost = new URL(snapshot.settings.rpcUrl).host;
  const rpcNote = (
    <p class="notice notice--inline">
      <Icon name="info" />
      <span>
        A scan reads this wallet&rsquo;s public history from your RPC endpoint ({rpcHost}), which thereby learns which address you looked at. Do not scan right before or after a private spend: the endpoint could put the two together.{" "}
        {snapshot.settings.ohttp.enabled ? "Requests go through your Oblivious HTTP relay." : "Use your own node or a no-log endpoint if that matters."}
      </span>
    </p>
  );

  if (scan.status === "running") {
    const progress = scan.progress ?? { fetched: 0, total: 0, skipped: 0 };
    const fraction = progress.total > 0 ? progress.fetched / progress.total : 0;
    return (
      <>
        <ViewHead title={`Leak report for ${shortAddress(address)}`} onClose={onClose} />
        <div class="progress" style={{ "--progress": String(fraction) }} role="group" aria-label="Scanning">
          <div class="progress__line" aria-hidden="true">
            <span />
          </div>
          <p class="progress__status" role="status">
            <span>{progress.total > 0 ? `Reading ${progress.total} transactions from your RPC endpoint.` : "Asking your RPC endpoint for this wallet’s recent transactions."}</span>
            <span class="fig">{progress.total > 0 ? `${progress.fetched} of ${progress.total}` : ""}</span>
          </p>
        </div>
        <div class="cluster">
          <button class="btn btn--secondary" type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
        {rpcNote}
      </>
    );
  }

  const report = scan.report;
  if (!report) {
    return (
      <>
        <ViewHead title={`Leak report for ${shortAddress(address)}`} onClose={onClose} />
        {scan.status === "failed" ? (
          <div class="failure" role="alert">
            <p class="failure__title">
              <Icon name="caution" />
              {scan.error === "mainnet" ? "This endpoint is Solana mainnet" : scan.error === "interrupted" ? "The scan was interrupted" : "The scan did not finish"}
            </p>
            <p>
              {scan.error === "mainnet"
                ? "Loch v0.1 works on devnet only. Set a devnet RPC endpoint in settings."
                : scan.error === "interrupted"
                  ? "The browser stopped the extension while it was reading. Nothing was kept. Scan again."
                  : "The RPC endpoint stopped answering. Nothing was kept. Check the endpoint in settings, then scan again."}
            </p>
            {scan.error && scan.error !== "mainnet" && scan.error !== "interrupted" && <p class="failure__detail">{scan.error}</p>}
            <button class="btn btn--primary" type="button" onClick={start} disabled={locked}>
              Scan this wallet
            </button>
          </div>
        ) : (
          <div class="empty">
            <p class="empty__title">{scan.status === "cancelled" ? "The scan was cancelled" : "No scan yet"}</p>
            <p>A scan reads the last 300 transactions of your public wallet and shows what they give away: who funded it, who it pays, when you are awake. Loch then warns you before a public transfer adds to it.</p>
            <button class="btn btn--primary" type="button" onClick={start} disabled={locked}>
              <Icon name="scan" />
              Scan this wallet
            </button>
            {locked && <p>Unlock the wallet first: the result is stored encrypted.</p>}
          </div>
        )}
        {rpcNote}
      </>
    );
  }

  const flows = scan.flows ?? [];
  const wide = !api.popup;
  const meta = (
    <p class="t-fine report-view__meta">
      {report.scannedTransactions} {report.scannedTransactions === 1 ? "transaction" : "transactions"} read, {report.transfers} {report.transfers === 1 ? "transfer" : "transfers"}.{" "}
      {scan.scannedAt ? `Scanned ${whenText(scan.scannedAt, api.now())}.` : ""} Loch uses this history to warn you before a public transfer.
    </p>
  );
  const again = (
    <div class="cluster">
      <button class="btn btn--secondary" type="button" onClick={start} disabled={locked}>
        <Icon name="refresh" />
        Take the soundings again
      </button>
    </div>
  );
  const skipped = (scan.skipped ?? 0) > 0 && (
    <p class="notice notice--inline notice--caution">
      <Icon name="caution" />
      <span>
        {scan.skipped} {scan.skipped === 1 ? "transaction" : "transactions"} could not be read from the RPC endpoint. The score covers only what was read and is incomplete.
      </span>
    </p>
  );
  const stale = scan.status === "failed" && (
    <p class="notice notice--inline notice--caution">
      <Icon name="caution" />
      <span>The last scan did not finish, so this is the report from before. {scan.error && scan.error !== "interrupted" ? scan.error : ""}</span>
    </p>
  );
  const bed = <Chart className="report-view__bed" deps={[report.score, fresh]} draw={(width) => steppedBedSvg(report, { width: Math.min(width, 757), id: "bed", animate: fresh })} />;
  const statement = (
    <div dangerouslySetInnerHTML={{ __html: statementHtml(report, { detail: true, totalNote: "What helps: a fresh address for each payer, no forwarding of exact amounts, and savings kept in a shielded balance." }) }} />
  );

  if (wide) {
    return (
      <div class="statement-wrap report-view">
        <ViewHead title={`Leak report for ${shortAddress(address)}`} />
        <div class="report-view__top">
          <div class="score">
            <p class="score__label">Privacy score</p>
            <p class="score__figure">
              <span class="figure figure--xl is-public">{report.score}</span>
              <span class="score__of">of 100</span>
            </p>
            <p class="score__verdict">{verdict(report.score)}</p>
            {meta}
          </div>
          <div class="report-view__chart">
            {bed}
            <p class="chart__caption">A wallet with no leaks sits 100 deep, out of sight. Each finding takes depth away; the hatching is what it cost. Where the bed ends up is the score.</p>
            {again}
          </div>
        </div>
        {skipped}
        {stale}
        {statement}
        {flows.length > 0 && (
          <div class="report-view__figures">
            <div>
              <Chart deps={[flows.length]} draw={(width) => byHourSvg(flows, { width: Math.min(width, 568), id: "hours" })} />
              <p class="chart__caption">Transfers by hour of day, UTC. Deeper is busier. The shoal where almost nothing happens is when the owner sleeps.</p>
            </div>
            <div>
              <Chart deps={[flows.length]} draw={(width) => counterpartiesSvg(flows, { width: Math.min(width, 568), id: "who", max: 5 })} />
              <p class="chart__caption">Who this wallet deals with. A heavier line is more transfers.</p>
            </div>
          </div>
        )}
        {rpcNote}
      </div>
    );
  }

  return (
    <div class="statement-wrap report-view">
      <ViewHead title={`Leak report for ${shortAddress(address)}`} onClose={onClose} />
      {bed}
      <p class="t-small report-view__verdict">{verdict(report.score)}</p>
      {skipped}
      {statement}
      {meta}
      {again}
      {stale}
      {rpcNote}
    </div>
  );
}

// --------------------------------------------------------------------- settings

type EndpointKey = "rpcUrl" | "relayerUrl" | "screenerUrl" | "connectUrl";

const ENDPOINTS: { key: EndpointKey; label: string; hint: string }[] = [
  { key: "rpcUrl", label: "RPC endpoint", hint: "Reads the chain and sends your deposits. It sees your IP address, and your public address when you dive in, read your public balance or scan. A sync does not name your address." },
  { key: "relayerUrl", label: "Relayer", hint: "Submits private transfers and withdrawals and is paid a fee from the shielded amount. It sees your IP address." },
  { key: "screenerUrl", label: "Screening service", hint: "Co-signs deposits. It sees your public address and the amount." },
  {
    key: "connectUrl",
    label: "Connect page",
    hint: "The one page Loch opens to reach your wallet. Your wallet is asked there for the signature that unlocks your shielded balance, so it must be a page that serves nothing else. Changing it asks you to confirm.",
  },
];

/** What the settings say about the key exchange requests to the gateway use. */
const OHTTP_KEM_NOTE: Record<string, string> = {
  "X-Wing": "Key exchange: X-Wing, which a recording of these requests does not open even if X25519 is broken later.",
  X25519: "Key exchange: X25519 only. A recording of these requests could be opened by a quantum computer later. Ask the gateway’s operator for a key configuration with an X-Wing key.",
};

const ENDPOINT_PROBLEM: Record<string, string> = {
  empty: "Enter an address.",
  "not-a-url": "That is not a web address. It should look like https://rpc.example.org",
  scheme: "The address must start with https://",
  insecure: "Plain http is only accepted for this machine (127.0.0.1 or localhost). Use https://",
  credentials: "Remove the user name and password from the address. Settings are stored unencrypted.",
  fragment: "Remove the part after #.",
  query: "Remove the part after ?. The connect page is one exact address.",
  confirm: "The connect page was not changed: the change was not confirmed. Save again and confirm it.",
  fixed: "The connect page is fixed in this build and cannot be changed.",
  range: "Enter a fee between 0 and 1 SOL.",
  relay: "Enter the relay\u2019s address first.",
  "same-origin": "The relay and the RPC endpoint are the same address, so one party would see both who asks and what is asked. Use a relay run by someone else.",
  "key-config": "That is not a key configuration. Paste the content of the gateway\u2019s /ohttp-keys as hex or base64.",
  "key-config-url": "That is an address. Loch does not fetch the key configuration, because whoever serves it could swap the key. Paste its content, as hex or base64.",
  unusable: "This key configuration offers no algorithm Loch can use.",
  pin: "The key configuration does not carry the pinned key. One of the two is wrong; do not go on until they agree.",
};

export function SettingsView({ snapshot, api, onClose, toast }: ViewProps & { toast: ToastFn }) {
  const { settings } = snapshot;
  const [values, setValues] = useState({ rpcUrl: settings.rpcUrl, relayerUrl: settings.relayerUrl, screenerUrl: settings.screenerUrl, connectUrl: settings.connectUrl });
  const [maxFee, setMaxFee] = useState(inputSol(BigInt(settings.maxFeeLamports)));
  const [ohttp, setOhttp] = useState({ relayUrl: settings.ohttp.relayUrl, keyConfig: settings.ohttp.keyConfig, pinnedKey: settings.ohttp.pinnedKey });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmForget, setConfirmForget] = useState(false);
  /** The connect page was changed in the form and Save was pressed: ask before it is sent. */
  const [confirmConnect, setConfirmConnect] = useState(false);
  const endpoints = settings.connectFixed ? ENDPOINTS.filter(({ key }) => key !== "connectUrl") : ENDPOINTS;
  const active = snapshot.wallets.find((wallet) => wallet.address === snapshot.active);

  const patch = async (change: Record<string, unknown>, origins: string[] = []): Promise<boolean> => {
    if (origins.length > 0 && !(await api.requestAccess(origins))) {
      toast("The browser did not grant access to that address, so it was not saved.", "caution");
      return false;
    }
    const reply = await api.call({ loch: "ui", type: "settings", patch: change });
    if (!reply.ok) {
      const [field, problem] = reply.error.message.split(":");
      setErrors({ [field ?? "form"]: ENDPOINT_PROBLEM[problem ?? ""] ?? "That value was not accepted." });
      return false;
    }
    setErrors({});
    return true;
  };

  const saveEndpoints = async (connectConfirmed = false) => {
    const origins: string[] = [];
    for (const key of ["rpcUrl", "relayerUrl", "screenerUrl"] as const) {
      try {
        if (values[key] !== settings[key]) origins.push(new URL(values[key]).origin);
      } catch {
        setErrors({ [key]: ENDPOINT_PROBLEM["not-a-url"]! });
        return;
      }
    }
    const fee = parseAmountInput(maxFee);
    if (!fee.ok && maxFee.trim() !== "0") {
      setErrors({ maxFeeLamports: ENDPOINT_PROBLEM.range! });
      return;
    }
    const connectChanged = !settings.connectFixed && values.connectUrl.trim() !== settings.connectUrl;
    if (connectChanged && !connectConfirmed) {
      // Not sent yet. The service worker refuses the change as well unless it comes confirmed.
      setConfirmConnect(true);
      return;
    }
    setConfirmConnect(false);
    const change: Record<string, unknown> = { rpcUrl: values.rpcUrl, relayerUrl: values.relayerUrl, screenerUrl: values.screenerUrl, maxFeeLamports: fee.ok ? fee.lamports.toString() : "0" };
    if (connectChanged) {
      change.connectUrl = values.connectUrl;
      change.confirmConnectUrl = values.connectUrl;
    }
    if (await patch(change, origins)) toast("Settings saved.", "done");
  };

  const saveOhttp = async (enabled: boolean) => {
    const origins: string[] = [];
    try {
      if (ohttp.relayUrl.trim() !== "") origins.push(new URL(ohttp.relayUrl).origin);
    } catch {
      setErrors({ "ohttp.relayUrl": ENDPOINT_PROBLEM["not-a-url"]! });
      return;
    }
    if (await patch({ ohttp: { ...ohttp, enabled } }, enabled ? origins : [])) toast(enabled ? "RPC requests now go through the relay." : "Oblivious HTTP is off.", "done");
  };

  const changed = endpoints.some(({ key }) => values[key] !== settings[key]) || maxFee !== inputSol(BigInt(settings.maxFeeLamports));
  const artifacts = Object.entries(snapshot.build.artifacts);

  return (
    <div class="settings">
      <ViewHead title="Settings" onClose={onClose} />

      <section class="settings__section" aria-labelledby="set-endpoints">
        <h3 class="settings__title" id="set-endpoints">
          Endpoints
        </h3>
        <p class="t-fine">These are the only addresses Loch ever sends a request to. There is no telemetry.</p>
        <form
          class="stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void saveEndpoints();
          }}
        >
          {endpoints.map(({ key, label, hint }) => (
            <Field label={label} id={`set-${key}`} hint={hint} error={errors[key]} key={key}>
              <input
                class="input"
                id={`set-${key}`}
                type="url"
                inputMode="url"
                spellcheck={false}
                autocomplete="off"
                value={values[key]}
                aria-invalid={errors[key] ? "true" : undefined}
                aria-describedby={`set-${key}-hint${errors[key] ? ` set-${key}-error` : ""}`}
                onInput={(event) => {
                  setValues({ ...values, [key]: event.currentTarget.value });
                  if (key === "connectUrl") setConfirmConnect(false);
                }}
              />
            </Field>
          ))}
          {settings.connectFixed && (
            <p class="t-small">
              Connect page: <span title={settings.connectUrl}>{connectPlace(settings.connectUrl)}</span>. It is fixed in this build and cannot be changed.
            </p>
          )}
          <Field
            label="Largest relayer fee"
            id="set-maxfee"
            hint={`Loch refuses to prove a transaction whose fee is above this, whatever the relayer asks. Now ${exactSol(BigInt(settings.maxFeeLamports))} SOL.`}
            error={errors.maxFeeLamports}
          >
            <div class="input-group">
              <input
                class="input fig"
                id="set-maxfee"
                inputMode="decimal"
                autocomplete="off"
                value={maxFee}
                aria-invalid={errors.maxFeeLamports ? "true" : undefined}
                aria-describedby="set-maxfee-hint"
                onInput={(event) => setMaxFee(event.currentTarget.value)}
              />
              <span class="input-group__unit">SOL</span>
            </div>
          </Field>
          {confirmConnect ? (
            <div class="notice notice--caution" role="alertdialog" aria-labelledby="connect-title">
              <p class="notice__title" id="connect-title">
                <Icon name="caution" />
                Ask your wallet on {connectPlace(values.connectUrl)}?
              </p>
              <p>
                On the connect page your wallet is asked for the signature that unlocks your shielded balance. Whoever controls that page, or any script on it, can take the signature, and with it your shielded funds, for good.
              </p>
              <p>Use only a page you serve yourself, on an address that serves nothing else. An action that is already running keeps the page it started with.</p>
              <div class="notice__actions">
                <button
                  class="btn btn--secondary btn--sm"
                  type="button"
                  data-autofocus=""
                  onClick={() => {
                    setConfirmConnect(false);
                    setValues({ ...values, connectUrl: settings.connectUrl });
                  }}
                >
                  Keep the current page
                </button>
                <button class="btn btn--secondary btn--sm" type="button" onClick={() => void saveEndpoints(true)}>
                  Use this page
                </button>
              </div>
            </div>
          ) : (
            <div class="cluster">
              <button class="btn btn--primary" type="submit" aria-disabled={changed ? undefined : "true"}>
                Save endpoints
              </button>
            </div>
          )}
        </form>
      </section>

      <section class="settings__section" aria-labelledby="set-ohttp">
        <h3 class="settings__title" id="set-ohttp">
          RPC privacy
        </h3>
        <p class="t-fine">
          With an Oblivious HTTP relay, the relay sees your IP address and not your requests, and the RPC gateway sees your requests and not your IP address. They must be run by different parties.
        </p>
        {settings.ohttp.available ? (
          <div class="stack">
            <Field label="Oblivious relay" id="set-ohttp-relay" error={errors["ohttp.relayUrl"]} hint="Every RPC request is sent here, encrypted for the gateway.">
              <input
                class="input"
                id="set-ohttp-relay"
                type="url"
                spellcheck={false}
                autocomplete="off"
                value={ohttp.relayUrl}
                aria-describedby="set-ohttp-relay-hint"
                onInput={(event) => setOhttp({ ...ohttp, relayUrl: event.currentTarget.value })}
              />
            </Field>
            <Field label="Gateway key configuration" id="set-ohttp-key" error={errors["ohttp.keyConfig"]} hint="The content of the gateway&rsquo;s /ohttp-keys, as hex or base64, pasted here. Loch never fetches it. Get it from the gateway&rsquo;s operator, not from the relay.">
              <textarea class="input fig" id="set-ohttp-key" rows={2} spellcheck={false} value={ohttp.keyConfig} aria-describedby="set-ohttp-key-hint" onInput={(event) => setOhttp({ ...ohttp, keyConfig: event.currentTarget.value })} />
            </Field>
            <Field label="Pinned gateway key" id="set-ohttp-pin" optional error={errors["ohttp.pinnedKey"]} hint="The key&rsquo;s fingerprint, sha256: and 64 hex digits, as the gateway&rsquo;s operator publishes it. With a pin, a key configuration carrying any other key is refused. An X25519 key as 64 hex digits still works and keeps requests on X25519.">
              <input class="input fig" id="set-ohttp-pin" spellcheck={false} autocomplete="off" value={ohttp.pinnedKey} aria-describedby="set-ohttp-pin-hint" onInput={(event) => setOhttp({ ...ohttp, pinnedKey: event.currentTarget.value })} />
            </Field>
            <label class="choice">
              <input
                class="toggle"
                type="checkbox"
                role="switch"
                checked={settings.ohttp.enabled}
                disabled={ohttp.relayUrl.trim() === "" || ohttp.keyConfig.trim() === ""}
                onChange={(event) => void saveOhttp(event.currentTarget.checked)}
              />
              <span>
                Send RPC requests through the relay
                <small>{settings.ohttp.enabled ? `On. The RPC endpoint above is the gateway’s target. ${OHTTP_KEM_NOTE[settings.ohttp.kem ?? ""] ?? ""}` : "Off. Requests go straight to the RPC endpoint."}</small>
              </span>
            </label>
          </div>
        ) : (
          <p class="notice notice--inline">
            <Icon name="info" />
            <span>This build has no Oblivious HTTP client. Requests go straight to the RPC endpoint.</span>
          </p>
        )}
      </section>

      <section class="settings__section" aria-labelledby="set-look">
        <h3 class="settings__title" id="set-look">
          Palette
        </h3>
        <div class="segmented" role="radiogroup" aria-label="Palette">
          {(["dusk", "night"] as const).map((theme) => (
            <button role="radio" type="button" aria-checked={settings.theme === theme ? "true" : "false"} onClick={() => void patch({ theme })} key={theme}>
              {theme === "dusk" ? "Dusk" : "Night"}
            </button>
          ))}
        </div>
        <p class="t-fine">Dusk has buff land. Night turns the land dark. The water does not change.</p>
      </section>

      <section class="settings__section" aria-labelledby="set-wrapper">
        <h3 class="settings__title" id="set-wrapper">
          On websites
        </h3>
        <label class="choice">
          <input class="toggle" type="checkbox" role="switch" checked={settings.wrapperEnabled} onChange={(event) => void patch({ wrapperEnabled: event.currentTarget.checked })} />
          <span>
            Offer the Loch wallet to websites
            <small>
              Sites see a wallet named Loch that passes everything on to {active ? active.walletName : "your wallet"} after two checks: it warns before a public transfer that gives something away, and it does not pass on a request for your key-derivation signature. It never
              changes a transaction.
            </small>
          </span>
        </label>
        <p class="notice notice--inline">
          <Icon name="info" />
          <span>
            This helps on sites that behave. A site can always ask {active ? active.walletName : "your wallet"} directly, without Loch, and then the prompt of {active ? active.walletName : "your wallet"} itself is the only thing between the site and your signature. While this is on, any site can see that Loch is
            installed. Takes effect when a page is loaded again.
          </span>
        </p>
        <label class="choice">
          <input
            class="toggle"
            type="checkbox"
            role="switch"
            checked={settings.warnFirstRecipients}
            disabled={!settings.wrapperEnabled}
            onChange={(event) => void patch({ warnFirstRecipients: event.currentTarget.checked })}
          />
          <span>
            Also warn about first-time recipients
            <small>The warning interrupts for findings of medium severity or higher. With this on it also interrupts when a site pays an address this wallet has not paid before, which is true of most payments.</small>
          </span>
        </label>
      </section>

      {active && (
        <section class="settings__section" aria-labelledby="set-wallet">
          <h3 class="settings__title" id="set-wallet">
            This wallet on this device
          </h3>
          <p class="t-small">
            <span class="fig is-public">{shortAddress(active.address)}</span> with {active.walletName}. Its notes and activity are stored here encrypted with a key from your wallet&rsquo;s signature.
          </p>
          {confirmForget ? (
            <div class="notice notice--caution" role="alertdialog" aria-labelledby="forget-title">
              <p class="notice__title" id="forget-title">
                <Icon name="caution" />
                Forget {shortAddress(active.address)} on this device?
              </p>
              <p>This removes its keys, notes, activity and leak report from this browser. Your shielded balance stays on chain: connect the same wallet again and Loch finds it. The list of what you sent cannot be recovered.</p>
              <div class="notice__actions">
                <button class="btn btn--secondary btn--sm" type="button" onClick={() => setConfirmForget(false)} data-autofocus="">
                  Keep it
                </button>
                <button
                  class="btn btn--secondary btn--sm"
                  type="button"
                  onClick={() => {
                    void api.call({ loch: "ui", type: "forget", address: active.address }).then(() => {
                      setConfirmForget(false);
                      toast("Forgotten on this device. Nothing on chain changed.", "done");
                      onClose?.();
                    });
                  }}
                >
                  Forget this wallet
                </button>
              </div>
            </div>
          ) : (
            <div class="cluster">
              <button class="btn btn--secondary btn--sm" type="button" disabled={!active.unlocked} onClick={() => void api.call({ loch: "ui", type: "lock" }).then(() => toast("Locked."))}>
                Lock now
              </button>
              <button class="btn btn--secondary btn--sm" type="button" onClick={() => setConfirmForget(true)}>
                Forget this wallet on this device
              </button>
            </div>
          )}
        </section>
      )}

      {active && <DepthProofSection api={api} toast={toast} unlocked={active.unlocked} />}
      {active && <ViewingKeySection api={api} toast={toast} unlocked={active.unlocked} />}

      <section class="settings__section" aria-labelledby="set-about">
        <h3 class="settings__title" id="set-about">
          About
        </h3>
        <dl class="deflist deflist--kv">
          <div class="deflist__row">
            <dt>Version</dt>
            <dd>Loch {snapshot.version}, alpha</dd>
          </div>
          <div class="deflist__row">
            <dt>Network</dt>
            <dd>{mainnetTestingEnabled() ? "Mainnet. Real SOL." : "Devnet only. Mainnet is refused."}</dd>
          </div>
          {mainnetTestingEnabled() ? (
            <div class="deflist__row">
              <dt>Cautions</dt>
              <dd>lochlayer.com, under Cautions</dd>
            </div>
          ) : (
            <div class="deflist__row">
              <dt>Audit</dt>
              <dd class="t-caution">Unaudited. Never use real funds.</dd>
            </div>
          )}
          <div class="deflist__row">
            <dt>Proving key</dt>
            <dd>{snapshot.build.setup}</dd>
          </div>
          {artifacts.map(([name, artifact]) => (
            <div class="deflist__row" key={name}>
              <dt>{name}</dt>
              <dd>
                <span class="fig hash" title={`sha256 ${artifact.sha256}`}>
                  sha256 {artifact.sha256.slice(0, 16)}&hellip;
                </span>
              </dd>
            </div>
          ))}
          <div class="deflist__row">
            <dt>Telemetry</dt>
            <dd>None</dd>
          </div>
        </dl>
        <p class="t-fine">
          No analytics, no remote code, no remote fonts. Fonts: Old Standard TT and Libre Franklin, SIL Open Font License 1.1 (
          <a href={api.packaged("fonts/OFL-old-standard-tt.txt")} target="_blank" rel="noreferrer">
            licence
          </a>
          ,{" "}
          <a href={api.packaged("fonts/OFL-libre-franklin.txt")} target="_blank" rel="noreferrer">
            licence
          </a>
          ). Built with snarkjs (GPL-3.0), @solana/web3.js, Noble and Preact (MIT).{" "}
          <a href={api.packaged("licences.txt")} target="_blank" rel="noreferrer">
            All licences
          </a>
          .
        </p>
      </section>
    </div>
  );
}
