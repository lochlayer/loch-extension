/**
 * @loch/sdk/wire: the relayer and screener HTTP protocol (v1). JSON types,
 * runtime validators, fetch-based clients, and the helpers both sides of the
 * deposit screening handshake need.
 *
 * This entry point does not load the prover (snarkjs) or Poseidon, so
 * services and UI code that only speak the protocol stay small. It makes no
 * network requests other than the ones a client is asked to make.
 */
export {
  WIRE_ERROR_CODES,
  WIRE_ERROR_STATUS,
  WIRE_VERSION,
  WireError,
} from "./wire/types.js";
export type {
  RelayRequest,
  RelayResponse,
  RelayerInfo,
  ScreenRequest,
  ScreenResponse,
  ScreenerInfo,
  WireCluster,
  WireErrorBody,
  WireErrorCode,
  WireExtData,
  WireNetworkErrorReason,
  WireProof,
  WireResult,
} from "./wire/types.js";
export {
  validateErrorBody,
  validateRelayRequest,
  validateRelayResponse,
  validateRelayerInfo,
  validateScreenRequest,
  validateScreenResponse,
  validateScreenerInfo,
} from "./wire/validate.js";
export { RelayerClient, ScreenerClient } from "./wire/client.js";
export type { WireClientOptions, WireFetch, WireRequestInit, WireResponse } from "./wire/client.js";
export { fromRelayRequest, toRelayRequest, toScreenRequest } from "./wire/convert.js";
export { checkRelayRequest } from "./wire/relay.js";
export type { RelayPolicy } from "./wire/relay.js";
export { MAX_LIGHTHOUSE_INSTRUCTIONS, applyScreenerSignature, inspectDepositTransaction, parseScreenTransaction } from "./wire/screening.js";
export type { DepositInspection, InspectDepositOptions } from "./wire/screening.js";
