// The built-ins the page script depends on, taken when it starts: at document_start, before any
// code of the page has run. A page can replace every method on every prototype afterwards
// (ArrayBuffer.isView, Array.prototype.push, Promise.prototype.then, a typed array's `length`).
// What the Loch wallet decides with must not go through anything the page could have swapped,
// so the decision path uses only what is captured here, plain loops, and property reads on
// objects this script made itself.
//
// This file must stay free of imports that run code, and must be evaluated before anything else
// in the page script.

const R = Reflect;
export const apply = R.apply;
const reflectGet = R.get;
const reflectOwnKeys = R.ownKeys;
const getOwnDescriptor = R.getOwnPropertyDescriptor;
const getPrototype = R.getPrototypeOf;
const defineProperty = R.defineProperty;

const ObjectProto = Object.prototype;
const ArrayProto = Array.prototype;
const isArray = Array.isArray;
const U8 = Uint8Array;
const TypedArrayProto = getPrototype(U8.prototype) as object;
const getter = (target: object, key: PropertyKey): ((this: unknown) => unknown) => getOwnDescriptor(target, key)!.get as (this: unknown) => unknown;
const typedTag = getter(TypedArrayProto, Symbol.toStringTag);
const typedBuffer = getter(TypedArrayProto, "buffer");
const typedByteOffset = getter(TypedArrayProto, "byteOffset");
const typedByteLength = getter(TypedArrayProto, "byteLength");
const typedSet = (TypedArrayProto as { set: unknown }).set as (this: Uint8Array, source: Uint8Array) => void;
const bufferByteLength = getter(ArrayBuffer.prototype, "byteLength");
const viewBuffer = getter(DataView.prototype, "buffer");
const viewByteOffset = getter(DataView.prototype, "byteOffset");
const viewByteLength = getter(DataView.prototype, "byteLength");
const sharedByteLength = typeof SharedArrayBuffer === "function" ? getter(SharedArrayBuffer.prototype, "byteLength") : null;

const fromCharCode = String.fromCharCode;
const charCodeAtMethod = String.prototype.charCodeAt;
const btoaFunction = btoa;
const setTimeoutFunction = setTimeout;
const clearTimeoutFunction = clearTimeout;
const cryptoObject = crypto;
const getRandomValues = cryptoObject.getRandomValues;
export const PromiseCtor = Promise;
const promiseThen = Promise.prototype.then;
const portPostMessage = MessagePort.prototype.postMessage;
const eventData = getter(MessageEvent.prototype, "data");
const eventPorts = getter(MessageEvent.prototype, "ports");
const eventPreventDefault = Event.prototype.preventDefault;

/** A dictionary no prototype can reach into. */
export function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
const createDictionary = Object.create;

export function charCodeAt(text: string, index: number): number {
  return apply(charCodeAtMethod, text, [index]) as number;
}

export function later(run: () => void, ms: number): number {
  return apply(setTimeoutFunction, window, [run, ms]) as unknown as number;
}

export function cancel(timer: number): void {
  apply(clearTimeoutFunction, window, [timer]);
}

/** The value of an own data property, whatever the prototype chain has been given. */
export function own(target: unknown, key: string): unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) return undefined;
  const descriptor = getOwnDescriptor(target, key);
  if (descriptor === undefined) return undefined;
  // An accessor has no `value` of its own, and the lookup must not wander up to Object.prototype.
  const value = getOwnDescriptor(descriptor, "value");
  return value === undefined ? undefined : value.value;
}

/** Sets an own data property without consulting a setter someone put on a prototype. */
export function put(target: object, key: string | number, value: unknown): void {
  defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

export function messageData(event: unknown): unknown {
  return apply(eventData, event, []);
}

export function messagePort(event: unknown): MessagePort | undefined {
  const ports = apply(eventPorts, event, []) as readonly MessagePort[];
  return ports[0];
}

export function preventDefault(event: unknown): void {
  apply(eventPreventDefault, event, []);
}

export function post(port: MessagePort, message: unknown): void {
  apply(portPostMessage, port, [message]);
}

/** A copy of some bytes, with its length kept beside it: a typed array's own `length` is a getter. */
export interface Bytes {
  bytes: Uint8Array;
  length: number;
}

/** The largest input the Loch wallet copies. Anything larger is not passed on. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Thrown when an input is too large or too deep to copy. The request is then not passed on. */
export class Unreadable extends Error {}

type Range = [buffer: ArrayBufferLike, offset: number, length: number];

/** Where an object's bytes are, read from its internal slots. Null when it holds none. */
function rangeOf(value: object): Range | null {
  try {
    if (apply(typedTag, value, []) !== undefined) {
      return [apply(typedBuffer, value, []) as ArrayBufferLike, apply(typedByteOffset, value, []) as number, apply(typedByteLength, value, []) as number];
    }
  } catch {
    // Not a typed array.
  }
  try {
    return [apply(viewBuffer, value, []) as ArrayBufferLike, apply(viewByteOffset, value, []) as number, apply(viewByteLength, value, []) as number];
  } catch {
    // Not a DataView.
  }
  try {
    return [value as ArrayBuffer, 0, apply(bufferByteLength, value, []) as number];
  } catch {
    // Not an ArrayBuffer.
  }
  if (sharedByteLength) {
    try {
      return [value as SharedArrayBuffer, 0, apply(sharedByteLength, value, []) as number];
    } catch {
      // Not a SharedArrayBuffer.
    }
  }
  return null;
}

/**
 * Copies the bytes of a typed array, a DataView or an ArrayBuffer, read from the object's
 * internal slots: an own `buffer` or `length` property a page put on it is not consulted, and
 * it works for an object from another frame. Null for anything else.
 *
 * @throws Unreadable when there are more bytes than the Loch wallet copies.
 */
export function copyBytes(value: unknown): Bytes | null {
  if (typeof value !== "object" || value === null) return null;
  const range = rangeOf(value);
  if (!range) return null;
  const length = range[2];
  if (length > MAX_BYTES) throw new Unreadable();
  const bytes = new U8(length);
  // The caller's memory is read once, here, into memory nobody else holds.
  apply(typedSet, bytes, [new U8(range[0], range[1], length)]);
  return { bytes, length };
}

export function toBase64(bytes: Bytes): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += fromCharCode(bytes.bytes[i]!);
  return apply(btoaFunction, window, [binary]) as string;
}

/** 128 random bits as 22 characters of base64url. */
export function nonce(): string {
  const bytes = apply(getRandomValues, cryptoObject, [new U8(16)]) as Uint8Array;
  let binary = "";
  for (let i = 0; i < 16; i++) binary += fromCharCode(bytes[i]!);
  const text = apply(btoaFunction, window, [binary]) as string;
  let out = "";
  for (let i = 0; i < 22; i++) {
    const code = charCodeAt(text, i);
    out += code === 0x2b ? "-" : code === 0x2f ? "_" : fromCharCode(code);
  }
  return out;
}

// ------------------------------------------------------------------ snapshots

const MAX_NODES = 20_000;
const MAX_DEPTH = 8;

export interface Snapshot {
  /** The copy of the arguments. This is what the wallet is given. */
  value: unknown[];
  /** Every byte array in it. The same arrays that sit in `value`. */
  bytes: Bytes[];
  /** Every string in it, property names included. */
  strings: string[];
}

interface Walk {
  nodes: number;
  total: number;
  bytes: Bytes[];
  strings: string[];
  /** Objects to hand on as they are: the wallet's own account objects, which it compares by identity. */
  keep: readonly unknown[];
  keepCount: number;
  /** Rebuild every object, whatever its class. Otherwise objects of a class go on as they are. */
  strict: boolean;
}

function copyValue(value: unknown, depth: number, walk: Walk): unknown {
  if (++walk.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Unreadable();
  if (typeof value === "string") {
    put(walk.strings, walk.strings.length, value);
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  for (let i = 0; i < walk.keepCount; i++) if (walk.keep[i] === value) return value;

  const copied = copyBytes(value);
  if (copied) {
    walk.total += copied.length;
    if (walk.total > MAX_BYTES) throw new Unreadable();
    put(walk.bytes, walk.bytes.length, copied);
    return copied.bytes;
  }

  if (isArray(value)) {
    const length = reflectGet(value, "length") as number;
    if (typeof length !== "number" || !(length >= 0) || length > MAX_NODES) throw new Unreadable();
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) put(out, i, copyValue(reflectGet(value, i), depth + 1, walk));
    return out;
  }

  if (!walk.strict) {
    // Plain data is an object whose prototype is some frame's Object.prototype, or none.
    const proto = getPrototype(value);
    if (proto !== null && getPrototype(proto) !== null) {
      // An object of a class of the site's or the wallet's own, handed to a feature Loch does not
      // know. It cannot be copied faithfully, so it goes on as it is, unchecked. (README.)
      return value;
    }
  }
  const out = apply(createDictionary, Object, [ObjectProto]) as Record<string, unknown>;
  const keys = reflectOwnKeys(value);
  const count = reflectGet(keys, "length") as number;
  for (let i = 0; i < count; i++) {
    const key = keys[i];
    if (typeof key !== "string") continue;
    const descriptor = getOwnDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable) continue;
    put(walk.strings, walk.strings.length, key);
    // Read once. A getter runs here, a single time, and what it returned is what goes on.
    put(out, key, copyValue(reflectGet(value, key), depth + 1, walk));
  }
  return out;
}

/**
 * Copies what a site passed to a wallet feature: objects and arrays are rebuilt, every property
 * is read exactly once, every byte array becomes a fresh Uint8Array, strings are collected. The
 * copy is what the guard looks at and what the wallet receives, so a value that reads one way
 * the first time and another the second has only its first reading.
 *
 * `strict` rebuilds every object (the Solana signing features, whose inputs are plain data).
 * Without it an object of a class is handed on as it is: features this script does not know may
 * depend on it.
 *
 * @throws Unreadable when the input is too large or too deeply nested.
 */
export function snapshot(inputs: readonly unknown[], count: number, keep: readonly unknown[], keepCount: number, strict: boolean): Snapshot {
  const walk: Walk = { nodes: 0, total: 0, bytes: [], strings: [], keep, keepCount, strict };
  const value: unknown[] = [];
  for (let i = 0; i < count; i++) put(value, i, copyValue(inputs[i], 1, walk));
  return { value, bytes: walk.bytes, strings: walk.strings };
}

/** The names of an object's own enumerable properties. */
export function keysOf(target: object): string[] {
  const out: string[] = [];
  const keys = reflectOwnKeys(target);
  const count = reflectGet(keys, "length") as number;
  for (let i = 0; i < count; i++) {
    const key = keys[i];
    if (typeof key !== "string") continue;
    const descriptor = getOwnDescriptor(target, key);
    if (descriptor && descriptor.enumerable) put(out, out.length, key);
  }
  return out;
}

/**
 * Runs `then` when a promise of the wallet's settles, through the built-in `then` as it was at
 * document_start. False when `value` is not a native promise: then nothing was attached.
 */
export function whenSettled(value: unknown, then: (result: unknown) => void, otherwise: (error: unknown) => void): boolean {
  try {
    apply(promiseThen, value, [then, otherwise]);
    return true;
  } catch {
    return false;
  }
}

/** The elements of an array-like the page or the wallet controls, read once, as a real array. */
export function listOf(value: unknown, max: number): unknown[] {
  const out: unknown[] = [];
  if (typeof value !== "object" || value === null) return out;
  let length: unknown;
  try {
    length = reflectGet(value, "length");
  } catch {
    return out;
  }
  if (typeof length !== "number" || !(length > 0)) return out;
  for (let i = 0; i < length && i < max; i++) {
    try {
      put(out, i, reflectGet(value, i));
    } catch {
      put(out, i, undefined);
    }
  }
  return out;
}

/** Reads a property once, whatever it is on. Undefined when the read throws. */
export function read(target: unknown, key: string): unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) return undefined;
  try {
    return reflectGet(target, key);
  } catch {
    return undefined;
  }
}
