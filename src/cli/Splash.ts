import * as readline from "node:readline";
import pc from "picocolors";
import { terminalDimension, visibleWidth } from "./Text.js";

const EYES = ["◕   ◕", "◔   ◔", "•   •", "◕   ◕"];
const ANTENNA = ["●", "◉", "○", "◉"];
const FRAME_MS = 130;
const TOTAL_MS = 1300;

export interface SplashInfo {
  name: string;
  version: string;
  model: string;
  cwd: string;
}

/**
 * Boot animation shown once when the interactive REPL starts: the agent's
 * avatar, centred, with its name. Any keypress skips it, and it never runs when
 * stdin is not a terminal, so scripts and pipes are unaffected.
 */
export class Splash {
  static async show(info: SplashInfo): Promise<void> {
    if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return;

    const input = process.stdin;
    const out = process.stderr;
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw === true;
    input.setRawMode?.(true);
    input.resume();

    let frame = 0;
    let skipped = false;
    const onKey = (): void => {
      skipped = true;
    };
    input.on("keypress", onKey);

    const draw = (): void => {
      const art = Splash.art(frame, info);
      const width = terminalDimension(out.columns);
      const height = terminalDimension(out.rows, 24);
      const top = Math.max(1, Math.floor((height - art.length) / 2));
      let buffer = "\u001b[2J\u001b[H";
      for (let index = 0; index < top - 1; index++) buffer += "\n";
      for (const line of art) {
        const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
        buffer += `${" ".repeat(pad)}${line}\n`;
      }
      out.write(buffer);
    };

    try {
      out.write("\u001b[?25l");
      const started = Date.now();
      draw();
      while (!skipped && Date.now() - started < TOTAL_MS) {
        await delay(FRAME_MS);
        if (skipped) break;
        frame += 1;
        draw();
      }
      out.write("\u001b[2J\u001b[H\u001b[?25h");
    } finally {
      input.off("keypress", onKey);
      input.setRawMode?.(wasRaw);
      input.pause();
    }
  }

  static art(frame: number, info: SplashInfo): string[] {
    const eyes = EYES[frame % EYES.length] ?? EYES[0] ?? "";
    const antenna = ANTENNA[frame % ANTENNA.length] ?? "●";
    const accent = (text: string): string => pc.cyan(text);
    const dim = (text: string): string => pc.gray(text);
    return [
      `     ${accent(`╭──${antenna}──╮`)}`,
      `   ${accent("╭┴───────┴╮")}`,
      `   ${accent("│")} ${pc.white(eyes)} ${accent("│")}`,
      `   ${accent("│")}   ${pc.cyan("‿")}   ${accent("│")}`,
      `   ${accent("╰───────╯")}`,
      "",
      `   ${pc.bold(pc.white(info.name))} ${dim(`v${info.version}`)}`,
      `   ${dim(info.model)}`,
      "",
      `   ${dim("gather")} ${pc.cyan("→")} ${dim("act")} ${pc.cyan("→")} ${dim("verify")}`,
    ];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
