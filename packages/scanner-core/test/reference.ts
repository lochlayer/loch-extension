/**
 * The pass-through check as it was before it was made fast: every outgoing
 * flow against every incoming one. Kept, for tests only, as the definition
 * the fast one has to agree with. Do not use it on input an endpoint sized.
 */
import type { Flow } from "../src/index.js";

const PASS_THROUGH_WINDOW_SECONDS = 600;
const AMOUNT_EPSILON = 1e-9;

type Leg = Pick<Flow, "dir" | "asset" | "amount" | "time">;

function isPassThrough(inbound: Leg, out: Leg): boolean {
  const gap = out.time - inbound.time;
  return inbound.asset === out.asset && Math.abs(inbound.amount - out.amount) < AMOUNT_EPSILON && gap >= 0 && gap < PASS_THROUGH_WINDOW_SECONDS;
}

/** Quadratic. */
export function passThroughOutflowsReference<T extends Leg>(flows: readonly T[]): T[] {
  const ins = flows.filter((x) => x.dir === "in");
  return flows.filter((o) => o.dir === "out" && ins.some((i) => isPassThrough(i, o)));
}
