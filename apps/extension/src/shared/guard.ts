// The key-derivation guard. Whoever gets the wallet's signature of "Loch key derivation v1"
// gets the shielded balance, spending and viewing, for good (docs/protocol.md section 15). The
// message is not bound to a site and wallets show it as ordinary text, so the Loch wallet does
// not pass it on, whoever asks.
//
// What this is, and is not. It looks at what a site hands to the Loch wallet. A site that asks
// the user's real wallet directly never comes through here, and then the wallet's own prompt is
// the only thing between the site and the signature. This is help on sites that behave, not a
// barrier.
//
// The page script runs this next to the page's own code, which can replace any built-in
// method. So nothing here calls one: bytes are read by index from arrays this extension made
// itself, and characters through a reader the caller supplies (the page script passes one it
// captured before the page ran).

import { KEY_DERIVATION_TEXT } from "./constants.js";

function lower(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/** What is searched for: its codes and, kept apart, how many there are (a typed array's `length` is a getter a page can replace). */
interface Needle {
  codes: Uint8Array;
  size: number;
}

function needleOf(text: string, fold: boolean): Needle {
  const codes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) codes[i] = fold ? lower(text.charCodeAt(i)) : text.charCodeAt(i);
  return { codes, size: text.length };
}

/** The message itself, lower-cased: matched in any letter case, anywhere in the bytes. */
const NEEDLE = needleOf(KEY_DERIVATION_TEXT, true);

/**
 * The exact message as text encodings a wallet feature may be handed instead of bytes. Constants,
 * so that this file needs no encoder; test/wrapper.test.ts checks them against the message.
 */
export const ENCODED_MESSAGE = {
  hex: "4c6f6368206b65792064657269766174696f6e207631",
  base64: "TG9jaCBrZXkgZGVyaXZhdGlvbiB2MQ",
  base58: "MkEHuiZFnzxurHdvDS7ejVZTR3FDCt",
} as const;

const HEX = needleOf(ENCODED_MESSAGE.hex, true);
const BASE64 = needleOf(ENCODED_MESSAGE.base64, false);
const BASE58 = needleOf(ENCODED_MESSAGE.base58, false);

/** Whether `needle` occurs in a sequence of `length` codes read with `at`. `fold` lower-cases what is read. */
function occurs(needle: Needle, length: number, at: (index: number) => number, fold: boolean): boolean {
  const { codes, size } = needle;
  outer: for (let start = 0; start + size <= length; start++) {
    for (let i = 0; i < size; i++) {
      const code = at(start + i);
      if ((fold ? lower(code) : code) !== codes[i]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * True when `message` is the key-derivation message or contains it anywhere, in any letter
 * case. Only the exact message derives the keys; the wider match also covers a transaction or
 * an off-chain message that carries it, and stops a site from teaching people to sign things
 * that look like it.
 *
 * `message` must be an array the caller owns (a copy), read here by index and nothing else.
 * `length` is given by a caller that cannot trust the array's own `length` getter.
 */
export function containsKeyDerivation(message: ArrayLike<number>, length: number = message.length): boolean {
  return occurs(NEEDLE, length, (index) => message[index]!, true);
}

/** Reads the UTF-16 code unit at `index` of `text`. */
export type CharReader = (text: string, index: number) => number;

const plainReader: CharReader = (text, index) => text.charCodeAt(index);

/**
 * The same check for text: a sign-in statement a wallet will put into a message it builds
 * itself, or any string handed to a signing feature. Also true when the text carries the exact
 * message in hex, base64 or base58, the encodings a feature may take bytes in.
 */
export function textContainsKeyDerivation(text: string, read: CharReader = plainReader): boolean {
  const length = text.length;
  const at = (index: number) => {
    const code = read(text, index);
    return code < 0x80 ? code : 0;
  };
  return occurs(NEEDLE, length, at, true) || occurs(HEX, length, at, true) || occurs(BASE64, length, at, false) || occurs(BASE58, length, at, false);
}
