import { Plugin } from "@opencode/plugin";
import { parseOptions } from "./config.js";
import { ApprovalEngine } from "./engine.js";
import { buildPrompt, parseVerdict } from "./reviewer.js";
import type { Request, Reviewer } from "./types.js";

export default Plugin.define({
  id: "smart-approval",
  async setup(ctx) {
    const options = parseOptions(ctx.options);
    // No session history or tools: avoids recursive approvals and gives the
    // classifier no execution authority. OpenCode owns provider credentials.
    const reviewer: Reviewer | undefined = options.model
      ? async (request, signal) => {
          const result = await ctx.experimental.generate.text(
            { model: options.model!, prompt: buildPrompt(request) },
            { signal },
          );
          return parseVerdict(result.text);
        }
      : undefined;
    const engine = new ApprovalEngine(options, reviewer);

    // Correlate the complete invocation; scanner resources alone are lossy.
    // Captured objects are copied, bounded, never persisted, and scoped to a
    // session + message + call ID (not merely the currently active session).
    const commands = new Map<string, string>();
    const key = (sessionID: string, messageID: string, id: string) =>
      JSON.stringify([sessionID, messageID, id]);
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    try {
      registrations.push(await ctx.tool.hook("execute.before", event => {
        if (event.tool !== "shell") return;
        const input = event.input as Record<string, unknown> | null;
        if (input && typeof input.command === "string" && input.command.length <= 8192) {
          // Bounded memory even if a host fails to deliver execute.after.
          if (commands.size >= 256) commands.delete(commands.keys().next().value!);
          commands.set(key(event.sessionID, event.messageID, event.id), input.command);
        }
      }));
      registrations.push(await ctx.tool.hook("execute.after", event => {
        commands.delete(key(event.sessionID, event.messageID, event.id));
      }));
      registrations.push(await ctx.permission.hook("evaluate", async event => {
        if (event.effect !== "ask") return;
        const command = event.source?.type === "tool"
          ? commands.get(key(event.sessionID, event.source.messageID, event.source.id))
          : undefined;
        const request: Request = {
          action: event.action,
          resources: [...event.resources],
          ...(event.action === "shell" && command !== undefined ? { command } : {}),
        };
        const decision = await engine.evaluate(request);
        // Other hooks can modify a shared draft while we await. Never replace
        // a decision that is no longer ask.
        if (event.effect !== "ask") return;
        event.effect = options.dryRun ? "ask" : decision.effect;
        event.message = options.dryRun
          ? `Smart approval (dry run): would ${decision.effect}. ${decision.reason}`
          : `Smart approval: ${decision.reason}`;
      }));
    } catch (error) {
      await Promise.allSettled(registrations.map(r => r.dispose()));
      throw error;
    }
    return async () => {
      await Promise.allSettled(registrations.map(r => r.dispose()));
      commands.clear();
    };
  },
});
