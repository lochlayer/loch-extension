// Must be imported BEFORE snarkjs (see prover.ts).
//
// snarkjs' arithmetic library (ffjavascript) calls URL.createObjectURL while
// its module loads, to prepare the script its worker threads would run. A
// service worker has no such function, so without help merely importing the
// SDK there throws "URL.createObjectURL is not a function". Service workers
// cannot start workers either, so ffjavascript runs single-threaded and never
// uses the result. This provides a stand-in for the duration of the import
// only; prover.ts removes it again as soon as snarkjs has loaded.

type UrlStatics = { createObjectURL?: unknown };

const statics = (globalThis as { URL?: UrlStatics }).URL;
const installed = statics !== undefined && typeof statics.createObjectURL !== "function";

if (installed) {
  Object.defineProperty(statics, "createObjectURL", { value: () => "", configurable: true, writable: true });
}

/** Removes the stand-in again, if one was installed. */
export function removeCreateObjectUrlStandIn(): void {
  if (installed && statics) delete statics.createObjectURL;
}
