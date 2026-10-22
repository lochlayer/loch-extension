// Small pieces every screen uses. Each is the design system's own markup (packages/design/
// components.css says which), written once.

import { formatSol } from "@loch/design/numerals";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { formatUnits, isNative } from "../shared/assets.js";
import { DOCS_PAGE, elapsedText, failureCopy, type FailureContext, HOW_IT_WORKS, MORE_IN_DOCS, richParts, stageLine, statusSentence } from "../shared/copy.js";
import type { Failure, FlowView } from "../shared/view.js";

export type IconName =
  | "caution"
  | "check"
  | "chevron"
  | "close"
  | "copy"
  | "dive"
  | "external"
  | "info"
  | "public"
  | "receive"
  | "refresh"
  | "scan"
  | "send"
  | "settings"
  | "shielded"
  | "surface"
  | "swap"
  | "wallet";

export function Icon({ name, small, label }: { name: IconName; small?: boolean; label?: string }) {
  return (
    <svg class={small ? "icon icon--sm" : "icon"} aria-hidden={label ? undefined : "true"} aria-label={label} role={label ? "img" : undefined} focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** An amount in a row or in running text. Public is upright, shielded is italic. */
export function Amount({
  lamports,
  shielded,
  sign,
  exact,
  unit,
}: {
  lamports: bigint;
  shielded?: boolean;
  sign?: "always" | "auto" | "never";
  exact?: boolean;
  unit?: string;
}) {
  const parts = formatSol(lamports, { sign: sign ?? "auto", exact: exact ?? false });
  const full = formatSol(lamports, { exact: true }).text;
  return (
    <>
      <span class={`fig ${shielded ? "is-shielded" : "is-public"}`} title={parts.truncated ? `${full} SOL` : undefined}>
        {parts.sign && <span class="fig-sign">{parts.sign}</span>}
        {parts.negligible ? parts.text.slice(parts.sign.length) : `${parts.int}${parts.frac}`}
      </span>
      {unit && <> <span class="fig-unit">{unit}</span></>}
    </>
  );
}

/**
 * The shielded balance, written as a chart writes a depth. The markup is the design system's
 * (`soundingHtml` in @loch/design/numerals), built as elements here so that it can carry the
 * exact figure as its title. A balance too small to show is "<" "0" ".001", never "0.000", and
 * the "<" is a part of its own, so that the large figure is the whole number.
 */
export function Sounding({ lamports }: { lamports: bigint }) {
  const parts = formatSol(lamports);
  let whole = parts.int;
  let frac = parts.frac;
  if (parts.negligible) {
    const shown = parts.text.slice(parts.sign.length).replace(/^</, "");
    const point = shown.indexOf(".");
    whole = point < 0 ? shown : shown.slice(0, point);
    frac = point < 0 ? "" : shown.slice(point);
  }
  return (
    <span class="sounding" aria-label={parts.text} title={parts.truncated ? `${formatSol(lamports, { exact: true }).text} SOL` : undefined}>
      {parts.negligible && (
        <span class="sounding__less" aria-hidden="true">
          &lt;
        </span>
      )}
      <span aria-hidden="true">{whole}</span>
      <span class="sounding__frac" aria-hidden="true">
        {frac}
      </span>
    </span>
  );
}

/** A sentence whose figures keep the lettering rule: public upright, shielded italic. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {richParts(text).map((part) => (part.role === "plain" ? part.text : <span class={`fig ${part.role === "shielded" ? "is-shielded" : "is-public"}`}>{part.text}</span>))}
    </>
  );
}

/**
 * What most people can leave closed: the explanation of a screen, a native details element
 * (opens without script), with a link to its section of the docs page.
 */
export function HowItWorks({ children, anchor, title }: { children?: ComponentChildren; anchor?: string; title?: string }) {
  return (
    <details class="disclosure how">
      <summary>
        <Icon name="chevron" small />
        <span>{title ?? HOW_IT_WORKS}</span>
      </summary>
      <div class="disclosure__body">
        {children}
        {anchor && (
          <p>
            <a href={`${DOCS_PAGE}#${anchor}`} target="_blank" rel="noreferrer">
              {MORE_IN_DOCS}
            </a>
          </p>
        )}
      </div>
    </details>
  );
}

export function Observer({ children }: { children: ComponentChildren }) {
  return (
    <p class="observer">
      <span class="observer__label">An observer sees</span> {children}
    </p>
  );
}

/** Counts up once a second from `since`. */
function useElapsed(since: number, running: boolean, now: () => number): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running, since]);
  return Math.max(0, now() - since);
}

/** The sounding line of a long operation: stages, a tick, and one plain sentence. */
export function Progress({ flow, now, label }: { flow: FlowView; now: () => number; label: string }) {
  const { stages, progress } = stageLine(flow);
  const failed = flow.status === "failed";
  const running = flow.status === "running" || flow.status === "waiting";
  const elapsed = useElapsed(flow.stepStartedAt, running, now);
  return (
    <div class="progress" style={{ "--progress": String(progress) }} data-state={failed ? "failed" : undefined} role="group" aria-label={label}>
      <div class="progress__line" aria-hidden="true">
        <span />
      </div>
      <ol class="progress__stages" data-count={stages.length}>
        {stages.map((stage) => (
          <li data-state={stage.state === "todo" ? undefined : stage.state} aria-current={stage.state === "now" ? "step" : undefined}>
            {stage.label}
          </li>
        ))}
      </ol>
      {running && (
        <p class="progress__status" role="status">
          <span>{statusSentence(flow)}</span>
          <span class="fig">{elapsedText(elapsed)}</span>
        </p>
      )}
    </div>
  );
}

/** What happened, whether funds moved, what to do. */
export function FailureBlock({ failure, context, children }: { failure: Failure; context: FailureContext; children?: ComponentChildren }) {
  const copy = failureCopy(failure, context);
  return (
    <div class="failure" role="alert">
      <p class="failure__title">
        <Icon name="caution" />
        {copy.title}
      </p>
      {copy.lines.map((line) => (
        <p>
          <Rich text={line} />
        </p>
      ))}
      {failure.detail && <p class="failure__detail">{failure.detail}</p>}
      {children}
    </div>
  );
}

/** A sheet rising from the bed of the popup, with the focus kept inside it. */
export function Sheet({
  title,
  id,
  alert,
  onClose,
  children,
  foot,
}: {
  title: string;
  id: string;
  alert?: boolean;
  onClose?: () => void;
  children: ComponentChildren;
  foot?: ComponentChildren;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const sheet = ref.current;
    if (!sheet) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A field to type in, or the one thing to press, gets the focus. Otherwise the sheet itself.
    const first = sheet.querySelector<HTMLElement>("[data-autofocus]") ?? sheet.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled)");
    (first ?? sheet).focus({ preventScroll: true });
    return () => previous?.focus?.();
  }, [id]);
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && onClose) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']"));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <section class="sheet is-arriving" role={alert ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
        <header class="sheet__head">
          <h2 class="sheet__title" id={`${id}-title`}>
            {title}
          </h2>
          {onClose && (
            <button class="btn btn--quiet btn--icon btn--sm" type="button" aria-label="Close" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </header>
        <div class="sheet__body stack">{children}</div>
        {foot && <footer class="sheet__foot">{foot}</footer>}
      </section>
    </>
  );
}

export function Field({
  label,
  id,
  hint,
  error,
  children,
  optional,
}: {
  label: string;
  id: string;
  hint?: ComponentChildren;
  error?: string | null;
  children: ComponentChildren;
  optional?: boolean;
}) {
  return (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
        {optional && <small> (optional)</small>}
      </label>
      {children}
      {hint && (
        <p class="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p class="field__error" id={`${id}-error`}>
          <Icon name="caution" />
          <span>
            <Rich text={error} />
          </span>
        </p>
      )}
    </div>
  );
}

/** The amount field: the figure typed at display size, upright when the chain will see it, italic when it will not. */
export function AmountField({
  id,
  label,
  value,
  shielded,
  onInput,
  onMax,
  hint,
  error,
  disabled,
  unit = "SOL",
}: {
  id: string;
  label: string;
  value: string;
  shielded: boolean;
  /** The asset's symbol. Default SOL. */
  unit?: string;
  onInput: (value: string) => void;
  onMax?: () => void;
  hint?: ComponentChildren;
  error?: string | null;
  disabled?: boolean;
}) {
  return (
    <div class={`field amount ${shielded ? "amount--shielded" : "amount--public"}`}>
      <label class="field__label" for={id}>
        {label}
      </label>
      <div class="amount__box">
        <input
          class="amount__input"
          id={id}
          inputMode="decimal"
          autocomplete="off"
          spellcheck={false}
          placeholder="0.000"
          value={value}
          disabled={disabled}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={`${hint ? `${id}-hint ` : ""}${error ? `${id}-error` : ""}`.trim() || undefined}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
        <span class="amount__unit">{unit}</span>
        {onMax && (
          <button class="btn btn--quiet btn--sm" type="button" onClick={onMax} disabled={disabled}>
            Max
          </button>
        )}
      </div>
      {hint && (
        <p class="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p class="field__error" id={`${id}-error`}>
          <Icon name="caution" />
          <span>
            <Rich text={error} />
          </span>
        </p>
      )}
    </div>
  );
}

/** A heading row under the waterline: what this view is, and the way back. */
export function ViewHead({ title, onClose, closeLabel, children }: { title: ComponentChildren; onClose?: () => void; closeLabel?: string; children?: ComponentChildren }) {
  return (
    <div class="popup__deep-head view-head">
      <h2>{title}</h2>
      {children}
      {onClose && (
        <a
          href="#home"
          onClick={(event) => {
            event.preventDefault();
            onClose();
          }}
        >
          {closeLabel ?? "Close"}
        </a>
      )}
    </div>
  );
}

export function Toasts({ toasts }: { toasts: { id: number; text: string; kind: "done" | "caution" | "plain" }[] }) {
  return (
    <div class="toast-region" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div class={`toast is-arriving ${toast.kind === "done" ? "toast--done" : toast.kind === "caution" ? "toast--caution" : ""}`} key={toast.id}>
          <Icon name={toast.kind === "caution" ? "caution" : toast.kind === "done" ? "check" : "info"} />
          <p>{toast.text}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * An amount of a v2 asset in its own precision: `decimals` places, cut toward zero to three
 * unless `exact`. SOL amounts keep <Amount>, which writes them as the design system says.
 */
export function Units({ units, decimals, shielded, exact }: { units: bigint; decimals: number; shielded?: boolean; exact?: boolean }) {
  const text = formatUnits(units, decimals, exact ? decimals : Math.min(3, decimals));
  return (
    <span class={`fig ${shielded ? "is-shielded" : "is-public"}`} title={exact ? undefined : formatUnits(units, decimals)}>
      {text}
    </span>
  );
}

/** An amount of any asset with its symbol: SOL through <Amount>, a token through <Units>. */
export function AssetAmount({ units, mint, decimals, symbol, shielded, exact }: { units: bigint; mint?: string; decimals: number; symbol: string; shielded?: boolean; exact?: boolean }) {
  return isNative(mint) ? (
    <>
      <Amount lamports={units} shielded={shielded} exact={exact} /> SOL
    </>
  ) : (
    <>
      <Units units={units} decimals={decimals} shielded={shielded} exact={exact} /> {symbol}
    </>
  );
}

/** Which asset a form is about: one button per asset, the chosen one pressed. Nothing is drawn for a single asset. */
export function AssetPicker({ assets, value, onChange, label = "Asset" }: { assets: readonly { mint: string; symbol: string }[]; value: string; onChange: (mint: string) => void; label?: string }) {
  if (assets.length < 2) return null;
  return (
    <div class="field">
      <span class="field__label">{label}</span>
      <div class="segmented" role="radiogroup" aria-label={label}>
        {assets.map((asset) => (
          <button key={asset.mint} type="button" role="radio" aria-checked={asset.mint === value ? "true" : "false"} onClick={() => onChange(asset.mint)}>
            {asset.symbol}
          </button>
        ))}
      </div>
    </div>
  );
}
