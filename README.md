# DegenQuest Player Bot

Run an ordinary DegenQuest character locally, watch its **real first-person game view**, and inspect its current goal, actions and playtest findings. Start and Stop control one persistent player session. The bot seeks suitable creatures, fights with learned abilities, loots, rests and reports suspected problems.

**Claude operates the app; GLM makes the background play decisions.** This package pins `glm-5.3-flash-local` and rejects other models. Claude does not need to stay in a conversation for the bot to keep playing.

This is an experimental main-game client adapted from [dq-arena-bot](https://github.com/coinmastersguild/dq-arena-bot). It uses ordinary account authentication and player inputs. Combat and navigation still need playtesting; a confirmed creature kill is not yet established by the prototype validation. Automated content repair/deployment and the proposed 400-agent population are future work.

## Clone and open

The native desktop app requires macOS with WebGPU-capable WebKit, Node 22 or newer, and Apple's Command Line Tools (`xcode-select --install`). Install Node through Homebrew or the official installer so the app can find `/opt/homebrew/bin/node` or `/usr/local/bin/node`.

```sh
git clone https://github.com/coinmastersguild/dq-player-bot.git
cd dq-player-bot
npm ci
npm run bootstrap
open 'DegenQuest Bot.app'
```

`bootstrap` verifies and installs the bundled renderer, then builds the Cocoa app locally. No private DegenQuest checkout is required. The first launch can open before account setup; it waits for a configured character. The first live render downloads substantial official game assets and can take several minutes. Keep the app folder inside the clone.

## Ask Claude to set it up

Open this repository in Claude Code and ask:

> Read CLAUDE.md. Set up my local DegenQuest bot. Create a dedicated wallet and show me its Base ETH funding address. Check my owned characters and admission before proposing a payment. Show me the signed quote and ask for my maximum total ETH budget before spending. Help me choose a name and mage, configure my GLM endpoint, then open the app so I can press Start.

The operator works through a local MCP server. In Claude Code, add it using an **absolute path**:

```sh
claude mcp add --transport stdio dq-player -- node /absolute/path/dq-player-bot/bin/claude.mjs
```

For Claude Desktop, add this entry to its local MCP configuration and restart Claude:

```json
{
  "mcpServers": {
    "dq-player": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/dq-player-bot/bin/claude.mjs"]
    }
  }
}
```

Use your actual Node path and clone path. See [Claude setup and tools](docs/CLAUDE.md) for the same workflow from the terminal. Registration itself neither enters the game nor spends money.

## Fund, authenticate, play

1. Claude's `create_wallet` returns a dedicated wallet's **public address**. Fund that address with **ETH on Base mainnet (chain 8453)** for admission and gas. The repository provides no faucet or automatic treasury funding. Keep the private signer file backed up privately; losing it loses access to that wallet.
2. `authenticate` signs the game's free login challenge. `account_status` reads your owned roster. Existing characters can play without buying more slots. If you need a new slot, `admission_quote` returns an expiring signed quote. Review it and approve an explicit maximum total ETH, including gas, before `purchase_access`.
3. Claim your account name and create or select a hero. The current playtesting behavior is tuned for a mage. `character_options` reads the release's offered combinations; the game owns appearance admission and equipment.
4. Supply an available GLM endpoint and an owner-only credential file, then run `configure_bot`. It verifies the exact model, owned character, authored starting world and public navigation data. It leaves **Stop** selected.
5. Open the desktop app and press **Start**. Watch the actual first-person scene, current goal and brief decision summary, activity and suspected findings. **Stop** disconnects the player and persists through restarts.

GLM configuration accepts the existing Alpha endpoint `https://alpha.pioneers.dev/api/v1` with your own valid credential, or your own loopback HTTP router serving the exact model ID. An arbitrary Claude or OpenAI API key cannot substitute. See [runtime and inference](docs/RUNTIME.md).

**Account access, custody deposits, and withdrawals are different operations.** GOLD is an ERC-20 on Base; DQS is an SPL token on Solana. Neither token is required merely to fund the bot's Base gas wallet. Read [funding, deposits and withdrawals](docs/FUNDING.md) and the [live contracts and verification record](docs/CONTRACTS.md) before moving tokens. The bot's gameplay loop has no token-transfer or withdrawal tool.

## Continuous local playtesting

The local controller reconnects and restarts the player when needed; individual connections are bounded to 30 minutes. Closing the viewer leaves the controller running. The Mac must stay powered and connected: this is not a cloud service or a promise of uninterrupted uptime. Findings stay in `.local/state/findings` for investigation. They are suspected until reproduced and independently verified after a fix. Publishing game content is not enabled by this package.

Only one process should control a character. The viewer mirrors the bot's existing authenticated stream; it does not log in a second player. Stop before using the same character in the normal game client. Port `4783` belongs to one checkout at a time.

```sh
npm test
npm run check
npm run console
```

`check` needs completed setup and reads account/roster; `console` opens the browser console. The native app is the supported first-person preview. [Architecture, limitations and troubleshooting](docs/RUNTIME.md) describe release pinning, local files and recovery.

## License

Bot source is ISC. The compiled DegenQuest viewer and packaged art retain their existing rights; they are not relicensed as ISC. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Official world and character packs are downloaded from the game at runtime and remain subject to their original terms.
