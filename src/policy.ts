import type { Analysis, Request } from "./types.js";

const ask = (reason: string): Analysis => ({ effect: "ask", reason });

/**
 * This is intentionally not a shell parser. Only a tiny, expansion-free language
 * qualifies for approval. Everything else is escalated, not guessed safe.
 */
export function analyze(request: Request): Analysis {
  if (!request.resources.length || request.resources.length > 64 ||
      request.resources.some(r => !r || r.length > 8192))
    return ask("Missing or oversized permission resources");

  if (request.action !== "shell")
    return ask("This permission requires human context");

  // Resources are scanner products and may omit redirects or other effects.
  // Without a correlated original invocation they can NEVER authorize a shell.
  const command = request.command;
  if (!command || command.length > 8192) return ask("Full shell invocation unavailable");

  // Deny only unambiguous, simple destructive operations. Complex/quoted shell
  // syntax remains human-reviewed rather than risking regex false positives.
  const plain = /^[a-zA-Z0-9_./=,:+@%~* -]+$/.test(command);
  if (plain) {
    const words = command.trim().split(/ +/);
    const executable = words[0];
    const args = words.slice(1);
    const end = args.indexOf("--");
    const flags = end < 0 ? args : args.slice(0, end);
    if ((flags.includes("--help") || flags.includes("--version")) && executable !== "git")
      return ask("Help or version invocation outside the approval policy");
    if (["rm", "/bin/rm", "/usr/bin/rm"].includes(executable ?? "")) {
      const recursive = flags.some(a => /^-[^-]*[rR]/.test(a) || a === "--recursive");
      const targets = end < 0 ? args.filter(a => !a.startsWith("-")) : args.slice(end + 1);
      if (recursive && targets.some(t => ["/", "/*", "~", "~/", "~/*"].includes(t)))
        return { effect: "deny", reason: "Recursive deletion of root or home directory" };
    }
    // e2fsprogs -n is explicitly non-writing. It is NOT portable to mkfs.xfs
    // or other formatters, so only these verified executables get this escape.
    if (/^(?:\/sbin\/|\/usr\/sbin\/)?mkfs\.ext[234]$/.test(executable ?? "") &&
        flags.some(a => /^-[^-]*n/.test(a)))
      return ask("Non-writing filesystem inspection still requires human review");
    if (/^(?:\/sbin\/|\/usr\/sbin\/)?mkfs(?:\.[a-zA-Z0-9]+)?$/.test(executable ?? "") &&
        args.some(a => a.startsWith("/dev/")))
      return { effect: "deny", reason: "Filesystem formatting of a device" };
    if (["dd", "/bin/dd", "/usr/bin/dd"].includes(executable ?? "") && args.some(a => /^of=\/dev\/(?:sd|hd|vd|nvme|mmcblk|disk)/.test(a)))
      return { effect: "deny", reason: "Raw disk overwrite" };
  }

  // Full invocation must itself be simple AND match the single resource.
  // No paths, operands, quotes, expansions, redirects, pipelines, or wrappers.
  const normalized = command.trim().replace(/ +/g, " ");
  if (!/^[a-zA-Z0-9 -]+$/.test(command) || request.resources.length !== 1 ||
      request.resources[0]?.trim().replace(/ +/g, " ") !== normalized)
    return ask("Shell syntax or scanner mismatch requires human review");
  if (normalized === "pwd" || normalized === "pwd -L" || normalized === "pwd -P" ||
      /^ls(?: -[alhAF1]+)*$/.test(normalized) || normalized === "git --version")
    return { effect: "allow", reason: "Narrow read-only shell candidate; requires LLM agreement" };

  return ask("Command is outside the narrow read-only policy");
}
