import { BHttpDecoder, BHttpEncoder } from "bhttp-js";
import { describe, expect, it } from "vitest";

import { type BinaryRequest, type BinaryResponse, decodeRequest, decodeResponse, encodeRequest, encodeResponse } from "../src/bhttp.js";
import { bytesToHex, concatBytes, hexToBytes } from "../src/bytes.js";
import { OhttpError } from "../src/errors.js";

const text = (value: string) => new TextEncoder().encode(value);
const hex = (spaced: string) => hexToBytes(spaced.replace(/\s+/g, ""));

/** RFC 9292, figure 8: known-length request. */
const RFC_REQUEST = hex(`
  00034745 54056874 74707300 0a2f6865 6c6c6f2e 74787440 6c0a7573 65722d61
  67656e74 34637572 6c2f372e 31362e33 206c6962 6375726c 2f372e31 362e3320
  4f70656e 53534c2f 302e392e 376c207a 6c69622f 312e322e 3304686f 73740f77
  77772e65 78616d70 6c652e63 6f6d0f61 63636570 742d6c61 6e677561 67650665
  6e2c206d 690000`);

/** RFC 9292, figure 9: the same request in the indeterminate-length form. */
const RFC_REQUEST_INDETERMINATE = hex(`
  02034745 54056874 74707300 0a2f6865 6c6c6f2e 7478740a 75736572 2d616765
  6e743463 75726c2f 372e3136 2e33206c 69626375 726c2f37 2e31362e 33204f70
  656e5353 4c2f302e 392e376c 207a6c69 622f312e 322e3304 686f7374 0f777777
  2e657861 6d706c65 2e636f6d 0f616363 6570742d 6c616e67 75616765 06656e2c
  206d6900 00000000 00000000 00000000`);

/** RFC 9292, figure 13: known-length response with content and a trailer. */
const RFC_RESPONSE = hex(`
  0140c800 1d546869 7320636f 6e74656e 7420636f 6e746169 6e732043 524c462e
  0d0a0d07 74726169 6c657204 74657874`);

const RFC_REQUEST_DECODED: BinaryRequest = {
  method: "GET",
  scheme: "https",
  authority: "",
  path: "/hello.txt",
  headers: [
    ["user-agent", "curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3"],
    ["host", "www.example.com"],
    ["accept-language", "en, mi"],
  ],
  content: new Uint8Array(0),
  trailers: [],
};

const malformed = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OhttpError);
    expect((error as OhttpError).code).toBe("malformed");
    return (error as OhttpError).message;
  }
  throw new Error("expected the message to be rejected");
};

describe("RFC 9292 examples", () => {
  it("decodes the known-length request of figure 8", () => {
    expect(decodeRequest(RFC_REQUEST)).toEqual(RFC_REQUEST_DECODED);
  });

  it("encodes the request of figure 8 byte for byte", () => {
    expect(bytesToHex(encodeRequest(RFC_REQUEST_DECODED))).toBe(bytesToHex(RFC_REQUEST));
  });

  it("accepts the request truncated by one and by two bytes, as section 5.1 says", () => {
    expect(decodeRequest(RFC_REQUEST.subarray(0, RFC_REQUEST.length - 1))).toEqual(RFC_REQUEST_DECODED);
    expect(decodeRequest(RFC_REQUEST.subarray(0, RFC_REQUEST.length - 2))).toEqual(RFC_REQUEST_DECODED);
  });

  it("decodes and re-encodes the known-length response of figure 13", () => {
    const decoded = decodeResponse(RFC_RESPONSE);
    expect(decoded).toEqual({
      status: 200,
      headers: [],
      content: text("This content contains CRLF.\r\n"),
      trailers: [["trailer", "text"]],
    });
    expect(bytesToHex(encodeResponse(decoded))).toBe(bytesToHex(RFC_RESPONSE));
  });

  it("refuses the indeterminate-length form (figure 9)", () => {
    expect(malformed(() => decodeRequest(RFC_REQUEST_INDETERMINATE))).toMatch(/indeterminate-length/);
    expect(malformed(() => decodeResponse(Uint8Array.of(3, 0x40, 0xc8, 0, 0, 0)))).toMatch(/indeterminate-length/);
  });
});

describe("codec", () => {
  const request: BinaryRequest = {
    method: "POST",
    scheme: "https",
    authority: "rpc.example:8443",
    path: "/?x=1",
    headers: [
      ["content-type", "application/json"],
      ["accept", "application/json"],
    ],
    content: text('{"jsonrpc":"2.0","id":1,"method":"getSlot"}'),
    trailers: [],
  };
  const response: BinaryResponse = {
    status: 502,
    headers: [["content-type", "application/json"]],
    content: text('{"jsonrpc":"2.0","id":null,"error":{"code":-32095,"message":"x"}}'),
    trailers: [],
  };

  it("round-trips a request and a response", () => {
    expect(decodeRequest(encodeRequest(request))).toEqual(request);
    expect(decodeResponse(encodeResponse(response))).toEqual(response);
  });

  it("lowercases field names and trims values when writing", () => {
    const encoded = encodeRequest({ ...request, headers: [["Content-Type", "  application/json "]] });
    expect(decodeRequest(encoded).headers).toEqual([["content-type", "application/json"]]);
  });

  it.each([63, 64, 16383, 16384, 70000])("round-trips content of %i bytes across the length encodings", (size) => {
    const content = new Uint8Array(size).map((_, i) => (i * 7 + 1) & 0xff);
    expect(decodeRequest(encodeRequest({ ...request, content })).content).toEqual(content);
    expect(decodeResponse(encodeResponse({ ...response, content })).content).toEqual(content);
  });

  it("uses the shortest length encoding (RFC 9000 examples)", () => {
    // 37 -> 0x25, 15293 -> 0x7bbd, 494878333 -> 0x9d7f3e7d
    expect(bytesToHex(encodeResponse({ status: 200, headers: [], content: new Uint8Array(37) })).slice(0, 10)).toBe("0140c80025");
    expect(bytesToHex(encodeResponse({ status: 200, headers: [], content: new Uint8Array(15293) })).slice(0, 12)).toBe("0140c8007bbd");
  });

  it("reads an eight-byte length and rejects one beyond what the message holds", () => {
    // Content length 5 written in eight bytes.
    const message = concatBytes(Uint8Array.of(1, 0x40, 0xc8, 0), hexToBytes("c000000000000005"), text("hello"));
    expect(decodeResponse(message).content).toEqual(text("hello"));
    expect(malformed(() => decodeResponse(concatBytes(Uint8Array.of(1, 0x40, 0xc8, 0), hexToBytes("ffffffffffffffff"))))).toMatch(/out of range/);
    expect(malformed(() => decodeResponse(concatBytes(Uint8Array.of(1, 0x40, 0xc8, 0), hexToBytes("c000000100000000"))))).toMatch(/longer than/);
  });

  it("treats zero bytes after the message as padding and anything else as an error", () => {
    const encoded = encodeRequest(request);
    const padded = new Uint8Array(4096);
    padded.set(encoded);
    expect(decodeRequest(padded)).toEqual(request);
    padded[4095] = 1;
    expect(malformed(() => decodeRequest(padded))).toMatch(/padding/);
  });

  it("drops informational responses", () => {
    // 102 with one field, 103 with none, then 200.
    const message = concatBytes(
      Uint8Array.of(1, 0x40, 0x66, 4, 1),
      text("a"),
      Uint8Array.of(1),
      text("b"),
      Uint8Array.of(0x40, 0x67, 0, 0x40, 0xc8, 0, 2),
      text("ok"),
    );
    expect(decodeResponse(message)).toEqual({ status: 200, headers: [], content: text("ok"), trailers: [] });
  });

  it.each([
    ["an empty message", ""],
    ["an unknown framing indicator", "04"],
    ["a response where a request is expected", "0140c8"],
    ["a request that ends inside the method", "00034745"],
    ["a request without a path", "00034745540568747470730b6578616d706c652e636f6d"],
    ["an empty method", "00000568747470730001" + "2f"],
    ["a method with a space", "000347205405687474707300012f"],
    ["a field section longer than the message", "000347455405687474707300012f05"],
    ["an empty field name", "000347455405687474707300012f020000"],
    ["a pseudo-field", "000347455405687474707300012f09073a6d6574686f6400"],
    ["a field value with a line feed", "000347455405687474707300012f040161010a"],
    ["a field name with a space", "000347455405687474707300012f0402612000"],
  ])("rejects %s", (_, bytes) => {
    malformed(() => decodeRequest(hexToBytes(bytes)));
  });

  it("rejects a response with a status outside 200..599 or with a request framing", () => {
    malformed(() => decodeResponse(Uint8Array.of(1, 0x42, 0x58))); // 600
    malformed(() => decodeResponse(Uint8Array.of(1, 0x32))); // 50
    malformed(() => decodeResponse(Uint8Array.of(0, 0x40, 0xc8)));
    malformed(() => encodeResponse({ status: 100, headers: [], content: new Uint8Array(0) }));
  });

  it("refuses to write a field that would be invalid", () => {
    malformed(() => encodeRequest({ ...request, headers: [["bad name", "x"]] }));
    malformed(() => encodeRequest({ ...request, headers: [["x", "a\r\nb"]] }));
    malformed(() => encodeRequest({ ...request, headers: [["x", "€"]] }));
    malformed(() => encodeRequest({ ...request, headers: [[":authority", "x"]] }));
    malformed(() => encodeRequest({ ...request, path: "/a b" }));
    malformed(() => encodeRequest({ ...request, method: "" }));
  });

  it("error messages never quote the message", () => {
    const secret = "5eCrEtPaTh";
    const message = malformed(() => decodeRequest(concatBytes(encodeRequest({ ...request, path: `/${secret}` }), Uint8Array.of(7))));
    expect(message).not.toContain(secret);
  });
});

// bhttp-js is a separate implementation of RFC 9292 (it is not used outside
// the tests). What this codec writes it must read, and the other way around.
describe("cross-check against bhttp-js", () => {
  const theirEncoder = new BHttpEncoder();
  const theirDecoder = new BHttpDecoder();
  const body = '{"jsonrpc":"2.0","id":"a","method":"getBalance","params":["11111111111111111111111111111111"]}';

  it("bhttp-js reads a request written here, also with padding", async () => {
    const ours = encodeRequest({
      method: "POST",
      scheme: "https",
      authority: "rpc.example",
      path: "/",
      headers: [
        ["content-type", "application/json"],
        ["accept", "application/json"],
      ],
      content: text(body),
    });
    for (const message of [ours, concatBytes(ours, new Uint8Array(500))]) {
      const theirs = theirDecoder.decodeRequest(message);
      expect(theirs.method).toBe("POST");
      expect(theirs.url).toBe("https://rpc.example/");
      expect(theirs.headers.get("content-type")).toBe("application/json");
      expect(theirs.headers.get("accept")).toBe("application/json");
      expect(await theirs.text()).toBe(body);
    }
  });

  it("this codec reads a request written by bhttp-js, and both write the same bytes", async () => {
    const theirs = await theirEncoder.encodeRequest(
      new Request("https://rpc.example/path?q=1", { method: "POST", headers: { "content-type": "application/json" }, body }),
    );
    const decoded = decodeRequest(theirs);
    expect(decoded).toMatchObject({ method: "POST", scheme: "https", authority: "rpc.example", path: "/path?q=1" });
    expect(decoded.headers).toEqual([["content-type", "application/json"]]);
    expect(new TextDecoder().decode(decoded.content)).toBe(body);
    expect(bytesToHex(encodeRequest(decoded))).toBe(bytesToHex(theirs));
  });

  it("bhttp-js reads a response written here", async () => {
    const ours = encodeResponse({ status: 429, headers: [["content-type", "application/json"]], content: text(body) });
    const theirs = theirDecoder.decodeResponse(ours);
    expect(theirs.status).toBe(429);
    expect(theirs.headers.get("content-type")).toBe("application/json");
    expect(await theirs.text()).toBe(body);
  });

  it("this codec reads a response written by bhttp-js, and both write the same bytes", async () => {
    const theirs = await theirEncoder.encodeResponse(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    const decoded = decodeResponse(theirs);
    expect(decoded.status).toBe(200);
    expect(decoded.headers).toEqual([["content-type", "application/json"]]);
    expect(new TextDecoder().decode(decoded.content)).toBe(body);
    expect(bytesToHex(encodeResponse(decoded))).toBe(bytesToHex(theirs));
  });

  it("both agree on the RFC's examples", async () => {
    const theirRequest = theirDecoder.decodeRequest(RFC_REQUEST);
    expect(theirRequest.url).toBe("https://www.example.com/hello.txt");
    const theirNames: string[] = [];
    theirRequest.headers.forEach((_, name) => theirNames.push(name));
    expect(theirNames.sort()).toEqual(RFC_REQUEST_DECODED.headers.map(([name]) => name).sort());
    const theirResponse = theirDecoder.decodeResponse(RFC_RESPONSE);
    expect(await theirResponse.text()).toBe("This content contains CRLF.\r\n");
  });
});
