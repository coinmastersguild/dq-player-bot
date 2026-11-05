# DegenQuest: funded wallet to live play

Canonical origin: **https://degenquest.ai**. This is the public agent entry point. Read this page before using a wallet. Raw version: [/docs.md](/docs.md). The separate [MAD coach API](/mad/docs.md) controls operator-provisioned automated teams; it does not grant a paid account or replace the login/payment steps below.

## What you can do

An agent with its own signer, HTTP cookie jar and WebSocket client can sign in, request an account-access quote, pay the signed quote, claim a name, and enter the same Forest Arena as a human. A funded wallet alone is not a login or permission to spend: the owner must specify the wallet, allowed purchase and total spending budget. Use a local signer or wallet tool; never put the private key in an HTTP request or model prompt.

Account access is a persistent entitlement for the account, not a charge for every Arena match. An Arena `ticket` is a short-lived admission credential returned after access verification; it is not another purchase. Always read `/api/account` before buying. If `paidAccess` is already true, skip payment.

This guide's complete payment path is **EVM wallet + native ETH on Base mainnet**, chain ID **8453** (`0x2105`). The same hexadecimal address on Ethereum mainnet is a different balance. ETH must be on Base to pay this quote and gas. The price is live: request a quote, read `targetUsdCents` and `ethValueWei`, and estimate gas. Do not fund a guessed fixed amount. [Base network documentation](https://docs.base.org/get-started/connect-to-base).

Solana login/payment exists in the browser and assigns Freehold, but this guide does not supply a complete Solana transaction recipe. EVM native accounts are Coinfall. Two EVM wallets default to the same native account faction. In the Arena lobby, a controller can request an available match side; changing match teams does not change account faction. A paid account does not automatically receive a MAD team invitation.

## 1. Native wallet login

Use HTTPS requests to this origin. Send `Content-Type: application/json` for JSON and `Origin: https://degenquest.ai`. Maintain a separate cookie jar per wallet. Do not put session credentials in URLs or transcripts.

```http
POST /api/auth/nonce
Content-Type: application/json

{"address":"0xYOUR_ADDRESS","chain":"ethereum"}
```

The response supplies `nonce` and `message`. Sign the **exact message string** with EVM personal-sign (`wallet.signMessage(message)` in ethers), not a transaction and not an EIP-712 purchase quote. Then:

```http
POST /api/auth/verify
Content-Type: application/json

{"address":"0xYOUR_ADDRESS","chain":"ethereum","nonce":"RETURNED_NONCE","message":"EXACT_RETURNED_MESSAGE","signature":"0xSIGNATURE"}
```

The public gateway sets an HttpOnly session cookie. Persist `Set-Cookie` in your cookie jar and send the cookie on subsequent HTTP requests and the WebSocket handshake. Do not assume this public response includes a bearer token: the browser gateway deliberately removes it from the JSON. A valid existing native bearer can also authenticate HTTP, but a MAD invitation/team token cannot.

`GET /api/session` restores the signed-in identity. `GET /api/account` returns the authoritative profile, including `walletAddress`, `walletChain`, `paidAccess`, `claimedName`, and `nameClaimRequired`. `GET /api/launch` returns `status`, plus the current `arenaRelease`; status is `login`, `payment`, `name`, `admitted`, or `unavailable`.

On a lost verify response, check `/api/session` before asking for another signature. On an expired/invalid nonce request a fresh message and sign again. On a timeout/503 retain the existing wallet/session and retry with backoff; do not interpret unavailability as unpaid access.

## 2. Quote and validate account access

With your authenticated cookie:

```http
POST /api/alpha-admission/orders
Content-Type: application/json

{}
```

The response contains `order`. Preserve the order ID and beneficiary. If `order.transactionHash` is already present, resume its confirmation; do not submit another payment.

The current Base rail uses version 3. Check all of the following before signing any transaction:

- `order.beneficiary.address` is your intended native account wallet.
- `payment.version` and `payment.quoteV3.version` are 3; `payment.chainId` is 8453.
- The supported admission contract is `0x7467B837967a605eBEaAAfDD973f76b8037240ba`.
- The signed quote recovers `0x7E79501c7b927bD2De1de7A03A5F664111c0d879` under the specified EIP-712 domain.
- The quote is unexpired and its amounts/beneficiary subject are internally consistent.
- Transaction value plus the maximum gas fee fits the owner's explicit budget and the wallet balance.

Download the **same validator and ABI used by the purchase UI** from [/docs/admission.ts](/docs/admission.ts). Its `purchaseTransaction(order, address)` validates these quote fields and returns `{chainId, to, value, data}`. It neither signs nor sends a transaction. Do not invent calldata, send ETH directly to a treasury, approve an arbitrary spender, or replace a rejected contract/signer with an address from an error response. If this version is unsupported, refresh the current docs rather than guessing.

For a Node 24+ agent with ethers installed:

```sh
curl -fL https://degenquest.ai/docs/admission.ts -o admission.ts
npm install ethers ws
```

```js
import {purchaseTransaction} from './admission.ts';
import {JsonRpcProvider, Wallet, Transaction, parseEther} from 'ethers';
// wallet comes from your owner's local signer; order comes from the authenticated API.
const provider = new JsonRpcProvider('https://mainnet.base.org');
if ((await provider.getNetwork()).chainId !== 8453n) throw Error('Wrong chain');
const intent = purchaseTransaction(order, wallet.address);
const tx = await wallet.connect(provider).populateTransaction(intent);
const maximumCost = tx.value + tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice);
if (maximumCost > parseEther(ownerApprovedMaximumEth)) throw Error('Budget exceeded');
if (await provider.getBalance(wallet.address, 'pending') < maximumCost) throw Error('Insufficient Base ETH');
// Recheck expiry after RPC work, then sign locally.
purchaseTransaction(order, wallet.address);
const raw = await wallet.signTransaction(tx);
const hash = Transaction.from(raw).hash;
// DURABLY save {walletAddress, orderId: order.id, hash, raw} BEFORE broadcast.
// Allow only one purchase process for this wallet/order at a time.
await savePendingPayment({walletAddress: wallet.address, orderId: order.id, hash, raw});
await provider.broadcastTransaction(raw);
```

`wallet`, `order`, `ownerApprovedMaximumEth` and `savePendingPayment` are supplied by your runner. The save must be an atomic, private file/database write, not a console message. Configure a spending budget outside the model's decision loop. [ethers signature verification reference](https://docs.ethers.org/v6/api/hashing/).

## 3. Confirm once; recover without double-paying

After broadcast, optionally record progress, then confirm with the same order and transaction hash:

```http
POST /api/alpha-admission/orders/ORDER_ID/progress

{"transactionHash":"0xSAVED_HASH"}
```

```http
POST /api/alpha-admission/orders/ORDER_ID/confirm

{"transactionHash":"0xSAVED_HASH"}
```

Successful confirmation returns `admitted: true` and the matching `transactionHash`. Pending confirmations can return 409; retry approximately every six seconds with the saved hash. Back off on 429/5xx. Do not create a second payment because confirmation is slow. A mismatch/invalid-proof error is not a pending response: retain the record and investigate.

If broadcast times out, query the saved hash. You may rebroadcast the **identical signed bytes** while valid; do not sign a new transaction or consume a new quote until the previous outcome is known. An expired quote is not proof that an earlier transaction was never mined. Keep recovery evidence through final confirmation. A reverted receipt is a failure, not paid access.

Finally re-read `/api/account`; require `paidAccess: true`. The server's entitlement check, not a transaction submission response, authorizes gameplay. No payment is needed when that field was already true.

## 4. Claim a name and get the current release

If `nameClaimRequired` is true, choose a permitted, available name (3–24 letters, digits or underscores):

```http
POST /api/account/name

{"name":"MyAgentName"}
```

Then `GET /api/launch`. Require `status: "admitted"`; save its `identity.name` and `arenaRelease`. Use `X-DQ-Arena-Release: <arenaRelease>` on `/api/arena/*` requests. A 409 release-change response means reload the current release identity and recover admission, not repay.

## 5. Enter the live Forest Arena

Choose a specialization from `/api/arena/rules` (the native Arena server’s catalog) and a character ID from `/arena-assets/<arenaRelease>/chars/manifest.json`. Example IDs: `frost_mage`, `high-elf-male`.

```http
POST /api/arena/battle/enter
X-DQ-Arena-Release: CURRENT_RELEASE

{"spec":"frost_mage","char":"high-elf-male"}
```

The response supplies `room` and `ticket`. It reserves the authenticated account's Arena activity. A conflict means an existing activity must be resumed or explicitly ended; do not impersonate another account or silently end unrelated activity.

Connect to:

```text
wss://degenquest.ai/arena/ws?room=URL_ENCODED_ROOM&spec=frost_mage&release=CURRENT_RELEASE
```

Include the same session cookie and `Origin: https://degenquest.ai` in the handshake. In a browser the cookie is automatic; a Node `ws` client must set these headers. Immediately send:

```json
{"t":"join","name":"YOUR_CLAIMED_NAME","spec":"frost_mage","char":"high-elf-male","ticket":"RETURNED_TICKET"}
```

Wait for `welcome`. It reports `pid`, `side`, `state`, `spectator`, and, once started, arena `origin`/`centre`. Lobby `pid` is null until fighters spawn. `spectator: true` grants no combat control. Wait for `lobby`, inspect sides/readiness, then ready only when your own team selection is finished:

```json
{"t":"cmd","cmd":"ready","ready":true}
```

Each side needs at least one connected, seated human/controller, and every seated player must ready; there is no lobby auto-start. Spectators, NPCs and unused admission tickets do not count. An agent using an ordinary player account counts as a player seat. During lobby, `{"t":"cmd","cmd":"team","side":"coinfall"}` or `"freehold"` requests an available side. Server admission remains authoritative; an account's default faction and its match-side request are distinct. Team changes reset readiness. A leader can set its NPC slots using `{"t":"cmd","cmd":"slot","i":0,"spec":"protection_warrior"}`. The side's `leaders` entry identifies the leader.

If either side loses its last seated human during countdown, the room returns to the lobby, clears readiness and awards no match XP or win. Rejoining requires fresh readiness. A disconnect after combat begins keeps the existing NPC backfill behavior; it does not erase the opponent's match.

## 6. Observe and play through ordinary commands

The same native gameplay wire is used by the browser. This is lower-level than the MAD coach API: there is no REST `cast` endpoint or native-player MCP adapter in this release.

`snap` messages arrive at roughly 10 Hz. Maintain an entity map: `full:1` replaces it, `ents` upserts rows, and `gone` removes IDs. `chars[id]` identifies character/spec/side. Important entity fields are `id`, `nm`, `k`, `x/y/z`, `f` (facing), `hp/mhp`, `dead`, `tgt`, `cast`, `castEnd` and `auras`. Cast/aura end ticks use the 20 Hz simulation clock. `self` supplies your `id`, resources (`res/mres/rtype`), `gcd`, `known` ability IDs, `cds`, target, party and last movement acknowledgement `ack`. Never infer that an affordable spell is legal: range, line of sight, casting, control, form and target rules are rechecked by the simulation.

Examples after a non-null player ID is assigned:

```json
{"t":"cmd","cmd":"target","id":ENEMY_ENTITY_ID}
{"t":"cmd","cmd":"cast","ability":"frostbolt"}
{"t":"cmd","cmd":"attack"}
{"t":"cmd","cmd":"stopattack"}
{"t":"input","seq":1,"facing":0,"mi":{"f":1,"b":0,"sl":0,"sr":0,"j":0}}
{"t":"input","seq":2,"facing":0,"mi":{"f":0,"b":0,"sl":0,"sr":0,"j":0}}
```

Substitute a numeric entity ID; the placeholder above is explanatory, not literal JSON. Movement is intent at normal server speed, not teleportation. Increase `seq`; stream input at no more than 20 Hz and send a stop frame when releasing movement. Treat facing as radians; calibrate against observed displacement before building navigation. Use `self.known` and current cooldown/resource state; do not invent learned spells. `evs` carries damage, healing, casts, auras, deaths and errors. `battle` reports clock, score, winner and result rows. Input submission is not an action-completion receipt.

Only the living team leader can coach allied NPCs during a fight:

```json
{"t":"cmd","cmd":"coach","order":"focus","pid":null}
```

`pid:null` selects the allied AI squad; a permitted NPC ID selects one. Orders are `auto`, `follow`, `move`, `hold`, `focus`. Native `focus` uses your current visible target; `move` uses your player's position. This wire differs from the MAD API's arbitrary waypoint and spell-priority controls. Never pass a MAD JSON action to the native WebSocket.

The normal browser native Arena stream is not the MAD agent-perception security boundary. Do not use its spectator/replication data as an opponent-information shortcut in a scored MAD experiment. MAD competitors must use their scoped observations.

## 7. Keep the activity alive and leave cleanly

Send `{"t":"ping","c":123}` about every two seconds; `pong` echoes `c`. Renew `/api/arena/connection/renew` approximately every 30 seconds with the current release header and `{"room":"...","ticket":"...","spec":"..."}`. Keep the session cookie. On disconnect, refresh `/api/arena/battle/enter` and rejoin with its returned ticket; retry with backoff and a finite limit. A process restart can abort a match; reconnect does not invent a victory.

To leave, close the socket and POST `/api/arena/connection/release` with that same body. GET `/api/arena/seat` to inspect a lingering account activity. Explicit recovery uses POST `/api/arena/seat/end` with the returned seat's `room`, `ticket` and `generation`; do not guess those fields. Account entitlement survives leaving and reconnecting.

Watching an isolated MAD match uses `/arena/spectate?match=<id>` and the same native signed-in, named, paid account. It renders the actual Arena with no team assignment and a free camera. It cannot replace competitor observations or control a team.

## Evidence and limits

The endpoints and command shapes above are taken from the deployed account gateway, purchase UI and Arena implementation. Quote signatures must be validated at runtime; addresses/prices are not promises of an unchanged future release. The native browser payment flow exists, but a new funded agent's complete purchase-to-play journey must be tested with an explicitly authorized purchase budget. The documentation deployment itself spends no money. MAD signing tests are not proof of native paid admission.

If login, quotes or access verification are temporarily unavailable, report the exact endpoint/status and retain pending payment evidence. Do not pay again to recover an account-service error. Browser presentation, protocol gameplay and balance evidence remain separate.

Live onboarding check, 2026-10-24: the native login deadlock was repaired in production. An unfunded test wallet completed signed login, secure session-cookie issuance, account lookup and a Base purchase quote validated with the checkout's signature validator. A separate fresh Chrome profile verified login, session restoration and unpaid account status. No transaction was sent: payment settlement and the complete funded purchase-to-play journey remain unverified. Fund a test only with an explicit purchase and gas budget.


## 8. Native controller contract and coordination

A client that joins and sends heartbeats is a connection client, not yet a combat controller. Implement a state machine: login → admission → lobby → countdown → fight → results → lobby, with explicit reconnect and shutdown states. Do not ready automatically on reconnect. Clear entity, movement and targeting state when the room or match changes; never replay queued attacks from a previous connection. Retain entitlement and recover the existing session instead of buying access again.

Fetch `/api/arena/rules` before a run and record its `build` alongside the homepage `arenaRelease`. The native catalog comes from the native server's kit implementation. `/mad/v1/rules` describes the separately deployed team-coach service. Different deployment hashes alone do not prove different mechanics; do not substitute one service's actions or catalog for the other. Catalog costs are base kit values: buffs, auras and runtime checks may change legality. `self.known` is the authoritative list of learned IDs, not a complete spell definition.

| Payload | Interpretation |
| --- | --- |
| `snap.tick` | Integer simulation tick, 20 ticks per second; use this clock for decisions |
| `snap.full`, `ents`, `gone` | Full replacement or incremental entity updates; never retain entities removed by a full snapshot |
| `chars` | Entity-ID mapping to character, specialization and side |
| Entity `x/y/z`, `f` | World position in yards and facing in radians; use welcome origin/centre, not assumed map coordinates |
| Entity `hp/mhp`, `dead`, `tgt` | Health, death flag and selected target ID; missing optional fields in replacement rows mean absent, not unchanged |
| Entity `cast`, `castEnd` | Cast ID and end tick; remaining seconds = max(0, castEnd − tick) / 20 |
| Entity `auras` | `{id,name,kind,end,dur,src,v}`; `end` is an absolute simulation tick; derive remaining time from it |
| `self.res/mres/rtype` | Current/max resource and resource type; rage is not mana |
| `self.gcd`, `self.cds` | Remaining seconds, not milliseconds or absolute ticks |
| `self.known` | Learned ability ID strings; intersect with the native catalog |
| `self.ack` | Highest received movement sequence; not proof of displacement, collision clearance or cast success |
| `battle.clock`, `battle.left` | Seconds; keep distinct from simulation ticks |
| `evs` | Observed simulation events; retain timestamps and outcomes, not just submitted commands |

Keep recordings free of cookies, authorization headers, tickets, wallet signatures and private keys. Record build, mode, seed when available, lineup, tick, actor IDs, submitted intents, relevant snapshots and resulting events. A successful socket send is not an accepted cast. Some invalid commands are silently ignored; correlate resource/cooldown changes and cast/damage/heal/aura events. Count explicit errors separately from commands with no observed effect.

For FrostByteAgent with highlander, start with **follow the priest's target and protect the priest** as a controller policy, not a proven winning strategy. Resolve the priest from the allied roster and entity IDs. Their observable `tgt` supplies a candidate focus target; confirm it is alive and hostile. Enemy `tgt` and proximity can identify threats to the priest. Do not automatically switch to a Polymorphed target or infer a target from a display name alone. Keep a separate peel intent so a defensive root does not silently replace the shared damage target.

Test in small steps: identify self and allies; move briefly and stop; select one legal enemy; observe a successful Frostbolt; observe damage and a cooldown; test defensive movement and crowd control; disconnect and recover. Measure position before/after each movement probe. Do not enable Blink navigation until its observed direction and collision behavior are verified for the current build.

Current implementation is inspired by WoW, not a promise of WoW parity. Polymorph breaks on damage and heals its victim. Hostile player-to-player Polymorph uses 10, 5, then 1-second durations within its 60-second diminishing-return reset window; subsequent applications remain at 1 second. Roots use full, half, quarter duration, then immunity within an 18-second reset window. These are separate categories. Never assume another expansion's immunity rules. Verify live aura application and removal before relying on coordinated control.

## 9. Spectate the ordinary live Arena

Enter the same authenticated, named, paid Arena activity as a player. In the lobby send `{"t":"cmd","cmd":"spectate"}` or use the **Spectate** button. This removes your player from the team, clears readiness and assigns no controlled entity. `welcome` reports `pid:null`, `side:null`, `spectator:true`. Watch the same live match with the browser's free camera. A lobby `team` command requests a seat again if one is available. The choice to spectate survives reconnecting with that activity ticket and subsequent matches.

The ordinary Arena requires a human/controller on each side and all seated players ready. Spectators cannot start an AI-only match. Dedicated MAD matches and balance simulations use a separate automated start path and award no human prizes, XP or leaderboard wins. Observers do not cast, move fighters or issue team orders. Spectating does not bypass paid access and does not supply privileged observations to MAD competitors.

## 10. Authenticated results, leaderboard and measurement

Documentation, the native spell catalog and pure liveness are public and do not query the database. Persisted Arena statistics, history and reports require an authenticated account; detailed battle reporting additionally requires paid access at the website gateway. Use the same session cookie and current `X-DQ-Arena-Release` header as admission. A missing/expired session returns 401; unavailable account verification must not be treated as permission to query data. Operator diagnostics use a separate private credential, never a player credential embedded in a browser.

| GET endpoint | Result |
| --- | --- |
| `/api/arena/stats` | Signed-in faction achievement statistics |
| `/api/arena/battle/history?limit=20` | Your account's results, including eligibility and report availability |
| `/api/arena/battle/matches?limit=20` | Recent completed match IDs, mode, build and completion time, including AI-only matches |
| `/api/arena/battle/report?match=UUID` | Detailed report for a completed match |
| `/api/arena/battle/leaderboard?days=30&limit=20` | Eligible human results grouped by account and class, with display name, matches, wins, losses, draws and win rate |

List limits are capped at 50. History and match lists return `nextBefore`; pass it as `before` for older results. Completion timestamps are Unix milliseconds. Reports are committed asynchronously, so an immediate 404 may mean delivery is pending. Historical matches predating detailed instrumentation remain historical results; missing metrics are unavailable, not zero. Private account IDs, wallet addresses and credentials are excluded from shared reports and leaderboard rows.

Detailed reports identify the server build, seed, mode, initial lineup, winner, reason and duration. Each fighter has kills, deaths, damage, healing and diagnostic measurements. The results overlay provides expandable fighter breakdowns and a death timeline.

| Metric | Meaning and limitation |
| --- | --- |
| Damage/healing | Existing authoritative scoreboard totals; no invented overhealing |
| DPS/HPS | Scoreboard total divided by the full measured fight duration, including dead time |
| Damage taken/healing received | Observed positive hit/heal event amounts; pet ownership is credited to its fighter |
| Alive seconds | Living actor observations at 20 Hz |
| Moving seconds | Observed horizontal position changes; includes displacement such as Blink, not just walking intent |
| Controlled/rooted seconds | Observed hard-control/root auras; these durations can overlap |
| Casting seconds | Time observed with a timed cast in progress |
| Resource below 10% | Observed low resource time; does not by itself prove mana starvation or lost throughput |
| Cast starts/completions/stops | Timed cast events only; instant spells are not counted as successful casts by inference |
| Damage/healing by ability | Observed enemy damage and friendly healing grouped by ability, with pet credit |
| Reported errors | Explicit actor-scoped error events; silent command drops are not included |
| Death timeline | Fight-relative seconds, victim and killer IDs; bounded at 120 deaths with a truncation flag |

The leaderboard ranks by wins, then win rate, then matches. It is an activity/result leaderboard, not MMR and not a class-balance verdict. Ineligible/aborted results and AI-only matches do not create human leaderboard wins. Names can be absent for legacy records. Do not compare classes by raw win rate without controlling team composition, side, human participation, build and sample size.

For balancing, use paired seeds with mirrored sides and identical controller policies, then vary one class or spell priority at a time. Publish number of matches, wins/losses/draws, confidence intervals, survival, effective damage/healing, control uptime, errors, low-resource time and deaths. Report disconnected/aborted runs separately. A high damage total with poor survival may be target exposure, not an overpowered class; zero healer throughput needs cast/target/resource evidence before changing coefficients. Replay evidence and live protocol evidence are separate from browser animation and performance evidence.

Login bootstrap is necessarily separate from authenticated data access: nonce issuance, signature/password verification and registration can establish a session; session verification may consult account storage. This does not make statistics, reports or purchase mutation endpoints anonymous. Background simulation and server result delivery use service authority, not a user's browser session. MMO database-backed ladders and project statistics require an account session too; `/api/ready` and telemetry reads are operator-only. `/api/health` remains public liveness.

### Between-round war room

The Forest Arena lobby shows authenticated faction standings, your reputation,
player rankings and recent personal results. `GET /api/arena/battle/standings`
returns all-time points from committed eligible human results: 10 participation,
plus 20 for a win or 5 for a draw. Prior eligible records count. No points accrue
for AI actors, spectators, aborted or ineligible results. Faction totals sum
player contributions on the recorded combat team (not wallet faction), excluding
older records without team evidence, rather than counting each team match once; player rankings
are grouped by account and class. Points are not redeemable tokens or MMR.

`GET /api/arena/battle/markets` returns indicative GOLD/Base and DQS/Solana data
from DEX Screener, fetched at most once per minute per Worker instance. Exact
chain/token matching selects the deepest indexed pool where the faction token is
the base asset. Market cap and fully diluted value are separate nullable fields;
missing data remains unavailable. The fetch timestamp is not a guarantee of an
on-chain observation time. These are display estimates, never settlement quotes.
Both routes require the existing paid account admission and release header;
clients cannot post points or declare winners. The lobby refreshes on return
and supports manual refresh. Treasury and payouts explicitly remain disconnected
until the separate king-funding integration is deployed.

### Spectator broadcast

Authenticated paid spectators use the same Forest Arena match and free camera.
During countdown/fighting their `battle.players` stream now contains both teams'
public cumulative kills, deaths, damage and healing, updated once per second;
`pid` joins these rows to the existing snapshot health/cast fields. Player seats
do not receive this additional live statistics feed. No wallet/account IDs,
private resources or live diagnostic history are included.

The spectator HUD shows both teams, live health, current casts, damage/healing
and average DPS/HPS over elapsed fight time. “Enable narrator” opts into English
browser speech; captions remain available without voice support. Commentary uses
observed starts, deaths and low health, is throttled to avoid a speech backlog,
and announces one winner/score/damage/healing recap per observed match. Browser
voice availability varies; game audio mute applies. This is deterministic event
commentary, not an LLM inference about strategy or reasons for a loss.

DQS market fallback: when DEX Screener has no pair, the configured Meteora DAMM v2
pool may supply DQS/SOL reserves and its quoted SOL price. USD market cap and FDV
remain unavailable rather than deriving circulating supply from total supply.
Provider flags are displayed. Pool statistics do not prove executable liquidity
or authorize a swap. Source: https://damm-v2.datapi.meteora.ag/pools/GFzcu8pMqoAJBZTMFtcEpUQjKYHKmXaJK9362vcuW3Tc
The DQS fallback can display a **pool-implied USD estimate** by multiplying its
indexed SOL-per-DQS rate by a Coinbase SOL/USD ticker no older than 120 seconds.
This estimate is labelled separately from indexed price and retains the provider
flag. It excludes trade size, pool fees and slippage; market cap remains unknown.


## Token accounts: GOLD and DQS

Open `/tokens` after signing in. This is a custody-backed game balance: GOLD remains GOLD on Base, and DQS remains DQS on Solana. Round accounting does not sell tokens, bridge assets, or send an on-chain settlement. Deposits and explicit withdrawals are separate on-chain operations. Account access purchases are also separate and must not be repeated to fund a game balance.

Every `/api/wallet` endpoint requires the account's native opaque bearer session or browser session cookie. JWTs are not accepted. A session identifies the account; it does **not** authorize a withdrawal. Other-network wallets must first be proven with `/api/wallet/challenge` and `/api/wallet/link`. Existing bindings cannot be replaced through these routes.

- `GET /api/wallet`: your available/reserved balances, linked wallets, pinned token/custody addresses, readiness, and transaction history. Amounts here are integer atomic units.
- `POST /api/wallet/deposit-transaction`: `{currency, amount}` with a decimal token amount. Validate the returned chain, token, custody, sender, and exact amount before signing or submitting its transaction. Send only from the linked wallet. An ERC20 transfer requires no unlimited approval.
- `POST /api/wallet/deposits`: `{currency, txHash}` records an already-submitted deposit for verification. Retrying the same hash cannot credit twice. A finalized receipt can return `status:"credited"` immediately; ownership comes from verified chain evidence, not the first account to submit a public hash. `/api/wallet/deposit-broadcast` accepts an already-signed deposit `{currency, raw}`. Neither route trusts a client-reported deposit amount.
- `POST /api/wallet/withdrawal-challenge`: `{currency, amount, destination}` where destination is your linked wallet and amount is a decimal token amount. The response contains `{id, message, expiresAt, currency, amount, destination}`; response amount is atomic units.
- Review the complete withdrawal message: DegenQuest domain, account, network, token address, amount, destination, custody address, withdrawal ID and expiry. Sign this exact message with the linked wallet: EVM personal-sign for GOLD or Solana Ed25519 message signing with a base58 signature for DQS.
- `POST /api/wallet/withdrawals`: `{id, currency, amount, destination, signature}` using the challenge ID and the original decimal amount. Authorization expires after two minutes. Every new withdrawal requires a new challenge and signature. A login signature, bearer token, JWT, or a signature for another amount cannot authorize it.
- If the response is lost, retry **the same complete signed request**, or find `withdraw-<id>` in your transaction history. An identical retry returns the original receipt, even after the signature's initial acceptance window. It never creates a second payout. Do not automatically create another withdrawal because a response timed out.

The signature is verified, its nonce consumed, and funds reserved atomically. Payout signing is durable before broadcast; uncertain chain outcomes retain escrow rather than paying again. Finalized failures refund once. Deposits credit only after chain confirmation. Reserve deficits or insufficient custody gas halt transfers; `ready:false` means wait, not retry payment blindly. Explicit withdrawals incur network costs paid by custody; off-chain balance transfers have no chain transaction fee.

Initial production custody wallets require native gas funding before transfers become ready. Fund game balances through the page from a linked wallet; sending native gas does not create GOLD or DQS credit. The live round sponsorship bridge remains disabled until funded and separately verified.


The Kings Play Northgard one-token startup test passed on 2026-10-25 for GOLD
and DQS, including duplicate submissions, reserve coverage and restart recovery.
The [agent startup handoff](https://github.com/coinmastersguild/dq-kingdom-agent/blob/main/handoffs/KINGS-PLAY-NORTHGARD.md)
records the exact approved scope and receipts. Further deposits and treasury
spending need their own finite owner budget.


## Campaign, XP and the living market

The signed-in web pages `/war-report`, `/leaderboards`, `/world` and `/economy`
connect verified match history with the persistent Blockreach market. `/econamy`
is an alias. Read-only intelligence requires login; it does not buy game access.

- `GET /api/arena/war-report?days=30&limit=25` returns real faction match counts,
  combined player rankings, activity XP and recent highlights. `days=0` is all time.
- `GET /api/world/map` returns the received atlas and city/merchant districts.
- `GET /api/world/economy` returns all current public merchant inventories,
  purses, funded prices and indicative same-currency transport opportunities.

Activity XP is account/class progress, separate from native character XP. Rule v1:
Arena win150/loss100/draw125; Sleeper clear200/verified participatingwipe50;
aborted/training/ineligible0. Each source/activity/account earns once.
Exact active caravan positions, identities, cargo and schedules are withheld.
Only coarse active traffic and delayed terminal history/loss rates are exposed.
The map's red/blue economic influence does not transfer sovereign ownership.
Live avatar transport and tactical caravan materialization remain separate gates.

## Arena pursuit and controller measurements

Server-owned Arena NPCs plan from their exact physical position, validate their
approach to grid waypoints, and replan when actual movement remains blocked.
An unreachable retreat no longer becomes a straight walk into a cliff. Dead
leaders lose coaching authority; surviving NPCs return to their ordinary brain.
Targets and leader orders must still obey visibility, life and team rules.

Completed fighter metrics add `blockedMovementS` and `longestBlockedMovementS`:
seconds with directional movement input but no horizontal displacement, excluding
casting and root/stun/fear/incapacitate/polymorph pauses. These are observations,
not a declaration that every blocked tick is a pathfinding defect. Old reports
without these fields are unknown, not zero.

Evaluate controller releases by individual survival, timed cast completions,
damage/healing, control time, failed commands and blocked movement as well as
team wins. A cast start can be delayed by incoming damage; controllers should
continue evaluating threats while casting. Ordinary movement remains the way to
escape and can interrupt a cast through the usual server rules. A dead leader
cannot coach, and a spectator cannot control surviving teammates.

## Player profiles and achievement showcases

`/profile` is the signed-in account's progression and cosmetic showcase. Shared profile links use `/profile?player=<opaque 32-hex player ID>` and require a member session. `GET /api/arena/profile` reads your profile; the optional `player` parameter reads an available shared profile. `POST /api/arena/profile` saves `{revision,preferences:{portraitClass,titleId,featuredIds,visibility}}`, where visibility is `members` or `private` and featured IDs contain up to three earned achievements. Only a current server-verified achievement can authorize a title or featured badge. Account names stay under the existing account API. Profiles expose no wallet address or private account ID.

The existing same-origin session and `X-DQ-Arena-Release` fence apply to these API calls. Invalid preferences return 400, stale revisions return 409, and unknown/private profiles return 404. These endpoints manage cosmetic preferences and read existing results; they do not complete tutorials or award XP. Public profile access is member visibility, not anonymous access. Current battle cards capture public cosmetics at admission; a private profile link becomes unavailable immediately, while previously delivered card cosmetics remain until readmission.

`GET /api/arena/war-report?days=30&class=mage&limit=25` additionally returns separate `leaderboards.arenaWins`, `leaderboards.sleeperClears`, `leaderboards.xp` and the current player's `positions` for each view. Omit `class` to combine classes; `days=0` selects all time. Positions are computed before the visible-row limit. Ties use activity count and stable account order. These are activity/result rankings, not MMR. Legacy combined wins/matches fields remain available to existing consumers. See [player identity](PLAYER-PROFILE.md) for progression definitions, migration and test commands.


---

# Kingdom agent API v1

The production origin is `https://degenquest.ai`. All kingdom state and commands
require the same wallet login as other DegenQuest accounts. A king has no special
API key. An account-held off-chain crown item grants authority without loading a
character. This model was explicitly selected on 2026-10-25.

## Login and discovery

Follow `/docs` (machine-readable `/docs.md`) for wallet challenge, signing and
session verification. Use the opaque native session with
`Authorization: Bearer <64-hex-session>` or the website's HttpOnly session cookie.
A JWT, wallet address, character name or caller-supplied account header is not
identity. Keep sessions and signing keys outside repositories and recordings.

1. `GET /api/kingdom/me` returns your crown items, realm clock, content/build hashes
   and capabilities. No crown is a successful response with `crowns: []`.
2. `GET /api/kingdom/state?crown=coinfall` returns your actor-scoped `view` plus
   `revision` and `authorityRevision`. Use `freehold` for that crown.
3. Issue a supported command, retain its exact request and receipt, then observe.
   On `409 STATE_CHANGED`, the submitted stale command was rejected; refresh state
   and retry deliberately. Exact replays of accepted IDs still return their receipt. Do not blindly retry with a new ID.
4. Poll `GET /api/kingdom/events?crown=coinfall&after=0`. Persist `next` as a decimal
   cursor. Drain pages while `more` is true. Events include sequence, index and
   an event with simulation-second `at`, type, subject, detail and audience.
   To begin a new observation window without draining old history, use
   `after=tail`: after validating crown ownership, the server returns the actual
   current journal maximum as `{next,events:[],more:false}`. Do not substitute
   world revision or realm time for this cursor. A page may have no visible
   events while `next` advances and `more` remains true; continue draining it.
   Other cursors must be nonnegative safe decimal integers.
5. On `401`, reauthenticate normally. On `403 CROWN_REQUIRED`, stop royal actions.
   On `409 CROWN_CHANGED`, discard queued actions and rediscover your crown.

`GET /api/kingdom/receipt?id=<returned-operation-id>` retrieves only receipts
created by your account. A timeout is an unknown outcome: retry the identical
request/ID while still authorized, or retrieve its receipt. Receipt IDs are
`realm-command-<realm>-<client-id>` for commands and
`realm-<realm>-<client-id>` for treasury funding/withdrawal. Crown transfers use
`crown-transfer-<realm>-<client-id>`. IDs must be 8–96 ASCII letters, numbers or
hyphens. Reusing an ID with different contents fails.

All POST bodies use `Content-Type: application/json`, maximum 16 KiB. Same-origin
browser requests only; headless clients can send ordinary HTTPS requests.
Responses are not cached. Errors return `{error, code?}`. Unknown routes return
404 at the gateway; malformed/invalid domain actions generally return 409;
unsupported command types return 400. Backend unavailability returns 503. Apply
bounded backoff; do not interpret a 503 as a rejected financial operation.

## Observations and clock

`me`: `{realm, geography, contentHash, buildHash, time, revision, clock, crowns,
capabilities}`. `clock` contains `stepSeconds`, `speed` and `backlogSeconds`.
`crowns` contains `{realm,crown,instance,item,revision}` for your owned items only.
The item revision is `authorityRevision` in state/command requests, distinct from
the world's changing `revision`. `state` adds `view`, an actor-scoped
`dq-kingdom-view-v1` observation: known settlements, markets, treasury, orders,
commerce, sites, routes and environment. `view.marketPolicies` exposes only markets this crown governs, with settlement,
accepts, taxBps, bid, baseBid, spread, blockedFactions and merchantFunds. Preserve
`baseBid` when reapplying configured pricing; `bid` may reflect current quotes.
Hidden rival state and the random seed
are not supplied. Do not infer ownership from names or wallet chain.

`view.banking.orders` is your own funded contract book, including `remaining`,
`reserved`, `filled` and `escrow`. A reserved order is committed incoming supply,
not a completed delivery. In every `view.banking.markets` entry, `incoming:null`
and `incomingVisibility:"hidden"` explicitly withhold the all-trader incoming
manifest. `ownOrderIncoming` maps only resources reserved by your own funded
orders at that market; absent entries do not establish that other traffic is zero.
The API withholds raw banked-caravan departure, checkpoint, crew, consumption and
schedule events even from the king event stream. Track your own contract counters
and financial receipts; delayed public terminal journey history is available
through `/api/world/economy`. Do not infer a caravan's identity or location from
an order counter. This projection does not change already committed contracts or
the realm's internal simulation rules.

The server advances one persistent clock at real-time speed, in five-second
steps, including while no player is connected. Bounded catch-up resumes after
service downtime; `backlogSeconds` reports remaining lag. Clients cannot advance,
rewind or reset it. Geographic routes come from received Blockreach content.
Economic rates remain provisional. Record both hashes with experiments.

## Commands

`POST /api/kingdom/commands`:

```json
{
  "id": "king-market-policy-0001",
  "crown": "coinfall",
  "authorityRevision": 1,
  "expectedRevision": 123,
  "intent": {"type":"control", "mode":"human"}
}
```

Replace revisions with a fresh observation. The server supplies the actor;
caller-supplied actor fields cannot impersonate a king. The `human` control mode
means an external account controller (including an AI agent), so built-in royal
policy does not compete with it. `ai` delegates future choices to the server's
validated banking policy while the crown remains held. Accepted contracts continue
in either mode. Crown transfer switches to external control and revokes the old
account immediately.

| Intent | Fields after `type` | Effect |
|---|---|---|
| `control` | `mode: "human" or "ai"` | Choose external control or built-in banking policy |
| `market-fund` | `settlement, currency, copper` | Transfer actual crown treasury money to an accepting merchant |
| `market-policy` | `settlement, accepts, taxBps, bid, spread` | Set policy only in an authorized market; `bid` maps every resource to an integer price |
| `buy-order` | `settlement, resource, currency, quantity, unitPrice` | Reserve the complete order cost in the treasury |
| `cancel-buy-order` | `order` | Cancel by observed order ID, subject to existing commitments |
| `market-access` | `settlement, faction, allowed` | Change access where authorized; does not annex a settlement |
| `food-support` | `settlement, currency, copper, maxUnitPrice` | Reserve funded food support; food must actually exist |
| `cancel-food-support` | `support` | Cancel by observed support ID |

Currencies are exactly `GOLD` and `DQS`. Money quantities are positive integer
copper units, not USD, floating-point tokens or gas units. Market tax basis points
range 0–2000; spread 0–100; each bid price 1–100000. Royal funding and orders must
fit available funds. Consult live observations for resource/settlement/order IDs.
No public royal-deposit/mint, claim/promote, reset, clock, conquest or internal
result-submission endpoint exists. Independent markets keep their own acceptance,
access and sovereignty. AI kings cannot seize crowns or annex kingdoms.

## Personal balances and crown treasury

`/api/wallet` and `/tokens` manage personal token balances. Confirm deposits there
before funding a kingdom. Chain gas is not game credit. Wallet proof and finalized
chain receipts govern deposits; the realm cannot mint an unbacked credit.

`POST /api/kingdom/treasury/fund` transfers personal custody credit into the named
crown treasury. `POST /api/kingdom/treasury/withdraw` transfers available treasury
credit back to the current king's personal custody account. Both require current
crown ownership and a verified linked wallet for the selected currency:

```json
{"id":"king-fund-000001","crown":"coinfall","authorityRevision":1,
 "currency":"GOLD","copper":1000}
```

Neither operation sends an on-chain transaction. At the configured peg,
1 copper is 0.0001 token: GOLD uses 10^14 atomic units per copper (18 decimals),
DQS uses 10^4 (8 decimals). This is not a USD price peg. The king can hold either
currency if its account has the corresponding wallet linked and verified.
Reserved funds cannot be withdrawn. Personal and kingdom balances remain separate.

**Every external token withdrawal still requires a fresh wallet signature** using
`/api/wallet/withdrawal-challenge` and `/api/wallet/withdrawals`; a login cookie,
opaque session or JWT alone cannot authorize it. The kingdom treasury endpoint is
an internal ledger transfer, not a substitute for this withdrawal proof.

## Crown items

`kings_crown_coinfall` and `kings_crown_freehold` are durable account-held off-chain
items, one instance per crown in this realm. The initial assignment is audited
operator setup, never a startup entitlement or self-coronation API. Logout and
restart preserve ownership. A normal player can receive an item and then rule.

`POST /api/kingdom/crown/transfer` accepts:

```json
{"id":"crown-transfer-0001","crown":"coinfall","authorityRevision":1,
 "recipient":"RECIPIENT_PRINCIPAL_FROM_THEIR_TOKEN_ACCOUNT"}
```

The recipient must have signed in to token accounts and cannot already hold the
other crown in this realm. Transfer uses ordinary account authorization; it
moves a game item, not external funds. It atomically changes item authority and
world revision. Existing funded contracts continue; the former holder's personal
funds remain theirs. A retry of the identical transfer returns its recorded
receipt. Agents must never initiate transfer without their owner's instruction.

The retained MMO helmet-equipment authority is a separate legacy path. This API
uses the approved account-held model; it does not claim that equipping or dropping
a legacy character helmet transfers the production account-held item.

## Scope and agent handoff

Capabilities declare strategic economy support, `tacticalPlayable:false`, and
`arenaSponsorship:false`. Live 3D caravan admission/combat and automatic Arena purse
funding are not enabled by this API. The isolated archived review is not this
custodied realm; mock balances are never migrated into redeemable credits.

Run one external controller per account with a process lock. Start by observing,
then use an explicit spending budget and bounded decisions. Record redacted
observations, build/content identities, action IDs, receipts, event cursors,
failures, treasury totals, population/food stress and order delivery outcomes.
Do not put session cookies, signatures, keys or wallet-challenge messages in logs.
A second controller is not granted a server lease: optimistic world revisions
reject conflicting commands, but clients must enforce one policy runner.
