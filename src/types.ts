export type Effect = "allow" | "ask" | "deny";
export interface Request {
  action: string;
  resources: readonly string[];
  /** Full original shell invocation, never a scanner-produced prefix. */
  command?: string;
}
export interface Analysis {
  effect: Effect;
  reason: string;
}
export interface Verdict extends Analysis {
  confidence: number;
}
export type Reviewer = (request: Request, signal: AbortSignal) => Promise<Verdict>;
export interface Options {
  model?: { providerID: string; id: string };
  timeoutMs: number;
  minConfidence: number;
  maxConcurrent: number;
  dryRun: boolean;
}
