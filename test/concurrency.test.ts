import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalEngine } from "../src/engine.js";
import { parseOptions } from "../src/config.js";
import type { Verdict } from "../src/types.js";

test("timed-out reviews retain capacity until underlying generation settles", async () => {
  let finish!: (value: Verdict) => void;
  let calls = 0;
  const engine = new ApprovalEngine({ ...parseOptions({}), timeoutMs: 5, maxConcurrent: 1 },
    async () => {
      calls++;
      return new Promise(resolve => { finish = resolve; });
    });
  const request = { action: "shell", resources: ["pwd"], command: "pwd" };
  assert.equal((await engine.evaluate(request)).effect, "ask");
  assert.equal((await engine.evaluate(request)).effect, "ask");
  assert.equal(calls, 1, "timeout must not release the still-running generation's slot");
  finish({ effect: "allow", confidence: 1, reason: "late" });
  await new Promise(resolve => setImmediate(resolve));
  const next = engine.evaluate(request);
  await Promise.resolve();
  finish({ effect: "allow", confidence: 1, reason: "safe" });
  assert.equal((await next).effect, "allow");
  assert.equal(calls, 2);
});
