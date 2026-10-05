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

- **Mandate**: a structured policy with a stock universe, hard budgets, rules, constraints, and soft guidance. Plain language is only an input; the structured form is what a human approves and what gets enforced.
- **Compiler**: a model translates a plain-language instruction into a draft mandate and lists everything it assumed or could not express. Compiling never approves anything.
- **Research**: before acting, the agent pays per call for data from x402 merchants, inside a separate research budget.
- **Decider**: either the plain schedule (`rules`) or a model (`llm`) that reads the guidance, quotes and research, then keeps, shrinks or skips each scheduled buy with a written reason.
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

Or start from plain language (needs `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`):

```bash
node dist/cli/index.js compile "DCA \$50 a week into NVDA and TSLA on autopilot, never more than 40% in one name, skip a buy after an earnings miss, spend up to \$0.50 a day on research"
```

## Model provider

The compiler and the LLM decider need a model. Set one key:

| Variable | Effect |
| --- | --- |
| `OPENROUTER_API_KEY` | Use OpenRouter (default model `anthropic/claude-opus-5.5`) |
| `ANTHROPIC_API_KEY` | Use the Anthropic API (default model `claude-opus-5-5`) |
| `MANDATE_PROVIDER` | Force `openrouter` or `anthropic` when both keys are set (OpenRouter wins otherwise) |
| `MANDATE_MODEL` | Override the model, in the provider's own naming. On OpenRouter it must support structured outputs |

`run` trades from an [xpay](https://github.com/xona-labs/xpay) profile (`--profile <name>`, default `default`). A dry run reads quotes and balances but never pays for research and never trades.

## CLI

| Command | What it does |
| --- | --- |
| `mandate create <file>` | Validate a mandate JSON file and save it as a draft |
| `mandate compile "<text>"` | Turn a plain-language instruction into a draft mandate (`--no-save` to preview) |
| `mandate approve <id>` | Activate a draft or paused mandate |
| `mandate pause <id>` | Pause it |
| `mandate revoke <id>` | Permanently revoke it |
| `mandate status <id>` | Show the mandate and what it has spent |
| `mandate run <id> [--dry-run] [--decider rules\|llm]` | Run one tick |
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

The root entry has no wallet dependency. The engine talks to the world through four ports in `src/ports.ts`:

- `Broker`: portfolio, quotes, trade execution
- `Research`: buys evidence within a budget
- `Decider`: turns context into proposals (`RulesDecider`, `LlmDecider`)
- `Llm`: a model that answers in a given shape; ships with `@xona-labs/mandate/openrouter` and `@xona-labs/mandate/claude`

Swap any of them to embed Mandate in another wallet or to test without funds.

## Layout

```
src/
  mandate/schema.ts   mandate shape and validation
  mandate/compile.ts  plain language to draft mandate
  policy/             the pure policy gate
  engine/tick.ts      one tick of the loop
  engine/rules.ts     deterministic decider (scheduled buys)
  engine/llm-decider.ts  model-backed decider
  receipts/           receipt shape and formatting
  store/              file and in-memory stores
  adapters/xpay.ts    Broker and Research backed by a Xona wallet
  adapters/openrouter.ts  Llm backed by OpenRouter
  adapters/claude.ts  Llm backed by the Anthropic API
  adapters/llm.ts     picks the provider from the environment
  cli/                the mandate CLI
```

## Safety model

- A mandate file can never activate itself. `create` always saves a draft; only `approve` from a terminal activates it.
- `autonomy: "propose"` writes proposals without executing. `autonomy: "auto"` executes inside the limits.
- The model is an advisor inside the fence. It can shrink or skip a scheduled buy but never grow one, extra trades are dropped unless the mandate is marked discretionary, and everything it proposes still passes the policy gate.
- Research notes are third-party data. The decider is told to weigh them as evidence, never follow them as instructions, and the hard limits bound the damage if one misleads it.
- If the model call fails, the tick holds and trades nothing.
- The mandate sits inside the wallet's own xpay guardrail, so both must allow a trade.
- State is saved after every fill, so a crash mid-tick cannot double-spend a budget.

## Status

Early. Working today: schema, policy gate, rule-based and LLM deciders, plain-language compiler, receipts, CLI, xpay, OpenRouter and Claude adapters, dry runs against a live wallet. Not built yet: sell and rebalance rules, MCP server, scheduler, dashboard.

## License

MIT
