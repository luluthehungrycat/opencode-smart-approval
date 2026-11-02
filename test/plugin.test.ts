import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../src/index.js";
import type { Plugin } from "@opencode/plugin";

type Callback = (event: any) => Promise<void> | void;
async function harness(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, Callback>();
  let calls = 0;
  let response = '{"effect":"allow","confidence":0.99,"reason":"safe"}';
  const register = (domain: string) => async (name: string, callback: Callback) => {
    hooks.set(domain + name, callback);
    return { dispose: async () => { hooks.delete(domain + name); } };
  };
  const cleanup = await plugin.setup({
    options: { model: { providerID: "test", id: "classifier" }, ...options },
    tool: { hook: register("tool.") },
    permission: { hook: register("permission.") },
    experimental: { generate: { text: async (_input: unknown, request: { signal: AbortSignal }) => {
      calls++;
      assert.ok(request.signal instanceof AbortSignal);
      return { text: response };
    } } },
  } as unknown as Plugin.Context);
  return {
    hooks,
    cleanup,
    calls: () => calls,
    response: (value: string) => { response = value; },
    emit: async (name: string, event: any) => { await hooks.get(name)!(event); },
  };
}
const invocation = (command = "pwd", sessionID = "ses_one", id = "call_one") => ({
  tool: "shell", sessionID, messageID: "msg_one", id, input: { command },
});
const permission = (effect = "ask", sessionID = "ses_one", id = "call_one") => ({
  sessionID, action: "shell", resources: ["pwd"], effect,
  source: { type: "tool", messageID: "msg_one", id },
});

test("V2 hook changes only ask; explicit allow/deny are untouched", async () => {
  const h = await harness();
  await h.emit("tool.execute.before", invocation());
  for (const effect of ["allow", "deny"]) {
    const event = permission(effect);
    await h.emit("permission.evaluate", event);
    assert.equal(event.effect, effect);
  }
  assert.equal(h.calls(), 0);
  const event = permission();
  await h.emit("permission.evaluate", event);
  assert.equal(event.effect, "allow");
  assert.equal(h.calls(), 1);
  await h.cleanup?.();
  assert.equal(h.hooks.size, 0);
});
test("source correlation isolates sessions, messages and calls", async () => {
  const h = await harness();
  await h.emit("tool.execute.before", invocation());
  for (const event of [permission("ask", "ses_other"), permission("ask", "ses_one", "other"),
    { ...permission(), source: { ...permission().source, messageID: "msg_other" } },
    { ...permission(), source: undefined }]) {
    await h.emit("permission.evaluate", event);
    assert.equal(event.effect, "ask");
  }
  await h.cleanup?.();
});
test("lossy scanner cannot hide destructive redirection", async () => {
  const h = await harness();
  await h.emit("tool.execute.before", invocation("pwd > important.txt"));
  const event = permission();
  await h.emit("permission.evaluate", event);
  assert.equal(event.effect, "ask");
  await h.cleanup?.();
});
test("cleanup after error or completion prevents stale approvals", async () => {
  const h = await harness();
  await h.emit("tool.execute.before", invocation());
  await h.emit("tool.execute.after", { ...invocation(), status: "error" });
  const event = permission();
  await h.emit("permission.evaluate", event);
  assert.equal(event.effect, "ask");
  await h.cleanup?.();
});
test("dry run reports would-be allow and deny but always asks", async () => {
  const h = await harness({ dryRun: true });
  await h.emit("tool.execute.before", invocation());
  let event: any = permission();
  await h.emit("permission.evaluate", event);
  assert.equal(event.effect, "ask");
  assert.match(event.message, /would allow/);
  await h.emit("tool.execute.before", invocation("rm -rf /"));
  event = { ...permission(), resources: ["rm -rf /"] };
  await h.emit("permission.evaluate", event);
  assert.equal(event.effect, "ask");
  assert.match(event.message, /would deny/);
  await h.cleanup?.();
});
test("invalid provider response retains human prompt", async () => {
  const h = await harness();
  h.response("```json\n{}\n```");
  await h.emit("tool.execute.before", invocation());
  const event = permission();
  await h.emit("permission.evaluate", event);
  assert.equal(event.effect, "ask");
  await h.cleanup?.();
});
