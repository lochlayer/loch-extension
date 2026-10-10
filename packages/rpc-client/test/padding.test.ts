import { describe, expect, it } from "vitest";

import { decodeRequest, encodeRequest } from "../src/bhttp.js";
import { RpcClientError } from "../src/errors.js";
import { DEFAULT_REQUEST_PADDING_BUCKETS, DEFAULT_RESPONSE_PADDING_BUCKETS, normaliseBuckets, padMessage, paddedLength } from "../src/padding.js";

describe("padding buckets", () => {
  it("pads to the smallest bucket that holds the message", () => {
    const buckets = [4096, 16384, 65536];
    expect(paddedLength(0, buckets)).toBe(4096);
    expect(paddedLength(1, buckets)).toBe(4096);
    expect(paddedLength(4096, buckets)).toBe(4096);
    expect(paddedLength(4097, buckets)).toBe(16384);
    expect(paddedLength(65536, buckets)).toBe(65536);
  });

  it("pads to a multiple of the largest bucket beyond it", () => {
    const buckets = [4096, 16384, 65536];
    expect(paddedLength(65537, buckets)).toBe(131072);
    expect(paddedLength(131072, buckets)).toBe(131072);
    expect(paddedLength(131073, buckets)).toBe(196608);
  });

  it("does nothing without buckets", () => {
    expect(paddedLength(1234, [])).toBe(1234);
    const message = Uint8Array.of(1, 2, 3);
    expect(padMessage(message, [])).toBe(message);
  });

  it("the defaults are ascending powers of four from 4 KiB", () => {
    expect(DEFAULT_REQUEST_PADDING_BUCKETS).toEqual([4096, 16384, 65536, 262144]);
    expect(DEFAULT_RESPONSE_PADDING_BUCKETS).toEqual([4096, 16384, 65536, 262144, 1048576, 4194304]);
  });

  it("sorts and deduplicates a bucket list and rejects nonsense", () => {
    expect(normaliseBuckets([300, 100, 300, 200])).toEqual([100, 200, 300]);
    expect(normaliseBuckets([])).toEqual([]);
    for (const bad of [[0], [-1], [1.5], [Number.NaN], [2 ** 27], ["4096"], "4096"]) {
      expect(() => normaliseBuckets(bad as never)).toThrow(RpcClientError);
    }
  });

  it("appends zeros only, and the padded message decodes to the same request", () => {
    const request = {
      method: "POST",
      scheme: "https",
      authority: "rpc.example",
      path: "/",
      headers: [["content-type", "application/json"]] as [string, string][],
      content: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"getSlot"}'),
    };
    const encoded = encodeRequest(request);
    const padded = padMessage(encoded, [512, 1024]);
    expect(padded.length).toBe(512);
    expect(padded.subarray(0, encoded.length)).toEqual(encoded);
    expect(padded.subarray(encoded.length).every((byte) => byte === 0)).toBe(true);
    expect(decodeRequest(padded)).toEqual({ ...request, trailers: [] });
  });

  it("messages of very different sizes within a bucket become indistinguishable by length", () => {
    const lengths = [90, 180, 700, 1900, 4000].map((size) => padMessage(new Uint8Array(size), DEFAULT_REQUEST_PADDING_BUCKETS).length);
    expect(new Set(lengths)).toEqual(new Set([4096]));
  });
});
