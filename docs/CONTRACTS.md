# Live networks and contracts

Read-only verification recorded **2026-11-05 UTC** (November 4 in the operator's local timezone). These are mainnet identities from the local deployment records, checked directly over chain RPC. They are not instructions to deposit into these addresses.

| Purpose | Network | Address | Precision |
| --- | --- | --- | --- |
| GOLD token, ERC-20 | Base, chain 8453 | [`0x2218b3908B2f33B75241397a26fB27383cd8B35c`](https://basescan.org/token/0x2218b3908B2f33B75241397a26fB27383cd8B35c) | 18 decimals |
| DQS token, SPL mint | Solana mainnet-beta | [`2kma6VS71GtVthg7eg7nm1r3HCDLEeXWPtVWbsH5dyZg`](https://solscan.io/token/2kma6VS71GtVthg7eg7nm1r3HCDLEeXWPtVWbsH5dyZg) | 8 decimals |
| AlphaAdmissionV3 | Base, chain 8453 | [`0x7467B837967a605eBEaAAfDD973f76b8037240ba`](https://basescan.org/address/0x7467B837967a605eBEaAAfDD973f76b8037240ba) | Signed access purchases in native ETH |

Solana mainnet genesis: `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. DQS uses the standard SPL Token program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.

## Admission identity

The expected quote signer is `0x7E79501c7b927bD2De1de7A03A5F664111c0d879`. The V3 EIP-712 domain is `DegenQuest Alpha Admission`, version `3`, Base chain `8453`, verifying contract above. `src/admission.mjs` validates the signed quote and encodes only `purchaseFor` with the quoted order, beneficiary, ETH/swap/burn amounts and expiry. An admission payment is distinct from a token custody deposit.

Deployment transaction: [`0x1751771bd51f19672f5b85ac28ac58b49579d0cfdd6faee9b5489ade8c1cb606`](https://basescan.org/tx/0x1751771bd51f19672f5b85ac28ac58b49579d0cfdd6faee9b5489ade8c1cb606), block 52,104,360. Activation: [`0x93cd098cd808dc643fe0a27281e22c9f873057ec1b7638a5db37988a37bac95f`](https://basescan.org/tx/0x93cd098cd808dc643fe0a27281e22c9f873057ec1b7638a5db37988a37bac95f), block 52,105,984.

Relevant Base deployment dependencies: WETH `0x4200000000000000000000000000000000000006`; Aerodrome router `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`; factory `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`. These are deployment references, not user funding addresses. The DQS liquidity pool reference is `GFzcu8pMqoAJBZTMFtcEpUQjKYHKmXaJK9362vcuW3Tc`; a liquidity pool is not a custody destination.

## Recheck before use

Using Foundry's `cast`:

```sh
cast chain-id --rpc-url https://mainnet.base.org
cast call 0x2218b3908B2f33B75241397a26fB27383cd8B35c 'symbol()(string)' --rpc-url https://mainnet.base.org
cast call 0x2218b3908B2f33B75241397a26fB27383cd8B35c 'decimals()(uint8)' --rpc-url https://mainnet.base.org
cast call 0x7467B837967a605eBEaAAfDD973f76b8037240ba 'paused()(bool)' --rpc-url https://mainnet.base.org
cast call 0x7467B837967a605eBEaAAfDD973f76b8037240ba 'quoteSigner()(address)' --rpc-url https://mainnet.base.org
```

At verification the token reported `GOLD`, 18 decimals; admission reported `paused=false` and the signer above. A fresh unfunded bot account authenticated and obtained a V3 quote that passed the validator; no payment was sent. The quote's price is intentionally not a permanent price in this guide.

```sh
curl -sS https://api.mainnet-beta.solana.com \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'
curl -sS https://api.mainnet-beta.solana.com \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["2kma6VS71GtVthg7eg7nm1r3HCDLEeXWPtVWbsH5dyZg",{"commitment":"finalized"}]}'
```

The finalized DQS supply check at slot **465,508,073** returned 8 decimals and atomic supply `2100000000000000` (21,000,000 DQS). A mint-account check found the standard SPL Token owner, initialized mint, and no mint or freeze authority. These are dated observations; recheck live state rather than assuming it is unchanged.

Token identity and an unpaused admission contract do not establish custody liquidity, current gas, account eligibility or end-to-end settlement. Before any deposit/withdrawal, independently read the current authenticated `/api/wallet` configuration, readiness and history as described in [FUNDING.md](FUNDING.md). No historical treasury or custody address is hardcoded as a standing deposit instruction.

## Documentation provenance

This guide was reconciled against the local Base V3 deployment record, main-game account/authentication handlers, native admission validator, dedicated custody HTTP API, chain adapters and withdrawal authorization implementation. Older custody review snapshots and Arena-only quickstarts were distinguished from the currently intended main-game workflow. Public links above are explorer references; no web search was used to derive these pins.
