import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { escapeBroadcasts, MAX_INPUT_LENGTH, normalizeUserInput, stripBotMention } from "../text.js";

describe("stripBotMention", () => {
  test("removes a leading bot mention", () => {
    assert.equal(stripBotMention("<@U0BOT> how many customers?"), "how many customers?");
  });

  test("keeps inline mentions intact", () => {
    assert.equal(stripBotMention("ask <@U123> about it"), "ask <@U123> about it");
  });
});

describe("normalizeUserInput", () => {
  test("unwraps labeled links to their label", () => {
    assert.equal(
      normalizeUserInput("what do we know about <https://acme.com|acme.com>?"),
      "what do we know about acme.com?",
    );
  });

  test("unwraps bare links to the url", () => {
    assert.equal(normalizeUserInput("see <https://acme.com/docs>"), "see https://acme.com/docs");
  });

  test("unwraps user and channel references", () => {
    assert.equal(normalizeUserInput("did <@U123|jane> post in <#C9|general>?"), "did @jane post in #general?");
    assert.equal(normalizeUserInput("ping <@U123> in <#C9>"), "ping @U123 in #C9");
  });

  test("neutralizes broadcast tokens", () => {
    assert.equal(normalizeUserInput("tell <!channel> the numbers"), "tell @channel the numbers");
  });

  test("decodes slack-escaped entities", () => {
    assert.equal(normalizeUserInput("revenue &gt; 100 &amp; churn &lt; 5"), "revenue > 100 & churn < 5");
  });

  test("collapses runs of spaces and blank lines", () => {
    assert.equal(normalizeUserInput("a   b\t c\n\n\n\nd"), "a b c\n\nd");
  });

  test("caps very long input", () => {
    const long = "x".repeat(MAX_INPUT_LENGTH + 500);
    const result = normalizeUserInput(long);
    assert.equal(result.length, MAX_INPUT_LENGTH + 1);
    assert.ok(result.endsWith("…"));
  });
});

describe("escapeBroadcasts", () => {
  test("defuses channel, here, and everyone", () => {
    assert.equal(
      escapeBroadcasts("attention <!channel> and <!here> and <!everyone>"),
      "attention @channel and @here and @everyone",
    );
  });

  test("replaces labeled broadcasts with their label", () => {
    assert.equal(escapeBroadcasts("cc <!subteam^S123|@eng>"), "cc @eng");
  });

  test("leaves normal text and links untouched", () => {
    const text = "revenue is $1.2M, see <https://dash.acme.com>";
    assert.equal(escapeBroadcasts(text), text);
  });
});
