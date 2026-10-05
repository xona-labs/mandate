# Mandate

Give an agent a policy and a budget. It buys its own research over x402, trades tokenized stocks on Solana, and keeps a receipt for every decision.

Mandate is a standalone package and the engine behind the stocks autopilot in Xona wallet.

## How it works

```
mandate (human-approved policy)
   |
   v
snapshot -> research -> decide -> policy gate -> execute -> receipt
            (x402)      (rules     (pure, no     (Jupiter    (append-only
                         or LLM)    I/O)          swap)       log)
```

- **Mandate**: a structured policy with a stock universe, hard budgets, rules, and constraints. Plain language is only an input; the structured form is what a human approves and what gets enforced.
- **Research**: before acting, the agent pays per call for data from x402 merchants, inside a separate research budget.
- **Policy gate**: every proposed trade is checked against the mandate (universe, per-trade, daily and total caps, allocation limit, premium, liquidity, market hours). It is a pure function with no I/O.
- **Receipts**: every tick writes one record of what the agent saw, what it paid for, what it wanted to do, and what it was allowed to do.

## Quick start

```bash
npm install
npm run build
node dist/cli/index.js create examples/mandate.example.json
node dist/cli/index.js approve weekly-tech
node dist/cli/index.js run weekly-tech --dry-run
node dist/cli/index.js receipts weekly-tech
```

`run` trades from an [xpay](https://github.com/xona-labs/xpay) profile (`--profile <name>`, default `default`). A dry run reads quotes and balances but never pays for research and never trades.

## CLI

| Command | What it does |
| --- | --- |
| `mandate create <file>` | Validate a mandate JSON file and save it as a draft |
| `mandate approve <id>` | Activate a draft or paused mandate |
| `mandate pause <id>` | Pause it |
| `mandate revoke <id>` | Permanently revoke it |
| `mandate status <id>` | Show the mandate and what it has spent |
| `mandate run <id> [--dry-run]` | Run one tick |
| `mandate receipts <id>` | Show the decision log |

Mandates live in `$MANDATE_HOME` (default `~/.mandate`), one directory each: `mandate.json`, `state.json`, `receipts.jsonl`.

## SDK

```ts
import { FileStore, runTick } from "@xona-labs/mandate";
import { createXpayBroker, createXpayResearch } from "@xona-labs/mandate/xpay";

const receipt = await runTick({
  store: new FileStore(dir),
  broker: createXpayBroker(xpay),
  research: createXpayResearch(xpay),
});
```

The root entry has no wallet dependency. The engine talks to the world through three ports in `src/ports.ts`:

- `Broker`: portfolio, quotes, trade execution
- `Research`: buys evidence within a budget
- `Decider`: turns context into proposals

Swap any of them to embed Mandate in another wallet or to test without funds.

## Layout

```
src/
  mandate/schema.ts   mandate shape and validation
  policy/             the pure policy gate
  engine/tick.ts      one tick of the loop
  engine/rules.ts     deterministic decider (scheduled buys)
  receipts/           receipt shape and formatting
  store/              file and in-memory stores
  adapters/xpay.ts    Broker and Research backed by a Xona wallet
  cli/                the mandate CLI
```

## Safety model

- A mandate file can never activate itself. `create` always saves a draft; only `approve` from a terminal activates it.
- `autonomy: "propose"` writes proposals without executing. `autonomy: "auto"` executes inside the limits.
- The mandate sits inside the wallet's own xpay guardrail, so both must allow a trade.
- State is saved after every fill, so a crash mid-tick cannot double-spend a budget.

## Status

Early scaffold. Working today: schema, policy gate, rule-based decider, receipts, CLI, xpay adapters, dry runs against a live wallet. Not built yet: plain-language compiler, LLM decider that reasons over research notes, sell and rebalance rules, MCP server, scheduler, dashboard.

## License

MIT
