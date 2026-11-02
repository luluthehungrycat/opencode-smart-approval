import type { Options } from "./types.js";

export function parseOptions(input: Record<string, unknown>): Options {
  const allowed = new Set(["model", "timeoutMs", "minConfidence", "maxConcurrent", "dryRun"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`smart-approval: unknown option ${key}`);
  }
  function number(key: string, fallback: number, min: number, max: number): number {
    const value = input[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
      throw new Error(`smart-approval: invalid ${key}`);
    return value;
  }
  let model: Options["model"];
  if (input.model !== undefined) {
    const value = input.model as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        typeof value.providerID !== "string" || !value.providerID.trim() ||
        typeof value.id !== "string" || !value.id.trim() ||
        Object.keys(value).some(k => !["providerID", "id"].includes(k)))
      throw new Error("smart-approval: model requires providerID and id");
    model = { providerID: value.providerID, id: value.id };
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean")
    throw new Error("smart-approval: dryRun must be boolean");
  const maxConcurrent = number("maxConcurrent", 4, 1, 32);
  if (!Number.isInteger(maxConcurrent)) throw new Error("smart-approval: maxConcurrent must be integer");
  return {
    model,
    timeoutMs: number("timeoutMs", 3000, 100, 30000),
    minConfidence: number("minConfidence", 0.95, 0.9, 1),
    maxConcurrent,
    dryRun: input.dryRun === true,
  };
}
