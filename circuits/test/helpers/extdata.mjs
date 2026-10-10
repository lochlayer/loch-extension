// extDataHash exactly as programs/loch_pool/src/lib.rs::hash_ext_data computes it:
// sha256 over the Borsh encoding of ExtData, first byte cleared so the 32-byte
// big-endian value is always below the field modulus.
//
// Borsh layout of ExtData, in field order:
//   recipient          32 bytes
//   relayer            32 bytes
//   ext_amount         i64, little-endian
//   fee                u64, little-endian
//   encrypted_output0  u32 little-endian length, then the bytes
//   encrypted_output1  u32 little-endian length, then the bytes

import { createHash } from 'node:crypto';

import { fromBytesBE } from './field.mjs';

function expectBytes(value, length, name) {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) {
    throw new TypeError(`${name}: expected ${length ?? 'a'} byte Uint8Array`);
  }
  return value;
}

export function encodeExtData(ext) {
  const recipient = expectBytes(ext.recipient, 32, 'recipient');
  const relayer = expectBytes(ext.relayer, 32, 'relayer');
  const out0 = expectBytes(ext.encryptedOutput0, undefined, 'encryptedOutput0');
  const out1 = expectBytes(ext.encryptedOutput1, undefined, 'encryptedOutput1');

  const buf = Buffer.alloc(32 + 32 + 8 + 8 + 4 + out0.length + 4 + out1.length);
  let offset = 0;
  buf.set(recipient, offset);
  offset += 32;
  buf.set(relayer, offset);
  offset += 32;
  offset = buf.writeBigInt64LE(BigInt(ext.extAmount), offset);
  offset = buf.writeBigUInt64LE(BigInt(ext.fee), offset);
  offset = buf.writeUInt32LE(out0.length, offset);
  buf.set(out0, offset);
  offset += out0.length;
  offset = buf.writeUInt32LE(out1.length, offset);
  buf.set(out1, offset);
  return new Uint8Array(buf);
}

/** 32 bytes: sha256(borsh(ExtData)) with byte 0 set to zero. */
export function extDataHashBytes(ext) {
  const digest = createHash('sha256').update(encodeExtData(ext)).digest();
  digest[0] = 0;
  return new Uint8Array(digest);
}

/** The same hash as a field element (big-endian read), the circuit's extDataHash. */
export function extDataHash(ext) {
  return fromBytesBE(extDataHashBytes(ext));
}
