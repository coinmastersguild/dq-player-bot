# Funding, deposits and withdrawals

There are three separate balances and authorizations: your external wallet pays Base ETH for account access/gas; verified GOLD and DQS deposits credit their own custody ledger balances; the main-game character has gameplay state. Do not assume all character gold or simulated economy balances can be withdrawn as tokens.

## Give your agent funds to start

Run `create_wallet` and `funding_address` through Claude or `npm run setup`. Fund the returned **bot wallet**, using **Base mainnet ETH (chain ID 8453)**. ETH on Ethereum mainnet is a different network. This package does not bridge, buy tokens, access a project treasury or automatically refill the wallet.

Authenticate before checking the roster and admission. Login is a free message signature, not a transaction. Existing owned characters can play without purchasing another slot. A new character needs an available paid creation slot. The initial access product grants creation slots according to the current server response; inspect `access.slots` rather than hardcoding price or slot count.

`admission_quote` validates a fresh signed AlphaAdmissionV3 quote against the pinned Base contract, signer, beneficiary, amounts and expiry. Approve a **maximum total ETH including gas** for that exact purchase. `purchase_access` refuses a transaction whose value plus maximum gas cost exceeds it, and checks the wallet's pending balance and RPC chain identity before signing. Native Base gas funds and the admission purchase are not GOLD/DQS deposits.

The pending order, raw signed bytes and transaction hash are saved privately before broadcast. After a timeout, use `recover_payment` and inspect the same hash/order. Do not delete pending state or authorize a replacement transaction because a response was lost. Confirmation must acknowledge admission and available slots before this setup reports success. A confirmed receipt is retained after a slot is used.

The dedicated signer is `.secrets/bot-signer.json`, mode `0600`, in an owner-only directory. It is a software wallet: keep a private backup using your own secure backup tools. There is no seed recovery service. Keep only the owner's intended budget in this wallet. The autonomous game planner receives no wallet key or spending tool.

## GOLD and DQS custody

Use the official [token page](https://degenquest.ai/tokens) or its documented account API. Authenticate to `https://degenquest.ai` with the wallet that owns the funds. Sessions for `play.degenquest.ai` and `degenquest.ai` are separate. The bot MCP's `custody_status` handles this separate login and a read-only wallet view.

| Currency | Network | Decimals | Atomic units per token | Atomic units per copper |
| --- | --- | ---: | ---: | ---: |
| GOLD | Base mainnet, 8453 | 18 | 1,000,000,000,000,000,000 | 100,000,000,000,000 |
| DQS | Solana mainnet-beta | 8 | 100,000,000 | 10,000 |

Each token represents 10,000 copper in the dedicated token-backed ledger; sub-copper dust remains in atomic token units. GOLD and DQS remain separate currencies. An internal posting does not swap, bridge or merge them. This describes the custody ledger's units, not proof that every MMORPG reward is connected to it.

Read **`GET /api/wallet`** immediately before a transfer. Its `balances[]` entries include the linked `wallet`, `chain`, `chainId` or `genesis`, `token`, `decimals`, `custody`, `available`, `reserved`, `enabled` and `ready`, plus history. Amounts in wallet balances/history are atomic strings. Match the live token/network identity against [CONTRACTS.md](CONTRACTS.md). Stop if settlement is disabled, halted, mismatched or cannot be verified.

**Use the current custody destination returned by the authenticated wallet API.** A token contract/mint, admission contract, DEX pool, royal treasury and historical custody address are different things. Addresses in old review documents are not standing deposit instructions. ETH/SOL sent to a custody gas wallet funds service gas; it does not credit a GOLD/DQS token deposit.

## Deposit sequence

1. Own and authenticate the sending wallet. Prove any additional network wallet with `/api/wallet/challenge` and `/api/wallet/link`. Ownership of a public transaction hash is not ownership of the sending wallet.
2. Request `POST /api/wallet/deposit-transaction` with, for example, `{"currency":"GOLD","amount":"1"}`. `amount` is a **decimal token string**, never a floating-point number. Review the returned unsigned transaction before signing.
3. Verify chain/genesis, sender, exact pinned token, current custody destination and atomic amount. GOLD uses an ERC-20 `transfer` to custody, with zero native ETH value; it requires no unlimited approval. DQS uses the pinned mint, linked owner, custody associated token account and `TransferChecked` with 8 decimals. Do not send SOL in place of DQS.
4. Sign with your own wallet. Submit through that wallet or `POST /api/wallet/deposit-broadcast` with `{"currency":"GOLD","raw":"SIGNED_BYTES"}` (Solana raw bytes are base64). Save the exact hash before retrying anything. Never publish raw signing material.
5. Register/check `POST /api/wallet/deposits` with `{"currency":"GOLD","txHash":"YOUR_TRANSACTION_HASH"}`. The service verifies finalized chain evidence and the actual sender before crediting. A pending transaction is not a credit. Repeating the same verified hash must not credit twice.
6. Check wallet history and the credited atomic amount. Insufficient sender gas, wrong token/chain/destination, missing ownership proof or non-finalized evidence must be resolved rather than treated as successful funding.

Use `DQS` with the Solana wallet for the corresponding path. The bundled operator does not sign token deposits or manage Solana keys; these are owner wallet operations.

## Withdraw sequence

1. Read current wallet configuration, available/reserved balance, history and readiness. Use the linked destination wallet you control for that currency. Only available balance can be withdrawn; service limits, liquidity, gas and network readiness apply.
2. Request `POST /api/wallet/withdrawal-challenge` with your currency, **decimal token amount** and linked destination, for example `{"currency":"GOLD","amount":"1","destination":"YOUR_LINKED_BASE_WALLET"}`.
3. Inspect the exact returned message. It binds `https://degenquest.ai`, account principal, network identity, pinned token, human and atomic amounts, destination, custody, unique withdrawal ID and expiry. The challenge lasts two minutes. A login signature, session cookie or JWT cannot authorize a withdrawal.
4. Sign those exact UTF-8 message bytes with the linked wallet: EIP-191 for GOLD/Base, Ed25519 with the Solana wallet for DQS. Approve only this amount and destination. Do not sign a substituted message or a generic spending permission.
5. Submit `POST /api/wallet/withdrawals` with `id`, `currency`, **the original decimal `amount`**, `destination`, and `signature`. The challenge response's `amount` field is atomic; do not submit that atomic field as a decimal token amount.
6. Save the request ID and payout hash. A submitted/reserved/pending result is not final delivery. Verify finalized payout and wallet history. If the response is lost, reconcile history using `withdraw-<challenge-id>` or retry the **identical signed request**. Do not create another challenge/payment while the first outcome is unknown.

An unknown payout remains reserved for reconciliation; a proven failed payout can refund once. A consumed signature can only return its immutable original receipt. Changing amount, destination or currency requires a new explicit authorization after resolving the prior request. Never bypass a custody halt or treat it as permission to fund a new address.

## What is verified here

The docs were reconciled against the local main-game authentication/admission code, dedicated custody service and deployment records. Read-only mainnet calls verified token identities and admission state for this release; see the dated record in CONTRACTS.md. Prior operator deposit experiments are not a promise of today's custody readiness or a fresh withdrawal test. This publication performs no paid admission, token deposit or withdrawal. Always re-read live configuration and check the actual receipt before reporting success.
