# Operate through Claude

Claude Code can read this clone's CLAUDE.md and use the CLI directly. Claude Desktop uses the stdio MCP entry from README.md. The MCP is an operator for the existing local application: registering it does not create a game socket. It never returns the private signer. The GLM executor remains the character's controller.

## Tool sequence

| Step | Tool | Result |
| --- | --- | --- |
| 1 | `create_wallet` | Reuses or creates one dedicated Base wallet; public address only |
| 2 | `funding_address` | Address and Base ETH balance; owner funds it externally |
| 3 | `authenticate` | Free fresh official wallet-signature login |
| 4 | `account_status` | Account, owned heroes, realm and available creation slots |
| 5 | `admission_quote` | Expiring signed quote, or skip when a hero/slot exists |
| 6 | `purchase_access` | Only after explicit approval, with `maxTotalEth` and `ownerApproved: true` |
| 7 | `claim_name`, `character_options`, `create_character` | Owner-selected account/hero; existing hero can be reused |
| 8 | `configure_bot` | Verify owned hero, release, navigation and GLM model; preserve Stop |
| 9 | `open_app`, `start_bot` / `stop_bot` | Open viewer and control the one local GLM player |
| 10 | `bot_status`, `custody_status` | Observe play or separately authenticated token service |

`read_docs` exposes the packaged onboarding, funding, contracts and runtime documents. `recover_payment` confirms a saved payment hash without signing a replacement. It can need another check after chain confirmation; an unknown response is not evidence of failed payment.

## Terminal equivalents

```sh
npm run setup -- create_wallet
npm run setup -- funding_address
npm run setup -- authenticate
npm run setup -- account_status
npm run setup -- admission_quote
```

After personally reviewing and approving a quote and a budget, call `purchase_access` through Claude or the CLI with your approved decimal `maxTotalEth` and `ownerApproved: true`. No universal budget is supplied here; price and gas vary. Do not copy an example number into a live payment.

```sh
npm run setup -- claim_name '{"name":"YourAccountName"}'
npm run setup -- character_options
npm run setup -- create_character '{"name":"YourHeroName","baseId":"high-elf-male","classId":"mage"}'
```

Character names must be 2–16 ASCII letters; account names 3–24 ASCII letters, digits or underscores. Choose your own unused names. Read your resulting roster ID, then configure it, replacing `123` below:

```sh
npm run setup -- configure_bot '{"characterId":123,"glmBaseUrl":"http://127.0.0.1:8000/v1"}'
npm run setup -- open_app
```

For Alpha, use `https://alpha.pioneers.dev/api/v1` and add `"glmTokenFile":"/absolute/private/path/glm.json"` to the configuration arguments. The file contains `{"token":"YOUR_OWN_CREDENTIAL"}` and must be mode `0600`. Create it privately in your editor; never paste a credential into Claude or shell history. The exact model must appear in `/models` and in completion responses. A localhost router must actually serve that model; renaming another model is not valid.

Then click **Start** or instruct Claude to call `start_bot`. `stop_bot` persists Stop. The current intent panel shows a brief action rationale, not private chain-of-thought.

## Owner wallet and custody operations

The first-run signer is a dedicated local software wallet. Existing/hardware/Solana wallet import, token purchase/swap, automated deposits and withdrawal signing are not exposed by this operator MCP. Use your normal owner-controlled wallet and the official [token interface](https://degenquest.ai/tokens), following [FUNDING.md](FUNDING.md). Claude can explain or review the exact transaction, chain, token, destination and amount before you approve it. It must not request private keys in chat.

`custody_status` authenticates to `degenquest.ai` separately and reads `/api/wallet`; the main game's cookie is not forwarded across hosts. Any cross-chain wallet must first be linked with fresh proof of ownership. Funding an unrelated wallet does not automatically fund the dedicated bot account.
