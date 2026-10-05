/**
 * xpay adapters: the Broker and Research ports backed by a Xona wallet.
 *
 * Trades go through xpay's stock checks plus a Jupiter swap, research goes
 * through x402 discovery and pay-per-call. Both stay under the wallet's own
 * guardrail, so the mandate is a second, narrower fence inside the first.
 */

import { enrichTokenBalances, type Resource, type XPay } from "@xona-labs/xpay";
// Not on xpay's root export yet; move to the root import once it is.
import { findStocks, prepareStockTrade, usEquityMarketStatus, USDC_MINT } from "@xona-labs/xpay/dist/token/stock.js";
import { normalizeTicker } from "../mandate/schema.js";
import type { Broker, ExecuteOptions, Fill, Portfolio, Proposal, Quote, Research, ResearchNote, ResearchRequest } from "../ports.js";

const USDC_DECIMALS = 6;

export function createXpayBroker(xpay: XPay): Broker {
  async function quote(stock: string): Promise<Quote> {
    const { stocks, marketStatus } = await findStocks({ query: normalizeTicker(stock), limit: 5 });
    const ticker = normalizeTicker(stock);
    const match = stocks.find((s) => normalizeTicker(s.symbol) === ticker && s.verified) ?? stocks.find((s) => s.mint === stock);
    if (!match) throw new Error(`no verified tokenized stock found for ${stock}`);
    return {
      symbol: match.symbol,
      mint: match.mint,
      priceUsd: match.onchainPrice,
      premiumDiscountPct: match.premiumDiscountPct,
      liquidityUsd: match.liquidityUsd,
      marketOpen: marketStatus === "open",
    };
  }

  return {
    quote,

    async portfolio(universe: string[]): Promise<Portfolio> {
      const cashUsd = await xpay.wallet.balance("solana");
      const signer = xpay.wallet.signer("solana");
      const raw = typeof signer.tokenBalances === "function" ? await signer.tokenBalances() : [];
      const balances = await enrichTokenBalances(raw);
      const wanted = new Set(universe.map(normalizeTicker));
      const positions = balances
        .filter((b) => b.address && !b.isNative && wanted.has(normalizeTicker(b.symbol)))
        .map((b) => ({ symbol: b.symbol, mint: b.address!, qty: b.balance, usdValue: b.usdValue ?? 0 }));
      return { cashUsd, positions };
    },

    async execute(proposal: Proposal, opts: ExecuteOptions = {}): Promise<Fill> {
      const plan = await prepareStockTrade({
        stock: proposal.stock,
        side: proposal.side,
        maxPremiumPct: opts.maxPremiumPct,
        minLiquidityUsd: opts.minLiquidityUsd,
      });
      const buy = proposal.side === "buy";
      // Buys are sized in USDC; sells are sized in tokens, converted at the live price.
      let amount = proposal.usd;
      if (!buy) {
        const price = plan.stock.onchainPrice;
        if (!price) throw new Error(`no live price for ${plan.stock.symbol}, cannot size the sell`);
        amount = proposal.usd / price;
      }
      const result = await xpay.swap({
        amount,
        from: buy ? USDC_MINT : plan.stock.mint,
        to: buy ? plan.stock.mint : USDC_MINT,
        slippageBps: opts.slippageBps,
      });
      return {
        txSig: result.txSig,
        symbol: plan.stock.symbol,
        mint: plan.stock.mint,
        side: proposal.side,
        usd: buy ? (result.totalInAmount ?? result.inAmount) : (result.totalOutAmount ?? result.outAmount),
        qty: buy ? (result.totalOutAmount ?? result.outAmount) : (result.totalInAmount ?? result.inAmount),
        warnings: plan.warnings,
      };
    },
  };
}

/** Listed USD price of a resource on Solana, or undefined when it is not priced in USDC there. */
function solanaPriceUsd(resource: Resource): number | undefined {
  const req = resource.accepts.find((a) => a.network === "solana" && a.asset === USDC_MINT && a.amount);
  return req?.amount ? Number(req.amount) / 10 ** USDC_DECIMALS : undefined;
}

export function createXpayResearch(xpay: XPay): Research {
  return {
    async gather(req: ResearchRequest): Promise<ResearchNote[]> {
      const notes: ResearchNote[] = [];
      let left = req.budgetUsd;

      for (const topic of req.topics) {
        if (notes.length >= req.maxCalls) break;
        const candidates = await xpay
          .discover({ query: `stock ${topic}`, networks: ["solana"], limit: 10, minTrust: req.minTrust })
          .catch(() => [] as Resource[]);
        // Cheapest source that fits both the per-call cap and what is left.
        const pick = candidates
          .map((resource) => ({ resource, usd: solanaPriceUsd(resource) }))
          .filter((c): c is { resource: Resource; usd: number } => c.usd !== undefined && c.usd <= req.maxPerCallUsd && c.usd <= left)
          .sort((a, b) => a.usd - b.usd)[0];
        if (!pick) continue;

        try {
          const result = await xpay.use(pick.resource);
          left -= pick.usd;
          notes.push({
            id: `note_${Date.now().toString(36)}_${notes.length}`,
            topic,
            source: pick.resource.resource,
            costUsd: pick.usd,
            txSig: result.txSig,
            data: result.data,
            at: new Date().toISOString(),
          });
        } catch {
          // A source that fails or is blocked by the wallet guardrail is skipped.
        }
      }
      return notes;
    },
  };
}

export { usEquityMarketStatus };
