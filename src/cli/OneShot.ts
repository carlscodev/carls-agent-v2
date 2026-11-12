import type { ResolvedConfig } from "../config/Config.js";
import { Runtime } from "../core/Runtime.js";
import { SessionStore } from "../core/SessionStore.js";
import type { Logger } from "../utils/Logger.js";
import { expandMentions } from "./Mentions.js";
import { Spinner, printError, printInfo, printTurnSummary } from "./TerminalUI.js";

/**
 * `carls -p "…"`.
 *
 * The answer is the only thing on stdout — every diagnostic goes to stderr — so
 * `carls -p "…" | jq` stays pipeable. Mentions are expanded here too, which is
 * what makes `carls -p "review @src/app.ts"` work without a TTY: the same
 * parser as the REPL, so both interfaces attach the same files under the same
 * limits.
 */
export async function runOneShot(query: string, config: ResolvedConfig, logger: Logger): Promise<number> {
  const expanded = expandMentions(query, config.cwd);
  if (expanded.attached.length > 0) printInfo(`attached ${expanded.attached.join(", ")}`);
  for (const skip of expanded.skipped) printInfo(`could not attach ${skip.path} (${skip.reason})`);

  const session = new SessionStore(config.cwd, config.model);
  const runtime = new Runtime({ config, logger, session });
  const spinner = new Spinner(process.stderr.isTTY === true);
  let streamed = false;
  let steps = 0;
  const startedAt = Date.now();
  try {
    await runtime.connectMcpServers();
    await runtime.start();
    spinner.start("working");
    const result = await runtime.runTurn(expanded.text, {
      onStep: (step) => {
        steps = step;
      },
      onText: (chunk) => {
        spinner.stop();
        streamed = true;
        process.stdout.write(chunk);
      },
    });
    spinner.stop();
    // In print mode the answer may arrive without any streamed delta (for
    // example when the model only calls tools), so emit the final text then.
    if (!streamed && result.finalText.length > 0) process.stdout.write(result.finalText);
    process.stdout.write("\n");
    printTurnSummary({
      durationMs: Date.now() - startedAt,
      steps,
      stoppedReason: result.stoppedReason,
      tokens: runtime.cost.compact(),
    });
    return result.stoppedReason === "error" ? 1 : 0;
  } catch (error) {
    spinner.stop();
    printError((error as Error).message);
    return 1;
  } finally {
    await runtime.close();
  }
}
