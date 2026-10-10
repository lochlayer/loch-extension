// An invented wallet for the style guide. The flows are synthetic and
// deterministic; the report is whatever the real scanner makes of them
// (@loch/scanner-core buildReport), so the figures in the guide are the
// scanner's own arithmetic and wording.
import { buildReport } from "@loch/scanner-core/analysis";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(230);

function address(head, tail) {
  let middle = "";
  for (let i = 0; i < 44 - head.length - tail.length; i++) middle += B58[Math.floor(rnd() * B58.length)];
  return head + middle + tail;
}

export const WALLET = address("Fh3q", "Tz8K");
export const EXCHANGE = address("5tzF", "uAi9");
const PAYEE_A = address("9fRk", "2mVd");
const PAYEE_B = address("Bq7T", "e1Lw");
const PAYEE_C = address("H2xD", "pK4s");
export const RECIPIENT = address("7Yk2", "mQ4d");
export const LABELS = { [EXCHANGE]: "Exchange withdrawal" };
/**
 * The popup's "a send that failed" frame: a relayer that did not answer in time after the
 * request had left. These are the extension's own words for that case
 * (apps/extension/src/shared/copy.ts, `relayer-unreachable` with the reason `timeout` and the
 * proof kept; apps/extension/shots/send-failed-dusk.png). Keep the two in step. A relayer that
 * did not answer may have the request and may still send it, so nothing here may say that
 * nothing was sent or that the balance is unchanged.
 */
export const SEND_FAILURE = {
  title: "The relayer did not answer in time",
  lines: [
    "It may have received the request. The chain does not show the transfer so far.",
    "The notes it spends stay reserved, and your balance counts it as sent, until the chain shows what happened or its proof is too old to be accepted.",
    "Try again, or choose another relayer in settings and try again here. Either way the same notes are spent, so it cannot be paid twice. The proof is kept, so it will not take as long.",
  ],
  detail: "relayer.devnet.loch.example: network_error (timeout)",
};
/** A shielded address: bech32m, prefix "loch". The example in docs/protocol.md. */
export const SHIELDED = "loch1q87ep4a7lwncng5nw8hhst92u0nu49c3u6d5evle76kee3wzph57mljdndnkyt92jgjudplsxjf80nszkrh3ng58cdcrm64pmxzgvcg5p36df";

/** 2026-08-01T00:00:00Z. */
const T0 = 1_785_542_400;
const DAY = 86_400;

// Hours this wallet is awake, UTC. Nothing from 22:00 to 04:00 but three stray transfers.
const AWAKE = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const WEIGHT = [1, 2, 4, 7, 9, 10, 9, 8, 10, 12, 13, 11, 9, 8, 7, 6, 4, 2];
const WEIGHT_SUM = WEIGHT.reduce((a, b) => a + b, 0);
function awakeHour() {
  let r = rnd() * WEIGHT_SUM;
  for (let i = 0; i < AWAKE.length; i++) {
    r -= WEIGHT[i];
    if (r <= 0) return AWAKE[i];
  }
  return 12;
}
const time = (day, hour) => T0 + day * DAY + hour * 3600 + Math.floor(rnd() * 3600);
const amount = () => Math.round((0.01 + rnd() * 3) * 1e9 + Math.floor(rnd() * 997)) / 1e9;

function build() {
  const flows = [];
  let sig = 0;
  const push = (f) => flows.push({ sig: `sig${++sig}`, asset: "SOL", ...f });

  // Funded from a labelled exchange address, which then appears three more times.
  push({ time: T0 + 4 * 3600 + 120, dir: "in", counterparty: EXCHANGE, amount: 42.5 });
  for (let i = 0; i < 3; i++) push({ time: time(8 + i * 14, awakeHour()), dir: i === 1 ? "out" : "in", counterparty: EXCHANGE, amount: amount() });

  // Three addresses it keeps paying.
  for (let i = 0; i < 14; i++) push({ time: time(2 + i * 4, awakeHour()), dir: "out", counterparty: PAYEE_A, amount: 0.85 });
  for (let i = 0; i < 9; i++) push({ time: time(3 + i * 6, awakeHour()), dir: i % 3 === 0 ? "in" : "out", counterparty: PAYEE_B, amount: amount() });
  for (let i = 0; i < 6; i++) push({ time: time(5 + i * 9, awakeHour()), dir: "out", counterparty: PAYEE_C, amount: amount() });

  // Two exact amounts passed straight through.
  for (const [day, value] of [[17, 1.25], [41, 0.4]]) {
    const at = time(day, 11);
    push({ time: at, dir: "in", counterparty: address("Pa", "in"), amount: value });
    push({ time: at + 240, dir: "out", counterparty: address("Pa", "out"), amount: value });
  }

  // Everyone else: once or twice each.
  let remaining = 412 - flows.length - 3;
  while (remaining > 0) {
    const who = address("", "");
    const times = Math.min(remaining, rnd() < 0.3 ? 2 : 1);
    for (let i = 0; i < times; i++) push({ time: time(Math.floor(rnd() * 60), awakeHour()), dir: rnd() < 0.4 ? "in" : "out", counterparty: who, amount: amount() });
    remaining -= times;
  }

  // Three strays in the quiet window.
  for (const hour of [23, 1, 2]) push({ time: time(Math.floor(rnd() * 60), hour), dir: "out", counterparty: address("", ""), amount: amount() });
  return flows;
}

export const FLOWS = build();

export const REPORT = buildReport({
  address: WALLET,
  scannedTransactions: 300,
  flows: FLOWS,
  solBalance: 41.207,
  tokenAccountCount: 6,
  labels: LABELS,
});
