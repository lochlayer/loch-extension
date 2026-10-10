// The Loch interface. One app for the 380 x 600 popup and for the expanded view in a tab.
//
// Every surface is a section through the loch: land above one waterline holds what is public
// (the wallet, its balance, its privacy score), water below holds what is shielded. Upright
// lettering is public, italic is shielded.

import { useEffect, useState } from "preact/hooks";

import { displaySol } from "../shared/amounts.js";
import { mainnetTestingEnabled } from "../shared/build.js";
import { activityDelta, activityMeta, activityTitle, clockText, doneSentence, isPublicActivity, shortAddress } from "../shared/copy.js";
import type { ActivityEntry, PublicBalanceReply, Snapshot, SyncView } from "../shared/view.js";
import type { Api } from "./api.js";
import { FlowSheet, FormSheet, type FormKind, WalletsSheet } from "./flows.js";
import { Amount, Icon, type IconName, Sounding, Toasts } from "./parts.js";
import { useSnapshot, useToasts } from "./state.js";
import { ActivityView, ReceiveBlock, ReceiveView, ReportView, SettingsView } from "./views.js";

export type View = "home" | "activity" | "receive" | "report" | "settings";
type SheetName = FormKind | "wallets";

const ACTIVITY_ICON: Record<ActivityEntry["kind"], IconName> = {
  dive: "dive",
  send: "send",
  receive: "receive",
  surface: "surface",
  consolidate: "shielded",
  restored: "shielded",
  claim: "receive",
};

const CLUSTER_NAME = { devnet: "Devnet", testnet: "Testnet", localnet: "Localnet", "mainnet-beta": "Mainnet" } as const;

/** Why the public balance was not read, and when it can be. */
export function heldText(until: number): string {
  return `Not read now. Asking for your public balance next to a private spend would let the RPC endpoint link the two. It can be read after ${clockText(until)}.`;
}

export function unitOf(snapshot: Snapshot): string {
  const cluster = snapshot.cluster ?? (mainnetTestingEnabled() ? "mainnet-beta" : "devnet");
  return cluster === "mainnet-beta" ? "SOL" : `${cluster} SOL`;
}

/** The status that must not be missed. First on every surface, never dismissed, never dimmed. */
export function CautionBand({ snapshot }: { snapshot: Snapshot | null }) {
  if (mainnetTestingEnabled()) {
    // The mainnet package carries no band (the owner's decision, 2026-10-10): its cautions are on the website.
    return null;
  }
  if (snapshot?.cluster === "mainnet-beta") {
    return (
      <p class="caution-band" role="status">
        <strong>Mainnet refused.</strong> Loch v0.1 works on devnet only.
      </p>
    );
  }
  const name = snapshot?.cluster ? CLUSTER_NAME[snapshot.cluster] : "Devnet";
  return (
    <p class="caution-band" role="status">
      <strong>{name}.</strong> Test SOL only. Nothing here has real value.
    </p>
  );
}

function Brand() {
  return (
    <span class="brand brand--sm">
      <img src="icons/mascot.svg" width="24" height="24" alt="" />
      <span class="brand__name">Loch</span>
    </span>
  );
}

export function ActivityRow({ entry, now }: { entry: ActivityEntry; now: number }) {
  const shielded = !isPublicActivity(entry);
  const pending = entry.status === "submitted" || entry.status === "unknown";
  return (
    <>
      <Icon name={ACTIVITY_ICON[entry.kind]} />
      <span class="activity__main">
        <span class="activity__title">{activityTitle(entry)}</span>
        <span class="activity__meta">{activityMeta(entry, now)}</span>
      </span>
      <span class={`activity__amount fig${entry.status === "failed" ? " is-void" : ""}`} data-pending={pending ? "" : undefined}>
        <Sign lamports={activityDelta(entry)} />
      </span>
      {/* The row's own class sets the slope; this only helps a reader that cannot see it. */}
      <span class="visually-hidden">{shielded ? "Shielded." : "Public."}</span>
    </>
  );
}

function Sign({ lamports }: { lamports: bigint }) {
  const text = displaySol(lamports, "always");
  return (
    <>
      <span class="fig-sign">{text.slice(0, 1)}</span>
      {text.slice(1)}
    </>
  );
}

function SyncStatus({ sync, onSync }: { sync: SyncView; onSync: () => void }) {
  const caution = sync.status === "unreachable" || sync.status === "mainnet" || sync.status === "failed";
  const text =
    sync.status === "syncing"
      ? "Syncing"
      : sync.status === "synced"
        ? `Synced ${sync.at ? clockText(sync.at) : ""}`.trim()
        : sync.status === "behind"
          ? `${sync.behind ?? 1} behind, catching up`
          : sync.status === "unreachable"
            ? "Cannot reach RPC"
            : sync.status === "mainnet"
              ? "Mainnet refused"
              : sync.status === "failed"
                ? "Sync failed"
                : "Not synced yet";
  const title =
    sync.status === "unreachable" || sync.status === "failed"
      ? `${sync.detail ?? "The RPC endpoint did not answer."} ${sync.at ? `This is the state as of ${clockText(sync.at)}.` : ""} Press to try again.`
      : sync.status === "behind"
        ? "The pool is busy. This state is verified and a few transactions old. Press to sync again."
        : "Press to sync with the chain now.";
  return (
    <button class={`link link--quiet ${caution ? "link--caution" : "fig"}`} type="button" onClick={onSync} title={title} aria-busy={sync.status === "syncing" ? "true" : undefined} data-status={sync.status}>
      {caution && <Icon name="caution" />}
      {text}
    </button>
  );
}

/** The public balance and when it was read. It is read when the user asks, never by itself. */
function PublicBalance({ snapshot, onRead }: { snapshot: Snapshot; onRead: () => Promise<void> }) {
  const [reading, setReading] = useState(false);
  const read = snapshot.publicBalance !== null;
  const at = snapshot.publicBalanceAt;
  const press = () => {
    if (reading) return;
    setReading(true);
    void onRead().finally(() => setReading(false));
  };
  return (
    <div class="balance balance--public">
      <div class="balance__row">
        <p class="balance__label">Public balance</p>
        <button
          class="link link--quiet fig"
          type="button"
          onClick={press}
          aria-busy={reading ? "true" : undefined}
          aria-label={read ? `Read ${at ? `at ${clockText(at)}` : "earlier"}. Read the public balance again` : "Read the public balance"}
          title="Asks your RPC endpoint for this address’s balance. That request names your public address, so Loch makes it only when you ask, and not next to a private spend."
        >
          {reading ? "Reading" : read ? (at ? `at ${clockText(at)}` : "Read again") : "Read"}
        </button>
      </div>
      <p class="balance__figure">
        {snapshot.publicBalance === null ? (
          <span class="figure is-public is-unsurveyed" role="img" aria-label="Not read yet" />
        ) : (
          <span class="figure is-public" title={`${displaySol(BigInt(snapshot.publicBalance))} SOL, anyone can see it`}>
            {displaySol(BigInt(snapshot.publicBalance))}
          </span>
        )}
        <span class="fig-unit">SOL</span>
      </p>
    </div>
  );
}

function Land({ snapshot, onWallets, onReport, onReadBalance }: { snapshot: Snapshot; onWallets: () => void; onReport: () => void; onReadBalance: () => Promise<void> }) {
  const wallet = snapshot.wallets.find((item) => item.address === snapshot.active);
  const report = snapshot.scan.report;
  return (
    <>
      <header class="popup__head">
        <Brand />
        {wallet && (
          <button class="address-chip" type="button" onClick={onWallets} aria-label={`Connected wallet: ${wallet.walletName}, ${shortAddress(wallet.address)}. Wallets and settings`}>
            <span class="address-chip__name">{wallet.walletName}</span>
            <span class="address-chip__text fig">{shortAddress(wallet.address)}</span>
            <Icon name="chevron" small />
          </button>
        )}
      </header>
      <div class="popup__public">
        <PublicBalance snapshot={snapshot} onRead={onReadBalance} />
        <a
          class="score score--inline"
          href="#report"
          onClick={(event) => {
            event.preventDefault();
            onReport();
          }}
          aria-label={report ? `Privacy score ${report.score} of 100. Open the leak report` : "No leak scan yet. Scan this wallet"}
        >
          <span class="score__label">Privacy score</span>
          <span class="score__figure">
            {report ? (
              <>
                <span class="figure is-public">{report.score}</span>
                <span class="score__of">of 100</span>
                <span class="score__link">Leak report</span>
              </>
            ) : (
              <span class="score__link">Scan this wallet</span>
            )}
          </span>
        </a>
      </div>
    </>
  );
}

function Legend() {
  return (
    <p class="popup__foot legend">
      <span>Upright is public on-chain.</span>
      <span class="is-shielded">Italic is shielded.</span>
    </p>
  );
}

function Home({ snapshot, api, go, open, toast }: { snapshot: Snapshot; api: Api; go: (view: View) => void; open: (sheet: SheetName) => void; toast: (text: string, kind?: "done" | "caution" | "plain") => void }) {
  const shielded = snapshot.shielded;
  const wallet = snapshot.wallets.find((item) => item.address === snapshot.active);
  const now = api.now();
  // A flow or a network refusal prevents another action from starting.
  const busy = (snapshot.flow !== null && (snapshot.flow.status === "running" || snapshot.flow.status === "waiting")) || snapshot.sync.status === "mainnet";
  const sync = () => void api.call({ loch: "ui", type: "sync" });

  if (!shielded) {
    // The wallet is known and locked: its data is on this device, encrypted.
    return (
      <>
        <div class="popup__water water" data-depth="60">
          <section class="balance balance--shielded" aria-label="Shielded balance">
            <div class="balance__row">
              <p class="balance__label">Shielded balance</p>
            </div>
            <p class="balance__figure">
              <span class="sounding is-unsurveyed" role="img" aria-label="Locked" />
              <span class="fig-unit">{unitOf(snapshot)}</span>
            </p>
            <p class="balance__note">Locked. One signature from {wallet?.walletName ?? "your wallet"} unlocks it.</p>
          </section>
          <button class="btn btn--primary btn--block" type="button" disabled={busy} onClick={() => wallet && void api.call({ loch: "ui", type: "unlock", address: wallet.address })}>
            Unlock
          </button>
        </div>
        <section class="popup__deep water" data-depth="120" aria-label="Recent activity">
          <div class="popup__deep-head">
            <h2>Recent activity</h2>
          </div>
          <div class="empty">
            <p class="empty__title">Kept encrypted</p>
            <p>Your balance and activity are stored on this device, encrypted. Unlocking asks your wallet for the same signature as the first time. It moves nothing.</p>
          </div>
          <Legend />
        </section>
      </>
    );
  }

  const balance = BigInt(shielded.balance);
  const empty = balance === 0n && snapshot.activity.length === 0;
  const canSpend = BigInt(shielded.spendable) > 0n;
  const recent = snapshot.activity.slice(0, 4);
  return (
    <>
      <div class="popup__water water" data-depth="60">
        <section class="balance balance--shielded" aria-label="Shielded balance">
          <div class="balance__row">
            <p class="balance__label">Shielded balance</p>
            <SyncStatus sync={snapshot.sync} onSync={sync} />
          </div>
          <p class="balance__figure">
            <Sounding lamports={balance} />
            <span class="fig-unit">{unitOf(snapshot)}</span>
          </p>
          <div class="balance__row">
            <p class="balance__note">
              {shielded.settling > 0
                ? `${shielded.settling === 1 ? "One transfer is" : `${shielded.settling} transfers are`} still settling.`
                : balance === 0n
                  ? "Nothing in the Loch yet."
                  : "In the Loch. Visible only to you."}
            </p>
            {api.popup && (
              <a
                class="link link--quiet"
                href="#receive"
                onClick={(event) => {
                  event.preventDefault();
                  go("receive");
                }}
              >
                Receive
              </a>
            )}
          </div>
        </section>
        <div class="popup__actions">
          <button class={`btn ${canSpend ? "btn--secondary" : "btn--primary"} btn--stacked`} type="button" disabled={busy} onClick={() => open("dive")}>
            <Icon name="dive" />
            Dive in
          </button>
          <button class={`btn ${canSpend ? "btn--primary" : "btn--secondary"} btn--stacked`} type="button" disabled={busy || !canSpend} onClick={() => open("send")}>
            <Icon name="send" />
            Send privately
          </button>
          <button class="btn btn--secondary btn--stacked" type="button" disabled={busy || !canSpend} onClick={() => open("surface")}>
            <Icon name="surface" />
            Surface
          </button>
        </div>
      </div>
      {api.popup ? (
        <section class="popup__deep water" data-depth="120" aria-label="Recent activity">
          <div class="popup__deep-head">
            <h2>Recent activity</h2>
            {!empty && (
              <a
                href="#activity"
                onClick={(event) => {
                  event.preventDefault();
                  go("activity");
                }}
              >
                All activity
              </a>
            )}
          </div>
          {recent.length === 0 ? (
            <div class="empty">
              <p class="empty__title">No activity yet</p>
              <p>Dive in to move test SOL from your public wallet into your shielded balance. The deposit is public. What you do after it is not.</p>
            </div>
          ) : (
            <ul class="activity">
              {recent.map((entry) => (
                <li class={`activity__row ${isPublicActivity(entry) ? "is-public" : "is-shielded"}`} data-state={entry.status === "confirmed" ? undefined : "pending"} key={entry.id}>
                  <ActivityRow entry={entry} now={now} />
                </li>
              ))}
            </ul>
          )}
          <Legend />
        </section>
      ) : (
        // Beside the panel there is room to keep the address to receive at in view.
        <section class="popup__deep water" data-depth="120" aria-label="Receive privately">
          <div class="popup__deep-head">
            <h2>Receive privately</h2>
          </div>
          <ReceiveBlock snapshot={snapshot} api={api} toast={toast} compact />
          <Legend />
        </section>
      )}
    </>
  );
}

function Welcome({ snapshot, api }: { snapshot: Snapshot; api: Api }) {
  const busy = snapshot.flow !== null;
  return (
    <div class="popup__view water welcome" data-depth="60">
      <p class="welcome__water">The Loch is not.</p>
      <p class="t-body">Loch is a shielded balance inside the Solana wallet you already use: no new seed phrase. Dive in with {mainnetTestingEnabled() ? "SOL" : "test SOL"}, send it privately, surface it to any address.</p>
      <dl class="deflist deflist--kv welcome__status">
        <div class="deflist__row">
          <dt>Version</dt>
          <dd>{snapshot.version}, alpha</dd>
        </div>
        <div class="deflist__row">
          <dt>Network</dt>
          <dd>{mainnetTestingEnabled() ? "Mainnet" : "Devnet only"}</dd>
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
      </dl>
      <div class="welcome__action">
        <button class="btn btn--primary btn--block" type="button" disabled={busy} onClick={() => void api.call({ loch: "ui", type: "connect" })}>
          Connect wallet
        </button>
        <p class="t-fine">Loch opens its connect page to reach your wallet, and asks it for one signature. Nothing moves and nothing is spent.</p>
      </div>
    </div>
  );
}

const TABS: { view: View; label: string }[] = [
  { view: "home", label: "Activity" },
  { view: "report", label: "Leak report" },
  { view: "settings", label: "Settings" },
];

export function App({ api }: { api: Api }) {
  const { snapshot, failed } = useSnapshot(api);
  const [view, setView] = useState<View>("home");
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [toasts, toast] = useToasts();
  const theme = snapshot?.settings.theme ?? "dusk";
  const flow = snapshot?.flow ?? null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // A finished flow leaves a sentence behind and goes.
  useEffect(() => {
    if (!flow || flow.status !== "done") return;
    toast(doneSentence(flow), "done");
    setSheet(null);
    void api.setDraft(null);
    void api.call({ loch: "ui", type: "flow-dismiss" });
  }, [flow?.id, flow?.status]);

  // A form that was open when the popup closed (the wallet took the focus) opens again.
  useEffect(() => {
    void api.draft().then((draft) => {
      if (draft) setSheet(draft.kind);
    });
  }, [api]);

  if (!snapshot) {
    return (
      <main class="popup" aria-label="Loch" aria-busy="true">
        <div class="popup__land land">
          <CautionBand snapshot={null} />
          <header class="popup__head">
            <Brand />
          </header>
        </div>
        <hr class="waterline" />
        <div class="popup__view water" data-depth="60">
          {failed ? (
            <div class="failure" role="alert">
              <p class="failure__title">
                <Icon name="caution" />
                The extension did not answer
              </p>
              <p>Its background worker could not be reached. Close this window and open Loch again. Nothing moved.</p>
            </div>
          ) : (
            <div class="skeleton" aria-busy="true" aria-label="Reading the state of the extension">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </main>
    );
  }

  const hasWallet = snapshot.active !== null;
  const activeFlow = flow && flow.status !== "done" ? flow : null;
  const closeSheet = () => {
    setSheet(null);
    void api.setDraft(null);
  };
  // Asked for by the user. The worker may hold it back next to a private spend, and says so.
  const readBalance = async () => {
    const reply = await api.call<PublicBalanceReply>({ loch: "ui", type: "public-balance" });
    if (!reply.ok) toast("The public balance was not read. Try again.", "caution");
    else if (reply.value.status === "held") toast(heldText(reply.value.until), "plain");
    else if (reply.value.status === "unreachable") toast("The RPC endpoint did not answer. The public balance was not read.", "caution");
  };
  const go = (next: View) => {
    setView(next);
    setSheet(null);
  };

  const overlay = activeFlow ? (
    <FlowSheet snapshot={snapshot} flow={activeFlow} api={api} toast={toast} openForm={(kind) => setSheet(kind)} openSettings={() => go("settings")} />
  ) : sheet === "wallets" ? (
    <WalletsSheet snapshot={snapshot} api={api} onClose={closeSheet} go={go} />
  ) : sheet && snapshot.shielded ? (
    <FormSheet kind={sheet} snapshot={snapshot} api={api} onClose={closeSheet} openSettings={() => go("settings")} />
  ) : null;

  const panel =
    view === "activity" || (!api.popup && (view === "home" || view === "receive")) ? (
      <ActivityView snapshot={snapshot} api={api} onClose={api.popup ? () => go("home") : undefined} toast={toast} />
    ) : view === "receive" ? (
      <ReceiveView snapshot={snapshot} api={api} onClose={api.popup ? () => go("home") : undefined} toast={toast} />
    ) : view === "report" ? (
      <ReportView snapshot={snapshot} api={api} onClose={api.popup ? () => go("home") : undefined} />
    ) : view === "settings" ? (
      <SettingsView snapshot={snapshot} api={api} onClose={api.popup ? () => go("home") : undefined} toast={toast} />
    ) : null;

  if (api.popup) {
    return (
      <main class="popup" aria-label="Loch">
        <div class={`popup__land land${hasWallet ? "" : " welcome__land-wrap"}`}>
          <CautionBand snapshot={snapshot} />
          {hasWallet ? (
            <Land snapshot={snapshot} onWallets={() => setSheet("wallets")} onReport={() => go("report")} onReadBalance={readBalance} />
          ) : (
            <>
              <header class="popup__head">
                <Brand />
              </header>
              <p class="welcome__land">Your wallet is public.</p>
            </>
          )}
        </div>
        <hr class="waterline" />
        {!hasWallet ? (
          <Welcome snapshot={snapshot} api={api} />
        ) : view === "home" ? (
          <Home snapshot={snapshot} api={api} go={go} open={setSheet} toast={toast} />
        ) : (
          <div class="popup__view water" data-depth="60">
            {panel}
          </div>
        )}
        {overlay}
        <Toasts toasts={toasts} />
      </main>
    );
  }

  // The expanded view: the same section, wider. The popup's column on the left, and beside it
  // a panel for what the popup shows one at a time.
  return (
    <main class="wide" aria-label="Loch">
      <CautionBand snapshot={snapshot} />
      <div class="wide__land land">
        <div class="wide__land-left">
          {hasWallet ? (
            <Land snapshot={snapshot} onWallets={() => setSheet("wallets")} onReport={() => go("report")} onReadBalance={readBalance} />
          ) : (
            <>
              <header class="popup__head">
                <Brand />
              </header>
              <p class="welcome__land">Your wallet is public.</p>
            </>
          )}
        </div>
        <div class="wide__land-right">
          {hasWallet && (
            <div
              class="tabs"
              role="tablist"
              aria-label="Sections"
              onKeyDown={(event) => {
                // Arrow keys move between tabs, as a tab list should.
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                const current = TABS.findIndex((tab) => tab.view === view || (tab.view === "home" && (view === "activity" || view === "receive")));
                const next = TABS[(current + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
                event.preventDefault();
                go(next.view);
                requestAnimationFrame(() => event.currentTarget?.querySelector<HTMLElement>("[aria-selected='true']")?.focus());
              }}
            >
              {TABS.map((tab) => {
                const selected = view === tab.view || (tab.view === "home" && (view === "activity" || view === "receive"));
                return (
                  <button class="tabs__tab" role="tab" type="button" aria-selected={selected ? "true" : "false"} tabIndex={selected ? 0 : -1} onClick={() => go(tab.view)} key={tab.view}>
                    {tab.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <hr class="waterline" />
      <div class="wide__water">
        <div class="wide__column water" data-depth="60">
          {hasWallet ? <Home snapshot={snapshot} api={api} go={go} open={setSheet} toast={toast} /> : <Welcome snapshot={snapshot} api={api} />}
          {overlay}
          <Toasts toasts={toasts} />
        </div>
        <section class="wide__panel water" data-depth="120" data-density="comfortable" role={hasWallet ? "tabpanel" : undefined}>
          {hasWallet ? (
            panel
          ) : (
            <div class="wide__intro">
              <h1 class="t-display-2">How it works</h1>
              <ol class="steps">
                <li class="step">
                  <h2 class="step__title t-display-3">
                    <span class="step__n">1</span>Dive in
                  </h2>
                  <p>Move test SOL from your public wallet into the Loch. A screening service co-signs the deposit.</p>
                  <p class="observer">
                    <span class="observer__label">An observer sees</span> your address, the amount, and that it went into the Loch.
                  </p>
                </li>
                <li class="step">
                  <h2 class="step__title t-display-3">
                    <span class="step__n">2</span>Send privately
                  </h2>
                  <p>Pay any shielded address. A proof is made on this device and a relayer submits it, so your wallet never appears.</p>
                  <p class="observer">
                    <span class="observer__label">An observer sees</span> a proof and the relayer&rsquo;s fee. No sender, no recipient, no amount.
                  </p>
                </li>
                <li class="step">
                  <h2 class="step__title t-display-3">
                    <span class="step__n">3</span>Surface
                  </h2>
                  <p>Withdraw to any public address. Nothing on chain says which deposit paid for it.</p>
                  <p class="observer">
                    <span class="observer__label">An observer sees</span> the destination, the amount, and that it came out of the Loch.
                  </p>
                </li>
              </ol>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
