import { esc, never, text } from "./shared.js";

/**
 * The widths components.css has a step for. A figure for a page that cannot
 * measure its container (a static page, a page without JavaScript) is drawn
 * at some of these, and `.fit` shows the widest drawing that fits.
 */
export const FIT_WIDTHS = [280, 318, 360, 400, 440, 480, 520, 568, 612, 656, 704, 757] as const;

export type FitOptions = {
  /** Widths to draw at. Only widths in {@link FIT_WIDTHS} are used. Default: all of them up to `max`. */
  widths?: readonly number[];
  /** The widest drawing wanted, when `widths` is not given. Default 757. Use 568 for the by-hour and counterparties figures. */
  max?: number;
  /** Extra class names for the wrapper, e.g. to name the figure. */
  className?: string;
};

/**
 * A stepped figure: the same figure drawn at several widths, in
 * `<div class="fit">`. components.css shows one of them, the widest that
 * fits the element's own width, with a container query. No script is needed
 * and no inline style is written.
 *
 *   fitHtml((width) => steppedBedSvg(report, { width }))
 *   fitHtml((width) => byHourSvg(flows, { width, id: `hours-${width}` }), { max: 568 })
 *
 * `draw` is called once per width and must return one of the chart helpers'
 * figures drawn at that width (they carry it as `data-w`). The ids inside
 * each drawing have to differ: the default ids do, and an `id` option must
 * include the width. Put the result in `<figure class="chart">`.
 */
export function fitHtml(draw: (width: number) => string, options: FitOptions = {}): string {
  return never(
    () => {
      const ladder: readonly number[] = FIT_WIDTHS;
      const asked: readonly unknown[] = Array.isArray(options?.widths) ? options.widths : [];
      const wanted = ladder.filter((w) => asked.includes(w));
      const max = typeof options?.max === "number" && Number.isFinite(options.max) ? options.max : ladder[ladder.length - 1]!;
      const widths = wanted.length > 0 ? wanted : ladder.filter((w) => w <= Math.max(ladder[0]!, max));
      const cls = ["fit", text(options?.className, 64)].filter(Boolean).join(" ");
      const copies = widths.map((width) =>
        never(
          () => {
            const drawn: unknown = draw(width);
            return typeof drawn === "string" ? drawn : "";
          },
          () => "",
        ),
      );
      return `<div class="${esc(cls)}">${copies.join("")}</div>`;
    },
    () => `<div class="fit"></div>`,
  );
}
