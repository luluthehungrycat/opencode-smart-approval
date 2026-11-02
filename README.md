# OpenCode Smart Approval

A conservative **OpenCode V2** server plugin: deterministic checks + an independent LLM safety review, applied **only to permissions whose current effect is `ask`**.

Targets OpenCode **2.2.x**, using `@opencode/plugin`, `ctx.permission.hook("evaluate")`, and `ctx.experimental.generate.text`. This is not a V1 `@opencode-ai/plugin` / `permission.ask` plugin.

## Install locally

Requires Node 22+ for development and OpenCode 2.2+.

```sh
npm ci
npm run check
```

Merge this into your **global** `~/.config/opencode/opencode.jsonc` (replace the path and model with your own):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-smart-approval",
      "options": {
        "model": { "providerID": "anthropic", "id": "claude-haiku-5-5" },
        "timeoutMs": 3000,
        "minConfidence": 0.95,
        "maxConcurrent": 4,
        "dryRun": true
      }
    }
  ],
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "ask" }
  ]
}
```

Use an already configured OpenCode model/provider; the plugin neither stores nor asks for API keys. Restart OpenCode after building. Start with `dryRun: true`: permission prompts show what the plugin **would** decide. Set it to `false` to enable automatic decisions.

This package is not published to npm. Point OpenCode at this built directory; rebuilding updates `dist/`. Do not use `--auto` when testing: it can remove the `ask` decisions this plugin is designed to review.

## Decision policy

1. Existing `allow` or `deny`: untouched; no classifier call.
2. Deterministically recognized destructive operations: deny immediately, without an LLM call.
3. Otherwise, consult the configured stateless classifier:
   - **Allow** only if the deterministic allowlist **and** the model agree, at or above the confidence threshold.
   - **Deny** if the model identifies clear harm at or above the threshold.
   - **Ask** for everything else, using OpenCode's normal human permission prompt.
4. Missing model, malformed output, errors, oversized inputs, timeouts, or saturated capacity: ask, never auto-allow.

Automatic decisions affect only the current evaluation; the plugin does not save broad “always allow” rules.

### Deliberately narrow initial auto-allow scope

Shell candidates: `pwd` (optionally `-L` or `-P`), `ls` with only flag groups from `alhAF1` and **no path operands**, and `git --version`. All still need model agreement.

Full command text must be captured from the corresponding shell tool invocation and match the single scanner resource. Redirects, substitutions, pipelines, compound commands, wrappers, quotes, arbitrary arguments, missing correlation, and scanner mismatches are **not** auto-approved.

Examples:

- `pwd`, `ls -lah` → eligible for auto-approval after LLM agreement.
- `git status`, `npm test`, edits, file reads, MCP calls, web access → human by default, or model deny if clearly harmful. **No LLM-only auto-approval.**
- `rm -rf /`, `rm -rf ~`, formatting a device, `dd ... of=/dev/sda` → deterministic deny.
- `mkfs.ext4 -n /dev/sda` → not deterministically denied; reviewed by model/human.

All action names are reviewed, but non-shell permissions currently have **no deterministic auto-allow rules**. This is a cautious starting policy, not vendor-level coverage or a general shell safety proof. Extend `src/policy.ts` with narrowly scoped rules and adversarial tests rather than allowing arbitrary commands based solely on model confidence.

## Options

- `model`: `{ providerID, id }`; omitted means no LLM calls and no automatic approvals (deterministic denials remain active).
- `timeoutMs`: 100–30000; default 3000.
- `minConfidence`: 0.9–1; default 0.95. Self-reported confidence is not a calibrated safety guarantee.
- `maxConcurrent`: integer 1–32; default 4. Saturation goes straight to the human.
- `dryRun`: default false; keep all reviewed requests as `ask`, displaying the proposed decision.

Unknown options and malformed configuration fail plugin setup explicitly.

## Security and privacy

- The classifier sees action names, permission resources, and the correlated full shell command. **These can contain secrets, paths, URLs, or private data.** Configuring a remote classifier sends that data to its provider. Use a trusted/local model when appropriate. There is no claim of automatic secret redaction.
- No transcript, file contents, environment values, arbitrary metadata, or command output is collected. No persistent decision cache or command log is written by this plugin. OpenCode and your provider may have their own logging.
- Input is explicitly treated as untrusted, responses are strict JSON, and the classifier has no session history or tools. Prompt injection can still affect an LLM; it cannot expand the deterministic auto-allow scope.
- OpenCode 2.2.0's in-process generation adapter ignores cancellation options. The plugin stops **waiting** at its deadline, but generation may finish later. Its capacity slot remains occupied until it actually settles; stuck generations eventually make all reviews fall back to humans. The timeout does not guarantee cancellation or avoid provider charges.
- Shell binaries, PATH, shell initialization, aliases/functions, the host, and other plugins must be trusted. A malicious replacement for `ls` is not made safe by command-text analysis. Other plugins can also change tool input, shell invocations, or permission decisions. This plugin is not a sandbox and does not enforce policy against hostile plugins.
- Configured `allow` decisions intentionally bypass smart review, including dangerous commands. OpenCode's explicit configured `deny` is final.
- Legitimate destructive work may be smart-denied. Adjust explicit OpenCode rules or disable this plugin only after reviewing the operation; do not weaken the classifier globally to fix one false positive.

## Development

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests cover policy edge cases, strict model parsing, timeout/concurrency behavior, V2 hook registration, unchanged allow/deny effects, dry runs, source isolation, stale-call cleanup, and scanner-loss attacks. Tests use mocked generation: they do not execute dangerous commands or send paid model requests.

### Official references

- [V2 server plugin documentation](https://opencode.ai/docs/build/plugins/server) — permission evaluation and lifecycle.
- [Official documentation source](https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/build/plugins/server.mdx) — see “Permissions”.
- [V2 permissions](https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/permissions.mdx) — action names, scanner resources, configured rule precedence.
- [V2 plugin loading](https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/build/plugins/index.mdx).
- Published `@opencode/plugin@2.2.0` declarations were used for compile-time API verification.
