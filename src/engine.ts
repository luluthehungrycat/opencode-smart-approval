import { analyze } from "./policy.js";
import type { Analysis, Options, Request, Reviewer } from "./types.js";

export class ApprovalEngine {
  private active = 0;
  constructor(private options: Options, private reviewer?: Reviewer) {}

  async evaluate(request: Request): Promise<Analysis> {
    const deterministic = analyze(request);
    if (deterministic.effect === "deny") return deterministic;
    if (!this.reviewer) return { effect: "ask", reason: "LLM review not configured" };
    if (this.active >= this.options.maxConcurrent)
      return { effect: "ask", reason: "Classifier busy; human review required" };
    // Never truncate commands or resource lists: truncation could hide harm.
    if (JSON.stringify(request).length > 16384)
      return { effect: "ask", reason: "Request too large for safe review" };
    this.active++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Classifier deadline exceeded"));
        }, this.options.timeoutMs);
      });
      // The V2 in-process adapter currently ignores RequestOptions.signal.
      // Keep the slot occupied until generation actually settles, even after
      // our deadline returns the operation to the human permission prompt.
      const pending = Promise.resolve()
        .then(() => this.reviewer!(request, controller.signal))
        .finally(() => { this.active--; });
      const verdict = await Promise.race([pending, timeout]);
      if (!Number.isFinite(verdict.confidence) || verdict.confidence < this.options.minConfidence)
        return { effect: "ask", reason: "Classifier uncertain; human review required" };
      if (verdict.effect === "deny") return { effect: "deny", reason: "LLM identified a clearly harmful operation" };
      if (verdict.effect === "allow" && deterministic.effect === "allow")
        return { effect: "allow", reason: "Deterministic and LLM safety checks agree" };
      return { effect: "ask", reason: deterministic.effect === "ask" ? deterministic.reason : "Classifier requested human review" };
    } catch {
      return { effect: "ask", reason: "Classifier unavailable, invalid, or timed out; human review required" };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
