// Binary HTTP messages (RFC 9292), known-length form.
//
// Oblivious HTTP carries one whole request and one whole response, so the
// known-length form is all it needs: this codec writes only that form and
// refuses the indeterminate-length form (framing indicators 2 and 3) when
// reading. Everything else in RFC 9292 is implemented: truncation of empty
// trailing sections, zero padding (section 3.8), informational responses, and
// the validity rules for field names and values.

import { type Bytes, asciiToBytes, bytesToLatin1, concatBytes, latin1ToBytes } from "./bytes.js";
import { OhttpError } from "./errors.js";

/** One header or trailer line: a lowercase name and its value. */
export type FieldLine = readonly [name: string, value: string];

/** An HTTP request as a Binary HTTP message carries it. */
export interface BinaryRequest {
  /** `GET`, `POST`, ... */
  method: string;
  /** `https` or `http`. */
  scheme: string;
  /** Host and optional port. May be empty. */
  authority: string;
  /** Path and query, starting with `/`. */
  path: string;
  headers: FieldLine[];
  content: Uint8Array;
  /** Trailer fields. Almost always empty. */
  trailers?: FieldLine[];
}

/** An HTTP response as a Binary HTTP message carries it. Informational (1xx) responses are dropped when reading. */
export interface BinaryResponse {
  /** Final status code, 200 to 599. */
  status: number;
  headers: FieldLine[];
  content: Uint8Array;
  /** Trailer fields. Almost always empty. */
  trailers?: FieldLine[];
}

/** Most field lines accepted in one section. */
const MAX_FIELD_LINES = 256;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Visible ASCII without whitespace: what a scheme, an authority and a path may contain. */
const VISIBLE = /^[\x21-\x7e]*$/;

const malformed = (what: string) => new OhttpError("malformed", `the Binary HTTP message is malformed: ${what}`);

// --- variable-length integers (RFC 9000, section 16) -----------------------

function varint(value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) throw malformed("a length is out of range");
  if (value < 0x40) return Uint8Array.of(value);
  if (value < 0x4000) return Uint8Array.of(0x40 | (value >> 8), value & 0xff);
  if (value < 0x4000_0000) {
    return Uint8Array.of(0x80 | (value >>> 24), (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 0x1_0000_0000) + 0xc000_0000);
  view.setUint32(4, value >>> 0);
  return out;
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  varint(): number {
    const first = this.bytes[this.offset];
    if (first === undefined) throw malformed("it ends inside a length");
    const size = 1 << (first >> 6);
    if (this.offset + size > this.bytes.length) throw malformed("it ends inside a length");
    let value = first & 0x3f;
    for (let i = 1; i < size; i++) {
      // Multiplication, not a shift: the value can pass 32 bits.
      value = value * 256 + this.bytes[this.offset + i]!;
      if (value > Number.MAX_SAFE_INTEGER) throw malformed("a length is out of range");
    }
    this.offset += size;
    return value;
  }

  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.offset) throw malformed("a section is longer than the message");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /**
   * A length-prefixed section; empty if the message was truncated before it
   * (RFC 9292, section 3.8). This is accepted for the header section as well
   * as for content and trailers: the example messages of RFC 9458 Appendix A
   * end right after the control data.
   */
  section(): Uint8Array {
    if (this.done) return this.bytes.subarray(0, 0);
    return this.take(this.varint());
  }

  /** What is left must be padding: zero bytes only. */
  padding(): void {
    for (let i = this.offset; i < this.bytes.length; i++) {
      if (this.bytes[i] !== 0) throw malformed("the padding is not zero");
    }
    this.offset = this.bytes.length;
  }
}

// --- field sections -----------------------------------------------------------

function encodeFields(lines: readonly FieldLine[] | undefined): Bytes {
  const parts: Uint8Array[] = [];
  for (const [rawName, rawValue] of lines ?? []) {
    const name = rawName.toLowerCase();
    if (!TOKEN.test(name)) throw malformed("a field name is not valid");
    let value: Bytes;
    try {
      value = latin1ToBytes(rawValue.trim());
    } catch {
      throw malformed("a field value is not valid");
    }
    if (value.some((byte) => byte === 0 || byte === 0x0a || byte === 0x0d)) throw malformed("a field value is not valid");
    const nameBytes = asciiToBytes(name);
    parts.push(varint(nameBytes.length), nameBytes, varint(value.length), value);
  }
  const body = concatBytes(...parts);
  return concatBytes(varint(body.length), body);
}

function decodeFields(section: Uint8Array): FieldLine[] {
  const reader = new Reader(section);
  const lines: FieldLine[] = [];
  while (!reader.done) {
    if (lines.length >= MAX_FIELD_LINES) throw malformed("too many field lines");
    const nameLength = reader.varint();
    if (nameLength === 0) throw malformed("a field name is empty");
    const name = bytesToLatin1(reader.take(nameLength));
    // Pseudo-fields (":method", ":status", ...) are either forbidden or unknown to this codec.
    if (!TOKEN.test(name)) throw malformed("a field name is not valid");
    const value = reader.take(reader.varint());
    if (value.some((byte) => byte === 0 || byte === 0x0a || byte === 0x0d)) throw malformed("a field value is not valid");
    lines.push([name.toLowerCase(), bytesToLatin1(value)]);
  }
  return lines;
}

function lengthPrefixed(bytes: Uint8Array): Bytes {
  return concatBytes(varint(bytes.length), bytes);
}

function controlText(value: string, pattern: RegExp, what: string): Bytes {
  if (typeof value !== "string" || !pattern.test(value)) throw malformed(`the ${what} is not valid`);
  return lengthPrefixed(asciiToBytes(value));
}

// --- messages ---------------------------------------------------------------

/**
 * Encodes a request in the known-length form. Content and trailer lengths are
 * always written (never truncated), so zero bytes appended afterwards are
 * padding and nothing else.
 */
export function encodeRequest(request: BinaryRequest): Uint8Array {
  if (request.method === "" || request.path === "" || request.scheme === "") throw malformed("the request line is incomplete");
  return concatBytes(
    varint(0),
    controlText(request.method, TOKEN, "method"),
    controlText(request.scheme, TOKEN, "scheme"),
    controlText(request.authority, VISIBLE, "authority"),
    controlText(request.path, VISIBLE, "path"),
    encodeFields(request.headers),
    lengthPrefixed(request.content),
    encodeFields(request.trailers),
  );
}

/** Decodes a known-length request. Throws an {@link OhttpError} with code `malformed` on anything else. */
export function decodeRequest(message: Uint8Array): BinaryRequest {
  const reader = new Reader(message);
  const framing = reader.varint();
  if (framing === 2) throw malformed("the indeterminate-length form is not supported");
  if (framing !== 0) throw malformed("it is not a request");
  const text = (pattern: RegExp, what: string, allowEmpty: boolean) => {
    const value = bytesToLatin1(reader.take(reader.varint()));
    if (!pattern.test(value) || (!allowEmpty && value === "")) throw malformed(`the ${what} is not valid`);
    return value;
  };
  const method = text(TOKEN, "method", false);
  const scheme = text(TOKEN, "scheme", false);
  const authority = text(VISIBLE, "authority", true);
  const path = text(VISIBLE, "path", false);
  const headers = decodeFields(reader.section());
  const content = reader.section();
  const trailers = decodeFields(reader.section());
  reader.padding();
  return { method, scheme, authority, path, headers, content, trailers };
}

/** Encodes a response in the known-length form, without informational responses. */
export function encodeResponse(response: BinaryResponse): Uint8Array {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    throw malformed("the status code is not a final status code");
  }
  return concatBytes(
    varint(1),
    varint(response.status),
    encodeFields(response.headers),
    lengthPrefixed(response.content),
    encodeFields(response.trailers),
  );
}

/** Decodes a known-length response. Informational responses are validated and dropped. */
export function decodeResponse(message: Uint8Array): BinaryResponse {
  const reader = new Reader(message);
  const framing = reader.varint();
  if (framing === 3) throw malformed("the indeterminate-length form is not supported");
  if (framing !== 1) throw malformed("it is not a response");
  let status = reader.varint();
  for (let informational = 0; status >= 100 && status <= 199; informational++) {
    if (informational >= 16) throw malformed("too many informational responses");
    decodeFields(reader.take(reader.varint()));
    status = reader.varint();
  }
  if (status < 200 || status > 599) throw malformed("the status code is out of range");
  const headers = decodeFields(reader.section());
  const content = reader.section();
  const trailers = decodeFields(reader.section());
  reader.padding();
  return { status, headers, content, trailers };
}
