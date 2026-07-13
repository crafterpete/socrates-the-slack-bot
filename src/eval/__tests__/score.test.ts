import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scoreAnswer, scoreRetrieval } from "../score.js";
import type { GoldenRecord, MatchType } from "../types.js";

function rec(match_type: MatchType, answer: string | null, extra?: Partial<GoldenRecord>): GoldenRecord {
  return {
    id: "case-1",
    question: "q",
    answer,
    match_type,
    retrieval_evaluation: "not_applicable",
    relevant_ids: {},
    ...extra,
  };
}

describe("scoreAnswer: numeric_exact", () => {
  test("passes when the exact number appears anywhere in the response", () => {
    assert.equal(scoreAnswer(rec("numeric_exact", "42"), "There are 42 customers.").correct, true);
  });

  test("tolerates thousands separators in both gold and response", () => {
    assert.equal(scoreAnswer(rec("numeric_exact", "1,234"), "total is 1234").correct, true);
    assert.equal(scoreAnswer(rec("numeric_exact", "1234"), "total is 1,234").correct, true);
  });

  test("matches negative and decimal numbers", () => {
    assert.equal(scoreAnswer(rec("numeric_exact", "-3.5"), "the delta was -3.5 points").correct, true);
  });

  test("fails when the number is absent", () => {
    assert.equal(scoreAnswer(rec("numeric_exact", "42"), "There are 41 customers.").correct, false);
  });

  test("a number embedded in a larger number does not count", () => {
    assert.equal(scoreAnswer(rec("numeric_exact", "42"), "we saw 421 events").correct, false);
  });
});

describe("scoreAnswer: numeric_tolerance", () => {
  test("passes within an absolute tolerance", () => {
    const r = rec("numeric_tolerance", "100", { tolerance: { absolute: 5 } });
    assert.equal(scoreAnswer(r, "roughly 103").correct, true);
    assert.equal(scoreAnswer(r, "roughly 106").correct, false);
  });

  test("passes within a percent tolerance", () => {
    const r = rec("numeric_tolerance", "200", { tolerance: { percent: 10 } });
    assert.equal(scoreAnswer(r, "about 219").correct, true);
    assert.equal(scoreAnswer(r, "about 221").correct, false);
  });

  test("defaults to exact match when no tolerance is given", () => {
    assert.equal(scoreAnswer(rec("numeric_tolerance", "100"), "100 on the dot").correct, true);
    assert.equal(scoreAnswer(rec("numeric_tolerance", "100"), "101 or so").correct, false);
  });

  test("fails with a detail when the gold answer is not numeric", () => {
    const score = scoreAnswer(rec("numeric_tolerance", "not a number"), "100");
    assert.equal(score.correct, false);
    assert.equal(score.detail, "gold answer not numeric");
  });
});

describe("scoreAnswer: boolean", () => {
  test("leading Yes matches a true gold", () => {
    assert.equal(scoreAnswer(rec("boolean", "true"), "Yes, they renewed in March.").correct, true);
  });

  test("leading No matches a false gold", () => {
    assert.equal(scoreAnswer(rec("boolean", "false"), "No, there is no record of that.").correct, true);
  });

  test("polarity mismatch fails", () => {
    assert.equal(scoreAnswer(rec("boolean", "true"), "No, they did not.").correct, false);
  });

  test("negation cues count as a No even without a leading token", () => {
    assert.equal(scoreAnswer(rec("boolean", "false"), "The records don't show any churn.").correct, true);
  });

  test("a response with no polarity signal fails rather than guessing", () => {
    assert.equal(scoreAnswer(rec("boolean", "true"), "Potato.").correct, false);
  });
});

describe("scoreAnswer: abstain and refuse", () => {
  test("abstain requires the leading marker", () => {
    assert.equal(scoreAnswer(rec("abstain", "n/a"), "[Abstain] the database has no pricing data.").correct, true);
    assert.equal(scoreAnswer(rec("abstain", "n/a"), "I cannot find pricing data.").correct, false);
  });

  test("refuse requires the leading marker", () => {
    assert.equal(scoreAnswer(rec("refuse", "n/a"), "[Refuse] that request is out of scope.").correct, true);
    assert.equal(scoreAnswer(rec("refuse", "n/a"), "Sorry, I can't help with that.").correct, false);
  });

  test("markers match case-insensitively", () => {
    assert.equal(scoreAnswer(rec("abstain", "n/a"), "[abstain] nothing found.").correct, true);
  });
});

describe("scoreAnswer: exact_scalar", () => {
  test("matches as a case-insensitive substring", () => {
    assert.equal(scoreAnswer(rec("exact_scalar", "Signal Ingest"), "The top product is signal ingest.").correct, true);
  });

  test("normalizes whitespace runs before matching", () => {
    assert.equal(scoreAnswer(rec("exact_scalar", "Signal Ingest"), "It's Signal\n  Ingest by a mile.").correct, true);
  });

  test("fails when the scalar is absent", () => {
    assert.equal(scoreAnswer(rec("exact_scalar", "Signal Ingest"), "The top product is Event Nexus.").correct, false);
  });
});

describe("scoreAnswer: set_equality", () => {
  test("passes when every item appears, in any order", () => {
    const r = rec("set_equality", "Acme, Globex; Initech");
    assert.equal(scoreAnswer(r, "Found Initech, Acme and Globex.").correct, true);
  });

  test("fails and names the missing items", () => {
    const r = rec("set_equality", "Acme, Globex, Initech");
    const score = scoreAnswer(r, "Found Acme only.");
    assert.equal(score.correct, false);
    assert.match(score.detail ?? "", /Globex/);
    assert.match(score.detail ?? "", /Initech/);
  });
});

describe("scoreAnswer: ranked_list", () => {
  test("passes when items appear in gold order", () => {
    const r = rec("ranked_list", "alpha, beta, gamma");
    assert.equal(scoreAnswer(r, "Top three: alpha, then beta, then gamma.").correct, true);
  });

  test("fails on the wrong order", () => {
    const r = rec("ranked_list", "alpha, beta, gamma");
    const score = scoreAnswer(r, "Top three: gamma, beta, alpha.");
    assert.equal(score.correct, false);
    assert.equal(score.detail, "wrong order");
  });

  test("fails when an item is missing", () => {
    const r = rec("ranked_list", "alpha, beta, gamma");
    const score = scoreAnswer(r, "alpha then gamma");
    assert.equal(score.correct, false);
    assert.equal(score.detail, "missing items");
  });

  test("scores the final list when the response shows its work first", () => {
    const r = rec("ranked_list", "alpha, beta");
    const resp = "I compared beta and alpha across contracts. Final ranking: alpha, beta.";
    assert.equal(scoreAnswer(r, resp).correct, true);
  });
});

describe("scoreAnswer: deferred grading", () => {
  test("judge cases defer with correct null", () => {
    const score = scoreAnswer(rec("judge", "anything"), "some prose");
    assert.equal(score.correct, null);
  });

  test("a null gold answer defers regardless of match type", () => {
    const score = scoreAnswer(rec("exact_scalar", null), "some prose");
    assert.equal(score.correct, null);
  });
});

describe("scoreRetrieval", () => {
  test("perfect retrieval scores recall 1, precision 1, mrr 1", () => {
    const score = scoreRetrieval({ customers: ["a", "b"] }, { customers: ["a", "b"] }, "hybrid");
    assert.equal(score.scored, true);
    assert.equal(score.recall, 1);
    assert.equal(score.precision, 1);
    assert.equal(score.mrr, 1);
  });

  test("missing gold ids lower recall but not precision", () => {
    const score = scoreRetrieval({ customers: ["a", "b"] }, { customers: ["a"] }, "hybrid");
    assert.equal(score.recall, 0.5);
    assert.equal(score.precision, 1);
  });

  test("extra predicted ids lower precision but not recall", () => {
    const score = scoreRetrieval({ customers: ["a"] }, { customers: ["a", "x", "y", "z"] }, "hybrid");
    assert.equal(score.recall, 1);
    assert.equal(score.precision, 0.25);
  });

  test("mrr reflects the rank of the first relevant hit", () => {
    const score = scoreRetrieval({ customers: ["a"] }, { customers: ["x", "a"] }, "semantic");
    assert.equal(score.mrr, 0.5);
  });

  test("mrr is null for unranked modalities", () => {
    const score = scoreRetrieval({ customers: ["a"] }, { customers: ["a"] }, "structured");
    assert.equal(score.mrr, null);
  });

  test("duplicate predicted ids are counted once for precision", () => {
    const score = scoreRetrieval({ customers: ["a"] }, { customers: ["a", "a"] }, "hybrid");
    assert.equal(score.precision, 1);
  });

  test("empty gold and empty prediction is a vacuous pass, flagged unscored", () => {
    const score = scoreRetrieval({}, {}, "hybrid");
    assert.equal(score.scored, false);
    assert.equal(score.recall, 1);
    assert.equal(score.precision, 1);
  });

  test("mrr averages across gold entities, scoring a miss as 0", () => {
    const score = scoreRetrieval(
      { customers: ["a"], artifacts: ["art_1"] },
      { customers: ["a"], artifacts: ["art_other"] },
      "hybrid",
    );
    assert.equal(score.mrr, 0.5);
  });

  test("perEntity breaks scores down per entity", () => {
    const score = scoreRetrieval(
      { customers: ["a", "b"], artifacts: ["art_1"] },
      { customers: ["a"], artifacts: [] },
      "hybrid",
    );
    assert.deepEqual(score.perEntity.customers, { found: 1, gold: 2, recall: 0.5, precision: 1 });
    assert.deepEqual(score.perEntity.artifacts, { found: 0, gold: 1, recall: 0, precision: 0 });
  });
});
