/**
 * The subtitle rule, pinned to real evidence.
 *
 * Every "show" case below is a phrasing a live model actually produced against
 * the criterion the server actually ran; every "omit" case is a restatement
 * that was being printed under the header as if it were a reinterpretation.
 *
 * Run: `npm test` (node:test, TS stripped natively — no test dependency).
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { contentTokens, isRedundantIntent, subtitleIntent } from "./intent-subtitle.ts";

describe("isRedundantIntent", () => {
  test("identical wording is redundant", () => {
    assert.equal(
      isRedundantIntent("products selling below cost", "products selling below cost"),
      true,
    );
  });

  test("intent contained in the label is redundant", () => {
    // The label says one word more ("price"). Nothing was reinterpreted.
    assert.equal(
      isRedundantIntent(
        "products still on an expired sale",
        "products still on an expired sale price",
      ),
      true,
    );
  });

  test("label contained in the intent is redundant", () => {
    assert.equal(
      isRedundantIntent(
        "the products that are discontinued right now",
        "products that are discontinued",
      ),
      true,
    );
  });

  test("a different criterion is NOT redundant — the reinterpretation case", () => {
    // The one the rule exists for: an absolute threshold ran as a per-product
    // reorder point, and the human has to be able to see that.
    assert.equal(
      isRedundantIntent("products less than 50 are in Stock", "products below their reorder point"),
      false,
    );
  });

  test("colloquial phrasing is NOT redundant", () => {
    assert.equal(
      isRedundantIntent("what's running low", "products below their reorder point"),
      false,
    );
  });

  test("case and punctuation do not decide it", () => {
    assert.equal(
      isRedundantIntent("  Products, selling below COST!  ", "products selling below cost"),
      true,
    );
  });

  test("an intent of nothing but scaffolding is redundant", () => {
    assert.equal(isRedundantIntent("show me the list", "products in the catalog"), true);
  });

  test("a Spanish intent against an English label shows — it really is different wording", () => {
    assert.equal(
      isRedundantIntent("productos con menos de 50 en stock", "products with stock below 50"),
      false,
    );
  });
});

describe("contentTokens", () => {
  test("keeps numbers, drops scaffolding", () => {
    assert.deepEqual(
      [...contentTokens("How many products less than 50 are in Stock")],
      ["products", "less", "50", "stock"],
    );
  });
});

describe("subtitleIntent", () => {
  test("an absent intent yields no subtitle", () => {
    assert.equal(subtitleIntent(undefined, "products selling below cost"), undefined);
  });

  test("an empty intent yields no subtitle", () => {
    assert.equal(subtitleIntent("", "products selling below cost"), undefined);
  });

  test("a redundant intent yields no subtitle", () => {
    assert.equal(
      subtitleIntent("products selling below cost", "products selling below cost"),
      undefined,
    );
  });

  test("a placeholder the model typed instead of omitting yields no subtitle", () => {
    // Observed live: `interpreted from: "none"` under the header.
    for (const filler of ["none", "None.", " N/A ", "null", "all"]) {
      assert.equal(subtitleIntent(filler, "products with stock below 50"), undefined, filler);
    }
  });

  test("a placeholder word inside a real phrase is still a phrase", () => {
    assert.equal(
      subtitleIntent("all the ones running out", "products with stock below 50"),
      "all the ones running out",
    );
  });

  test("a reinterpreted intent is passed through verbatim", () => {
    assert.equal(
      subtitleIntent("products less than 50 are in Stock", "products below their reorder point"),
      "products less than 50 are in Stock",
    );
  });
});
