import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Minimal structured logger. Diagnostics go to stderr so that stdout stays
 * reserved for the model's answer (safe to pipe in CI).
 */
export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, message: string): void {
    if (!this.enabled(level)) return;
    const tag =
      level === "debug"
        ? pc.gray("[debug]")
        : level === "info"
          ? pc.blue("[info]")
          : level === "warn"
            ? pc.yellow("[warn]")
            : pc.red("[error]");
    process.stderr.write(`${tag} ${message}\n`);
  }

  debug(message: string): void {
    this.write("debug", message);
  }
  info(message: string): void {
    this.write("info", message);
  }
  warn(message: string): void {
    this.write("warn", message);
  }
  error(message: string): void {
    this.write("error", message);
  }
}

/**
 * Removes credential-shaped substrings from text that may be logged, printed in
 * an error, or sent back to the model. Covers the key formats of every bundled
 * provider plus generic `key=value` pairs, so a stray header or stack trace
 * cannot leak a secret into the transcript.
 */
const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /sk-proj-[A-Za-z0-9_\-]{16,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /nvapi-[A-Za-z0-9_\-]{16,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /AIza[A-Za-z0-9_\-]{30,}/g,
  /hf_[A-Za-z0-9]{20,}/g,
  /(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g,
  /r8_[A-Za-z0-9]{20,}/g,
  /csk-[A-Za-z0-9]{20,}/g,
  /(?:fwk|fw_)[A-Za-z0-9]{20,}/g,
  /pplx-[A-Za-z0-9]{20,}/g,
  /(?:Bearer|Basic)\s+[A-Za-z0-9._\-]{16,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, "***");
  return out
    .replace(/(authorization|api[-_]?key|token|secret|password)"?\s*[:=]\s*"?[^\s",}]+/gi, "$1=***")
    .replace(/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "***");
}
