import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalEngine } from "../src/engine.js";
import { parseOptions } from "../src/config.js";
import { parseVerdict } from "../src/reviewer.js";
import type { Effect, Verdict } from "../src/types.js";
const safe = { action: "shell", command: "pwd", resources: ["pwd"] };
const verdict = (effect: Effect, confidence = 0.99): Verdict => ({ effect, confidence, reason: "test" });
const options = parseOptions({});

test("requires two independent approvals", async () => {
  const engine = new ApprovalEngine(options, async () => verdict("allow"));
  assert.equal((await engine.evaluate(safe)).effect, "allow");
  assert.equal((await engine.evaluate({ ...safe, command: "npm test", resources: ["npm test"] })).effect, "ask");
  assert.equal((await engine.evaluate({ action: "edit", resources: ["a.ts"] })).effect, "ask");
});
test("hard deny never calls the LLM", async () => {
  const engine = new ApprovalEngine(options, async () => { throw new Error("must not call"); });
  assert.equal((await engine.evaluate({ ...safe, command: "rm -rf /", resources: ["rm -rf /"] })).effect, "deny");
});
test("high confidence model deny and ask", async () => {
  for (const effect of ["deny", "ask"] as const) {
    assert.equal((await new ApprovalEngine(options, async () => verdict(effect)).evaluate(safe)).effect, effect);
  }
});
test("no model, uncertain model, errors default to ask", async () => {
  const engines = [
    new ApprovalEngine(options),
    new ApprovalEngine(options, async () => verdict("allow", 0.94)),
    new ApprovalEngine(options, async () => verdict("deny", 0.5)),
    new ApprovalEngine(options, async () => { throw new Error("offline"); }),
    new ApprovalEngine(options, async () => parseVerdict("not json")),
  ];
  for (const engine of engines) assert.equal((await engine.evaluate(safe)).effect, "ask");
});
test("deadline aborts and late result cannot grant permission", async () => {
  let signal: AbortSignal | undefined;
  let finish!: (v: Verdict) => void;
  const engine = new ApprovalEngine({ ...options, timeoutMs: 10 }, async (_, s) => {
    signal = s;
    return new Promise(resolve => { finish = resolve; });
  });
  const result = await engine.evaluate(safe);
  assert.equal(result.effect, "ask");
  assert.equal(signal?.aborted, true);
  finish(verdict("allow"));
  await Promise.resolve();
  assert.equal(result.effect, "ask");
});
test("concurrent requests overflow to human rather than queue", async () => {
  let finish!: (v: Verdict) => void;
  const engine = new ApprovalEngine({ ...options, maxConcurrent: 1 }, async () =>
    new Promise(resolve => { finish = resolve; }));
  const first = engine.evaluate(safe);
  assert.equal((await engine.evaluate(safe)).effect, "ask");
  finish(verdict("allow"));
  assert.equal((await first).effect, "allow");
});
test("oversized requests are not truncated for LLM review", async () => {
  let called = false;
  const engine = new ApprovalEngine(options, async () => { called = true; return verdict("allow"); });
  assert.equal((await engine.evaluate({ action: "edit", resources: ["x".repeat(20000)] })).effect, "ask");
  assert.equal(called, false);
});
test("strict response schema", () => {
  assert.equal(parseVerdict(JSON.stringify(verdict("allow"))).effect, "allow");
  for (const value of [
    "null", "[]", "{}", "```json\n{}\n```",
    '{"effect":"allow","confidence":1,"reason":"yes","extra":true}',
    '{"effect":"allow","confidence":2,"reason":"yes"}',
    '{"effect":"allow","confidence":"1","reason":"yes"}',
    '{"effect":"allow","confidence":1,"reason":""}',
  ]) assert.throws(() => parseVerdict(value));
});
test("configuration fails loudly on typos and unsafe thresholds", () => {
  for (const value of [{ timeotMs: 1 }, { timeoutMs: -1 }, { minConfidence: 0.1 },
    { dryRun: "false" }, { model: {} }, { maxConcurrent: 1.5 }]) {
    assert.throws(() => parseOptions(value));
  }
});
