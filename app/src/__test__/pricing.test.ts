/**
 * The API-equivalent cost math behind the Stats model-mix panel.
 *
 * Estimates are Tier B per the analytics-expansion research: the provider
 * reports token totals per model but no input/output split, so a blended
 * rate prices an assumed share of input tokens. The price list is the only
 * pricing source; a model it does not carry is unpriced (a token count),
 * never a $0 estimate.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  estimateModelCosts,
  formatUsd,
  modelPrice,
  planPriceUsd,
  valueRatio,
  type PriceList,
} from "~/lib/pricing";

const LIST: PriceList = {
  meta: { currency: "USD", updated: "2026-10-11" },
  providers: {
    "zai-coding-plan": {
      subscription: {
        plans: [
          { name: "Lite", price_usd_per_month: 18 },
          { name: "Pro", price_usd_per_month: 80 },
          { name: "Max", price_usd_per_month: 168 },
        ],
      },
      models: {
        "glm-5.3": {
          api_cost_per_million: { input: 1.4, output: 4.4, cache_read: 0.26 },
        },
        "glm-5.3-flash": {
          api_cost_per_million: { input: 0.15, output: 0.5, cache_read: 0.03 },
        },
      },
    },
    openai: {
      subscription: { plans: [{ name: "Pro", price_usd_per_month: 100 }] },
      models: {
        "gpt-6-luna": { cost_per_million: { input: 0.1, output: 0.5 } },
      },
    },
    "opencode": { subscription: { plans: [] }, models: {} },
  },
} as unknown as PriceList;

describe("modelPrice", () => {
  it("finds a coding plan's pay-as-you-go reference price", () => {
    const price = modelPrice(LIST, "zai-coding-plan", "glm-5.3");
    expect(price).toEqual({ input: 1.4, output: 4.4 });
  });

  it("prefers the direct per-token charge when the provider has one", () => {
    expect(modelPrice(LIST, "openai", "gpt-6-luna")).toEqual({
      input: 0.1,
      output: 0.5,
    });
  });

  it("joins case-insensitively on the model id", () => {
    expect(modelPrice(LIST, "zai-coding-plan", "GLM-5.3")?.input).toBe(1.4);
  });

  it("returns null for a model the list does not carry", () => {
    expect(modelPrice(LIST, "opencode", "space-bunny")).toBeNull();
    expect(modelPrice(LIST, "no-such-provider", "glm-5.3")).toBeNull();
  });
});

describe("estimateModelCosts", () => {
  const GLM_5_3 = 1_438_489_431;
  const FLASH = 2_247_671_759;

  it("prices the live Z.AI split at the blended rate", () => {
    const estimate = estimateModelCosts(
      [
        { id: "glm-5.3", displayName: "GLM-5.3", tokens: GLM_5_3, requests: null },
        {
          id: "glm-5.3-flash",
          displayName: "GLM-5.3-Flash",
          tokens: FLASH,
          requests: null,
        },
      ],
      LIST,
      "zai-coding-plan",
    );

    expect(estimate.rows).toHaveLength(2);
    const glm = estimate.rows[0];
    expect(glm.tokens).toBe(GLM_5_3);
    expect(glm.shareOfTokens).toBeCloseTo(0.3902, 3);
    expect(glm.costUsd).toBeCloseTo(2_876.98, 1);

    const flash = estimate.rows[1];
    expect(flash.shareOfTokens).toBeCloseTo(0.6098, 3);
    expect(flash.costUsd).toBeCloseTo(494.49, 1);

    expect(estimate.estimatedTotalUsd).toBeCloseTo(3_371.47, 1);
    expect(estimate.unpricedTokens).toBe(0);
  });

  it("counts unknown models as unpriced tokens, never as $0", () => {
    const estimate = estimateModelCosts(
      [
        { id: "glm-5.3", displayName: "GLM-5.3", tokens: 1_000, requests: null },
        { id: "glm-next", displayName: "GLM Next", tokens: 9_000, requests: null },
      ],
      LIST,
      "zai-coding-plan",
    );

    expect(estimate.rows[0].costUsd).not.toBeNull();
    expect(estimate.rows[1].costUsd).toBeNull();
    expect(estimate.unpricedTokens).toBe(9_000);
  });

  it("keeps the input share assumption explicit and overridable", () => {
    const models = [
      { id: "glm-5.3", displayName: "GLM-5.3", tokens: 1_000_000, requests: null },
    ];
    const atDefault = estimateModelCosts(models, LIST, "zai-coding-plan");
    const atHalf = estimateModelCosts(models, LIST, "zai-coding-plan", 0.5);

    expect(atDefault.inputShare).toBe(0.8);
    expect(atDefault.rows[0].costUsd).toBeCloseTo(0.8 * 1.4 + 0.2 * 4.4, 5);
    expect(atHalf.rows[0].costUsd).toBeCloseTo(0.5 * 1.4 + 0.5 * 4.4, 5);
  });
});

describe("planPriceUsd", () => {
  it("maps the reported plan onto the list's matching plan name", () => {
    expect(planPriceUsd(LIST, "zai-coding-plan", "pro")).toBe(80);
    expect(planPriceUsd(LIST, "zai-coding-plan", "lite")).toBe(18);
  });

  it("is null when the plan or provider is unknown", () => {
    expect(planPriceUsd(LIST, "zai-coding-plan", null)).toBeNull();
    expect(planPriceUsd(LIST, "zai-coding-plan", "unknown")).toBeNull();
    expect(planPriceUsd(LIST, "opencode", "pro")).toBeNull();
  });
});

describe("valueRatio", () => {
  it("expresses the estimate as a multiple of the plan price", () => {
    expect(valueRatio(3_371.47, 80)).toBeCloseTo(42.14, 2);
  });

  it("is null without a plan price to compare against", () => {
    expect(valueRatio(3_371.26, null)).toBeNull();
  });
});

describe("formatUsd", () => {
  it("rounds large amounts to whole dollars", () => {
    expect(formatUsd(3_371.26)).toBe("$3,371");
  });

  it("keeps cents for small amounts", () => {
    expect(formatUsd(4.489)).toBe("$4.49");
  });
});

describe("the committed price list", () => {
  /**
   * The catalog on disk is the one the shipped app reads — a stub that
   * drifts from its real shape would pass every unit test and still render
   * no estimates, exactly the bug the e2e run caught. This reads the real
   * file so the schema contract is pinned against it.
   */
  const real = JSON.parse(
    readFileSync("public/price_list.json", "utf8"),
  ) as PriceList;

  it("prices the Z.AI plan's models from their pay-as-you-go references", () => {
    expect(modelPrice(real, "zai-coding-plan", "glm-5.3")).toEqual({
      input: 1.4,
      output: 4.4,
    });
    expect(modelPrice(real, "zai-coding-plan", "GLM-5.3-Flash")).toEqual({
      input: 0.15,
      output: 0.5,
    });
  });

  it("knows the Pro plan's monthly price", () => {
    expect(planPriceUsd(real, "zai-coding-plan", "pro")).toBe(80);
  });

  it("prices the live 30-day split to the researched ≈ $3,371", () => {
    const estimate = estimateModelCosts(
      [
        {
          id: "glm-5.3",
          displayName: "GLM-5.3",
          tokens: 1_438_489_431,
          requests: null,
        },
        {
          id: "glm-5.3-flash",
          displayName: "GLM-5.3-Flash",
          tokens: 2_247_671_759,
          requests: null,
        },
      ],
      real,
      "zai-coding-plan",
    );
    expect(estimate.estimatedTotalUsd).toBeCloseTo(3_371.47, 0);
    expect(estimate.unpricedTokens).toBe(0);
  });
});
