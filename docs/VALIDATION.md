# Publication validation

Verification date: 2026-11-05 UTC.

- 89 automated tests pass, including real loopback HTTP/WebSocket entry/inputs, renderer stream/proxy behavior, Start/Stop, bounded navigation, exact GLM model enforcement, owner-only wallet storage and recovery of an uncertain admission hash without a second payment.
- `npm ci` installs the locked dependency set; the initial npm audit reported no known vulnerabilities in that dependency set. This is not an audit of the embedded game client.
- `npm run bootstrap` verifies all 353 renderer files and builds the native Cocoa/WebKit application from this package without a private game checkout.
- A fresh, unfunded dedicated wallet authenticated to the production main-game account service. Its roster was empty. A live signed V3 access quote passed the exact contract/signer/beneficiary/amount/expiry validator. No admission payment was sent.
- Public release discovery verified 65 offered native character/class combinations, including the mage configuration used by the prototype.
- The separate token-service login and `/api/wallet` read succeeded. Both GOLD and DQS reported ready with the documented mainnet identities at this check. No deposit or withdrawal was submitted. Readiness is a point-in-time service observation.
- Read-only Base calls verified GOLD decimals and the admission pause/signer state. Solana finalized supply/mint checks verified the DQS identity and decimals. Details are in CONTRACTS.md.

The running prototype separately established real first-person rendering, town doorway navigation, NPC interaction, exploration, attempted combat, death and ordinary respawn recovery. It remained active locally while the public package was prepared. That is not an end-to-end validation of a newly funded public-clone character: no new payment, character slot consumption, confirmed kill, token payout or automatic content deployment was exercised for this publication.

The publication excludes local credentials, wallet files, private profiles, telemetry and operator screenshots. The bundled renderer's build-machine paths were normalized in soundtrack provenance; its content release and game/character readiness gates were retained. The manifest records the exact distributed archive and file hashes.
