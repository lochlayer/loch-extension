# Loch extension

Loch is a privacy layer for Solana. This is the source of its browser extension: a shielded balance inside the wallet you already use, with no new seed phrase.

- **Dive in:** deposit SOL from your wallet into a shared pool, the Loch.
- **Send privately:** pay another shielded address. Sender, recipient and amount stay off the public record.
- **Surface:** withdraw to any Solana address.

Website: [lochlayer.com](https://lochlayer.com) · Install: [lochlayer.com/install](https://lochlayer.com/install) · Docs: [lochlayer.com/docs](https://lochlayer.com/docs) · Cautions: [lochlayer.com/#cautions](https://lochlayer.com/#cautions)

## Install

For Chrome, Brave and Edge. The extension is not in a browser store yet: download the build and follow the steps at [lochlayer.com/install](https://lochlayer.com/install), or build it yourself as below.

It works beside your Solana wallet. Phantom has been tried; Solflare and Backpack should work and have not been tried yet. Read the [cautions](https://lochlayer.com/#cautions) before you put funds in.

## Build it yourself

You need Node 22 and pnpm 9 (`corepack enable` gives the pinned version).

```sh
pnpm install --frozen-lockfile
pnpm build:mainnet
```

The result is `apps/extension/dist-mainnet`. Open `chrome://extensions`, turn on Developer mode, press "Load unpacked" and choose that folder.

The build checks the two prover files against their recorded SHA-256 and stops if they differ. `pnpm build` makes a development build in `apps/extension/dist` instead, which talks to services on your own machine. `pnpm test` runs the unit tests of every package and `pnpm typecheck` checks the types.

## How it works

- **Keys from your wallet.** The extension asks your wallet to sign one message, `Loch key derivation v1`, and derives the shielded keys from that signature: `seed = sha256(signature)`, `privKey = seed mod p`, `pubKey = Poseidon(privKey)`. Sign that message nowhere else.
- **Notes.** Value in the pool exists as notes `(amount, pubKey, blinding)`. The chain stores only the commitment `Poseidon(amount, pubKey, blinding)`, in a Merkle tree of depth 20.
- **Join-split.** Every transaction spends two notes and creates two. A Groth16 proof over BN254 shows that the inputs are in the tree, that the sender owns them and that value is conserved, without saying which notes were spent.
- **Nullifiers.** A spent note publishes `Poseidon(commitment, leafIndex, Poseidon(privKey, commitment, leafIndex))`. The program records it, so a note cannot be spent twice.
- **Proving on your device.** The prover runs in an offscreen document of the extension, in about 3.5 seconds. Your keys and notes never leave the browser.
- **Relayer.** Private transfers and withdrawals are submitted by a relayer, so your wallet does not appear on chain. Its fee comes out of the shielded amount, and the extension refuses a fee above the maximum you set.
- **Screening.** A deposit carries the co-signature of a screening service. Withdrawals need no one's permission.
- **Encrypted notes.** The extension finds your notes by scanning the pool and decrypting with an X25519 key. Notes you keep, and payments to a payment code, are also keyed with a pre-shared secret.
- **Leak warnings.** The extension can read your wallet's public history and warn before a transfer gives something away.
- **No telemetry.** The extension talks to the RPC endpoint, the relayer and the screening service you see in its settings, and to nothing else.

## On mainnet

| | |
| --- | --- |
| Program | `Lochn2sJLT2hkqMrx85siFPXa9VUTAAx9EXmkPiJL2j` |
| Address lookup table | `EUauH5aJhqp3NfahYCQj4PBF5bQgq7TxtkqrsQ6uUt5S` |
| RPC endpoint | `https://rpc.lochlayer.com` |
| Relayer | `https://relayer-mainnet.lochlayer.com` |
| Screening service | `https://screener-mainnet.lochlayer.com` |
| Connect page | `https://connect.lochlayer.com/connect.html` |

## What is here

| Path | What it is |
| --- | --- |
| `apps/extension` | The extension (Manifest V3): background worker, popup and full-page interface, the in-page wallet wrapper, the prover's offscreen document |
| `packages/sdk` | Keys, addresses, notes, the Merkle tree, sync, proving, and the clients of the relayer and the screening service |
| `packages/scanner-core` | The leak analysis: what a wallet's public history gives away |
| `packages/rpc-client` | An RPC client that can send requests through Oblivious HTTP (RFC 9458) |
| `packages/design` | Styles, fonts, icons and the mark |
| `circuits/artifacts/devnet` | The prover files the extension ships (`transaction.wasm`, `transaction_final.zkey`), the verification key and their manifest |

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Settings, the encrypted vault, the session secret |
| `offscreen` | The document the prover runs in |
| Hosts of the default RPC endpoint, relayer and screening service | The three services the extension talks to. Another address is asked for one origin at a time, when you save it in settings |
| Content scripts on all sites | The Loch wallet a site is offered, and the warning dialog. The scripts read nothing of a page |

## Token

$LOCH token address: `CYGidBuS8WwUXfZCmb98LnLGL9Mx8SvhdqA6t3xTLoch`

A token at any other address is not ours.

## Licence

Copyright © 2026 Loch. All rights reserved. The source is published to be read, reviewed and checked against the released builds. It may not be copied, modified or redistributed without written permission. See [`LICENSE`](LICENSE). Third-party components keep their own licences.
