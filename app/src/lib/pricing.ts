/**
 * API-equivalent cost estimation against the committed price list.
 *
 * The list (`app/public/price_list.json`, generated from models.dev) carries
 * per-model per-million rates — `costPerMillion` where the provider charges
 * per token directly, `apiCostPerMillion` where a flat coding plan covers the
 * model and the entry is the vendor's pay-as-you-go reference. Estimates built
 * here are always Tier B (blended): the providers we price today report token
 * totals per model but no input/output split, so a fixed input share stands in
 * and every surface showing the result must say so.
 *
 * A model the list does not carry is unpriced — a token count and nothing
 * else. It must never aggregate in as $0: a $0 estimate reads as "free", and
 * an unpriced model is not free, it is unreferenced.
 */

import type * as Ipc from "~/lib/ipc";

/** The pricing fields an estimate needs, resolved off the raw catalog entry. */
export type ModelPrice = {
  readonly input: number;
  readonly output: number;
};

type CostPerMillion = { readonly input: number; readonly output: number };

type ModelEntry = {
  readonly cost_per_million?: CostPerMillion;
  readonly api_cost_per_million?: CostPerMillion;
};

type PlanEntry = {
  readonly name: string;
  readonly price_usd_per_month: number | null;
};

type ProviderEntry = {
  readonly subscription?: { readonly plans?: readonly PlanEntry[] };
  readonly models?: Readonly<Record<string, ModelEntry>>;
};

/** The slice of `price_list.json` the estimator reads. */
export type PriceList = {
  readonly meta: { readonly updated: string; readonly currency: string };
  readonly providers: Readonly<Record<string, ProviderEntry>>;
};

/**
 * The share of a model's tokens assumed to be input. 80/20 is conservative
 * against real agentic coding (this machine's own logs run 87–96% input), and
 * the value ships with every estimate that uses it.
 */
export const DEFAULT_INPUT_SHARE = 0.8;

/**
 * Resolves one model's price, preferring the direct per-token charge and
 * falling back to the pay-as-you-go reference, case-insensitively on the id.
 */
export function modelPrice(
  list: PriceList,
  providerId: string,
  modelId: string,
): ModelPrice | null {
  const entry = list.providers[providerId]?.models?.[modelId.toLowerCase()];
  const cost = entry?.cost_per_million ?? entry?.api_cost_per_million;
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") {
    return null;
  }
  return { input: cost.input, output: cost.output };
}

/** One model's row in the mix panel: its token share and its estimate. */
export type ModelCostRow = {
  readonly id: string;
  readonly displayName: string;
  readonly tokens: number;
  /** Share of the window's tokens, 0–1. */
  readonly shareOfTokens: number;
  /** Blended API-equivalent USD, or null when the list has no reference price. */
  readonly costUsd: number | null;
};

export type ModelCostEstimate = {
  readonly rows: readonly ModelCostRow[];
  /** Sum over the priced rows only. Unpriced rows contribute their tokens to
   * `unpricedTokens` instead — never a silent $0. */
  readonly estimatedTotalUsd: number;
  readonly unpricedTokens: number;
  /** The input share every row was priced at, surfaced with the estimate. */
  readonly inputShare: number;
};

/** Prices a provider-reported model breakdown into estimate rows. */
export function estimateModelCosts(
  models: readonly Ipc.ModelUsage[],
  list: PriceList,
  providerId: string,
  inputShare: number = DEFAULT_INPUT_SHARE,
): ModelCostEstimate {
  const totalTokens = models.reduce((sum, model) => sum + model.tokens, 0);
  let estimatedTotalUsd = 0;
  let unpricedTokens = 0;

  const rows = models.map((model) => {
    const price = modelPrice(list, providerId, model.id);
    const shareOfTokens = totalTokens > 0 ? model.tokens / totalTokens : 0;
    if (price === null) {
      unpricedTokens += model.tokens;
      return {
        id: model.id,
        displayName: model.displayName,
        tokens: model.tokens,
        shareOfTokens,
        costUsd: null,
      };
    }
    const blended =
      (inputShare * price.input + (1 - inputShare) * price.output) / 1_000_000;
    const costUsd = model.tokens * blended;
    estimatedTotalUsd += costUsd;
    return {
      id: model.id,
      displayName: model.displayName,
      tokens: model.tokens,
      shareOfTokens,
      costUsd,
    };
  });

  return { rows, estimatedTotalUsd, unpricedTokens, inputShare };
}

/**
 * The subscription's monthly price for a reported plan, matching the plan
 * kind against the list's plan names.
 */
export function planPriceUsd(
  list: PriceList,
  providerId: string,
  plan: Ipc.PlanKind | null,
): number | null {
  if (plan === null) return null;
  const wanted = normalizePlanName(plan);
  const match = list.providers[providerId]?.subscription?.plans?.find(
    (entry) => normalizePlanName(entry.name) === wanted,
  );
  return match?.price_usd_per_month ?? null;
}

function normalizePlanName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The estimate as a multiple of the plan price — null when unpriceable. */
export function valueRatio(
  estimatedUsd: number,
  planPriceUsd: number | null,
): number | null {
  if (planPriceUsd === null || planPriceUsd <= 0) return null;
  return estimatedUsd / planPriceUsd;
}

/** Whole dollars once the amount is large enough for cents not to matter. */
export function formatUsd(value: number): string {
  const fractionDigits = Math.abs(value) >= 100 ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

/** The price-list provider id each readable stats provider prices against. */
export const PRICING_PROVIDER_IDS: Readonly<
  Record<Ipc.ProviderKind, string>
> = {
  codex: "openai",
  zai: "zai-coding-plan",
  minimax: "minimax-coding-plan",
  kimi: "kimi-code-plan-global",
};

/** Fetches the bundled price list. Failure is a real state the UI must show. */
export async function loadPriceList(): Promise<PriceList> {
  const response = await fetch("/price_list.json");
  if (!response.ok) {
    throw new Error(`The price list could not be read (${response.status}).`);
  }
  return (await response.json()) as PriceList;
}
