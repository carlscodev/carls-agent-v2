---
name: carls-code-config
description: Change carls-code's own configuration: add a provider, change defaults, wire credentials, adjust permission modes or limits.
version: 1
when_to_use: Use when the user asks to add a new model provider, change defaults, or configure carls itself.
tags: [config provider openai anthropic deepseek settings defaults credentials mode limits]
---
# Changing carls-code configuration

## Layers and precedence

Highest wins:

1. CLI flags (`--model`, `--provider`, `--base-url`, `--mode`, `--effort`)
2. `./.carlsrc.json` in the working directory
3. `~/.carlsrc.json`
4. `/etc/carls/.carlsrc.json` (override the path with `$CARLS_SYSTEM_CONFIG`)
5. Built-in defaults in `src/config/Config.ts`

The system layer is what lets a brand-new user on a machine run `carls` with no
setup. Keep it valid.

## Adding a provider

One object in `src/providers/registry.ts`. Nothing else needs to change: the CLI,
the onboarding wizard, `/doctor`, `--providers`, the model catalog and both
installers read the registry at runtime.

```ts
{
  id: "acme",
  label: "Acme AI",
  family: "Aggregator",              // Frontier | Aggregator | Enterprise | Open weights | Fast inference | Self-hosted
  protocol: "openai",                // "anthropic" for the native Messages API
  baseUrl: "https://api.acme.ai/v1",
  apiKeyEnv: ["ACME_API_KEY"],       // first name is what onboarding suggests
  defaultModel: "acme-large",
  knownModels: [],                   // optional fallback when /models cannot be reached
  keysUrl: "https://acme.ai/keys",
  contextWindow: 128000,
  reasoningHints: REASONING_DEFAULT,
}
```

Checklist:

1. Add the object and confirm the id is unique (`providerById` would shadow it).
2. Set a real `baseUrl` and `defaultModel`, so `--provider acme` alone works.
3. If the key has a distinctive prefix, add it to `KEY_PATTERNS` in
   `src/utils/Logger.ts` so it never reaches a log or an error message.
4. For a local, keyless backend set `keyless: true` and `local: true`.
5. For a gateway with no fixed URL, point at the existing `compatible` entry and
   have the user pass `--base-url`.
6. Add a case to the "provider registry" describe block in `tests/smoke.test.ts`.
7. Update the provider table in `README.md` if the family counts change.

`protocol: "anthropic"` is only for a genuine Messages API. Everything else uses
`OpenAICompatProvider` and inherits retries, streaming and tool-call parsing.

## Credentials

Prefer `apiKeyEnv` (an environment variable) over an `apiKey` field. Write
config files with mode 600 when they hold a key. The installer runs
`src/setup/writeConfig.ts`; extend it if you add a new field, and remember it
merges rather than overwrites.

## Verification

`carls --doctor` prints the resolved provider, key source and endpoint
reachability. Use it before and after a config change.
