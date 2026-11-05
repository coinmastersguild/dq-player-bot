# Runtime, verification and limitations

The app runs on the owner's Mac. Its loopback controller owns one Node player service and an IPC channel. That service authenticates the ordinary account, verifies roster/realm/release identity, requests a normal entry grant and opens one game WebSocket. The desktop viewer consumes the actual hello/full/lite/keep stream through a read-only local observer. It reuses the game's own first-person renderer and HUD, normal native-character preparation and official public assets.

There is no second player login, fabricated camera/world state, admin spawn, teleport or server edit. The observer cannot send player inputs. The game remains authoritative for movement, abilities, collision, combat, death, loot and quest completion.

## Claude and GLM

Claude's MCP is `bin/claude.mjs`: account setup, capped owner-approved admission purchase, app control and observation. It does not enter another gameplay session. The lower-level experimental `bin/player.mjs mcp --config ...` adapter is for separate manual protocol development only; do not register it alongside an autoplaying character.

The autonomous planner uses **only `glm-5.3-flash-local`**, through `https://alpha.pioneers.dev/api/v1` or an explicitly configured HTTP loopback router. Both model discovery and completion responses must match. The owner must have valid inference access; this clone supplies no paid inference credentials. A credential file is JSON with a `token` property, mode `0600`. It is read by the transport, never placed in a model prompt.

Defaults: one strategic decision every 30 seconds, at most 120 requests per UTC hour, durable request reservation before a paid request, no automatic retry of an unknown completion. A deterministic executor handles bounded movement/combat between decisions. A plan uses an index into observed permitted goals; learned abilities and current targets are validated. Large or much stronger hostile creatures cause avoidance/retreat. Public habitat hints guide search; they are not proof that a creature is observed or present.

The intent panel displays a brief goal rationale and actions, not hidden reasoning. Sent actions are labeled as submissions; confirmed damage/death/loot events and changes in game state establish results.

## First launch and release compatibility

`npm ci` installs locked dependencies. `npm run bootstrap` verifies `assets/renderer-0.4.0.tgz` and every extracted file against `renderer-manifest.json`, then compiles the native application. The release includes the current observer browser bundle; normal game packs are downloaded from official endpoints at runtime. No private game checkout is required.

`assets/release.json` pins game `0.0.50`, content lock `945938d2a25732a440a437d3e755feaa06ab4512671ecbdd8d18126f6294fe39`, catalog/title identities and each presentation/server pair. The setup verifies downloaded presentation-index metadata and collision bytes before use. The viewer verifies normal released assets/character readiness. A release mismatch stops entry or loading. Do not fix a mismatch by disabling validation or accepting an arbitrary replacement pin; update the reviewed renderer/release together.

The first-person preview requires native macOS WebKit with WebGPU. The first cold load can download hundreds of MB and take several minutes; full game packs are larger. Keep the machine connected. A browser with unavailable WebGPU can show the controller while the game view cannot render; use the native app. Compile with Apple Command Line Tools. The app locates Node at `/opt/homebrew/bin/node` or `/usr/local/bin/node`; other installations need an appropriate symlink/installation or `npm run console` for the browser console.

## Local data

| Path | Contents | Publish? |
| --- | --- | --- |
| `.secrets/bot-signer.json` | Dedicated wallet address and private key | Never |
| `.secrets/game-cookies.txt` | Host-scoped main-game session | Never |
| `.secrets/custody-cookies.txt` | Separate token-service session | Never |
| `.secrets/player.local.json` | Chosen identity, release, credential file paths | Never |
| `.secrets/admission-*.json` | Reviewed quote, durable pending bytes/hash and receipt | Never |
| `.secrets/character-pending.json` | Uncertain create request to reconcile with roster | Never |
| `.local/state/` | Stop marker, locks, GLM budget, snapshots, statistics and suspected findings | Private |
| `.local/render-bundle/` | Verified installed observer distribution | Generated |
| `.local/native-*.{json,png}` | Render diagnostics and optional local snapshot | Private |

The repository excludes all of these. Telemetry redacts known credential fields, but gameplay recordings still contain player/game information. Review before sharing; redaction is not permission to publish everything. The pending financial store intentionally retains exact signed bytes privately for recovery and is never telemetry.

## Start, Stop and continuity

Start clears the durable Stop marker and launches one child. Stop persists the marker and disconnects it. Closing the viewer leaves the loopback controller running; terminating that controller disconnects its child. The app prevents two controllers in one checkout and refuses a port belonging to another checkout. Another clone still needs its own account/character; a second game client can take over the same character.

The controller restarts unexpected child exits; the service reconnects with backoff and renews the dedicated wallet's main-game login when needed. Each entry connection is bounded to 1,800 seconds and re-enters normally. The Mac stays idle-awake while playing through `caffeinate`; this does not override power loss, shutdown, network loss, display policies or system failures. The package does not install a boot daemon. Reopen the app after a reboot; Stop remains authoritative.

## Playtest loop status

### Protected hosted player sessions

An existing protected `agent-wallet` runtime can run `bin/service.mjs` with a
native session profile instead of a software wallet. Extend a release-verified
player profile with `loginProvider: "agent-wallet"`, `walletChain: "ethereum"`
or `"solana"`, the runtime's own `walletAddress`, and a mode-0600 `tokenFile`.
Remove `cookieFile` and `signerFile`. The signer must run as that wallet's own
runtime user. Login renewal requests only a fresh, exact DegenQuest login message
and an own-wallet message signature; it neither exports keys nor submits a chain
transaction. Admission and normal character ownership are still required.

Hosted network policy remains authoritative. A host requiring an HTTPS proxy
must configure its HTTPS agent in each Node player process, including restarted
children. The WebSocket transport explicitly preserves that configured agent.
Keep a private GLM router behind a local relay if it is outside the supported
endpoint origins; retain the exact model check and that runtime's own credential.
This advanced profile does not add hosted setup or a Solana checkout UI to the
desktop onboarding flow. A service manager must supervise hosted processes;
the Mac app does not install a hosted daemon.

The player records suspected runtime, navigation, content and bot findings with run identity and grounded evidence. Findings deduplicate durably. A worker's report of success cannot close a finding: independent post-change validation is required. This public package leaves content-agent dispatch disabled. It does not publish or deploy the game.

Current evidence supports ordinary world entry, a real first-person render, doorway navigation, NPC interaction, exploration, attempted combat, death and ordinary respawn recovery in the prototype. The first recorded hunt was interrupted by a stronger creature; no confirmed kill, XP gain or loot delivery was established. The public setup separately verifies fresh wallet login and a signed unsigned-payment quote. No new paid admission/deposit/withdrawal is claimed as tested by this release.

The automated tests cover protocol/identity fencing, real loopback HTTP/WebSocket sessions, leased inputs, observed actor/quest validation, route bounds, GLM model/budget enforcement, Start/Stop, private file permissions, account login and pending-payment recovery. They do not prove real chain settlement or a healthy GPU/game frame.

## Troubleshooting

- **No profile:** complete Claude setup. Opening an unconfigured app waits without launching repeated player processes.
- **Port belongs to another app:** use the original checkout or stop its local controller before switching. Do not kill an unrelated process. Developer console tests can use `DQ_CONSOLE_PORT` with an unused port; production defaults to 4783.
- **GLM error:** confirm the configured endpoint exposes the exact pinned model and that the credential file is valid and owner-only. There is no fallback to another provider/model.
- **Payment unknown:** keep private pending state and recover the same order/hash. Never reset the wallet to work around an uncertain transaction.
- **Create unknown:** inspect the fresh owned roster and saved name/request before reconciling the pending create file. Do not send another create merely because the first response was lost.
- **Blank/slow game:** allow the cold asset load, confirm WebGPU support and inspect local logs. Readiness and actual draw calls must both be present; a loading screen is not a rendered world.
- **Stuck or dying:** Stop if needed; inspect actual local observations and findings. Navigation, danger avoidance, class behavior, zone handoffs and long-running progression remain experimental.
# Optional content playtest missions

Set `inference.playtest.role` in your private player profile to `combat-loot`, `quests-navigation` or `progression-recovery`. Without it the bot retains its creature-hunting objective. Every mission still uses the pinned GLM model and ordinary player actions. Quest discovery is limited to observed accessible NPCs and a cooldown budget; the bot receives no private spawn coordinates. It avoids trivial low-level farming unless pursuing an accepted quest. Models, animation and sound require separate renderer/audio inspection.

Company feedback is an operator-side integration, configured separately from the legacy direct repair-job dispatcher. `company-feedback-status.json` can expose sanitized delivery and board task receipts in the console. A collector receipt means transport succeeded; actual task IDs and publication timestamps show board delivery. Installing this public player app does not grant access to the Pioneer company or automatically upload a user's gameplay there.
