import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AskUserTool } from "../src/tools/AskUserTool.js";
import {
  autoResolveAskUser,
  type AskUserPayload,
  type AskUserResult,
} from "../src/types/askUser.js";
import {
  PromptWizardBox,
  buildWizardFrame,
  createWizardState,
  finishWizard,
  reduceWizardKey,
  wizardBoxHeight,
} from "../src/cli/PromptWizardBox.js";
import { visibleWidth } from "../src/cli/Text.js";
import { StreamingToolExecutor } from "../src/core/StreamingToolExecutor.js";
import { Runtime } from "../src/core/Runtime.js";
import { SessionStore } from "../src/core/SessionStore.js";
import { loadConfig } from "../src/config/Config.js";
import { Logger } from "../src/utils/Logger.js";
import type { ToolContext } from "../src/types/tools.js";

const PAYLOAD: AskUserPayload = {
  title: "Configuración del Proyecto",
  context: "Necesito acotar el alcance antes de planificar.",
  questions: [
    {
      id: "engine",
      prompt: "¿Qué arquitectura y motor base quieres usar?",
      type: "single_select",
      defaultValue: "three",
      options: [
        { value: "three", label: "Three.js + Vite + TypeScript", hint: "WebGL 3D ligero" },
        { value: "canvas", label: "Canvas 2D / PixiJS", hint: "2D de alto rendimiento" },
        { value: "godot", label: "Godot 4 / GDScript", hint: "Motor nativo" },
      ],
    },
    {
      id: "features",
      prompt: "¿Qué mecánicas núcleo entran en el primer corte?",
      type: "multi_select",
      options: [
        { value: "audio", label: "Audio" },
        { value: "save", label: "Guardado" },
        { value: "i18n", label: "Localización" },
      ],
    },
    {
      id: "name",
      prompt: "¿Cómo se llama el proyecto?",
      type: "text",
      defaultValue: "",
    },
    {
      id: "ship",
      prompt: "¿Publicamos una build hoy?",
      type: "confirm",
      defaultValue: true,
    },
  ],
};

function context(askUser?: ToolContext["askUser"]): ToolContext {
  return { askUser } as unknown as ToolContext;
}

function setAnyKey(state: ReturnType<typeof createWizardState>, key: Parameters<typeof reduceWizardKey>[1]): void {
  reduceWizardKey(state, key);
}

describe("ask_user schema", () => {
  const tool = new AskUserTool();

  it("accepts all four question types and returns a JSON schema with the questions shape", () => {
    const parsed = tool.parse(PAYLOAD);
    expect(parsed.questions.map((question) => question.type)).toEqual([
      "single_select",
      "multi_select",
      "text",
      "confirm",
    ]);

    const schema = tool.schema().input_schema as {
      properties?: { questions?: { type?: string; items?: unknown } };
    };
    // `superRefine` wraps the object in ZodEffects; the converter must unwrap it
    // instead of advertising an empty schema to the model.
    expect(schema.properties?.questions?.type).toBe("array");
    expect(schema.properties?.questions?.items).toBeDefined();
  });

  it("rejects more than five questions", () => {
    const tooMany = {
      ...PAYLOAD,
      questions: Array.from({ length: 6 }, (_, index) => ({
        id: `q${index}`,
        prompt: "p",
        type: "text" as const,
      })),
    };
    expect(() => tool.parse(tooMany)).toThrow();
  });

  it("rejects duplicate ids", () => {
    const duplicate = {
      ...PAYLOAD,
      questions: [
        { id: "same", prompt: "a", type: "text" as const },
        { id: "same", prompt: "b", type: "text" as const },
      ],
    };
    expect(() => tool.parse(duplicate)).toThrow(/Duplicate question id/);
  });

  it("rejects a default value that does not match the question type", () => {
    const mismatched = {
      title: "x",
      questions: [{ id: "a", prompt: "a", type: "confirm", defaultValue: "yes" }],
    };
    expect(() => tool.parse(mismatched)).toThrow(/defaultValue/);
  });

  it("is read-only and exclusive", () => {
    expect(tool.readOnly).toBe(true);
    expect(tool.exclusive).toBe(true);
    expect(tool.category).toBe("read");
  });
});

describe("headless ask_user resolution", () => {
  it("uses every defaultValue and marks the result as auto-selected", () => {
    const result = autoResolveAskUser(PAYLOAD);
    expect(result).toMatchObject({
      cancelled: false,
      autoSelected: true,
      answers: { engine: "three", features: [], name: "", ship: true },
    });
  });

  it("falls back to the first option, an empty list, empty text and false", () => {
    const result = autoResolveAskUser({
      title: "t",
      questions: [
        { id: "s", prompt: "s", type: "single_select", options: [{ value: "first", label: "First" }] },
        { id: "m", prompt: "m", type: "multi_select", options: [{ value: "x", label: "X" }] },
        { id: "t", prompt: "t", type: "text" },
        { id: "c", prompt: "c", type: "confirm" },
      ],
    });
    expect(result.answers).toEqual({ s: "first", m: [], t: "", c: false });
  });

  it("does not block when the runtime has no human and a handler would hang", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carls-ask-headless-"));
    const previousAppData = process.env.APPDATA;
    const previousSystem = process.env.CARLS_SYSTEM_CONFIG;
    process.env.APPDATA = join(dir, "appdata");
    process.env.CARLS_SYSTEM_CONFIG = join(dir, "none.json");
    try {
      const config = loadConfig({ yolo: true }, dir);
      config.apiKey = "test-key";
      const session = new SessionStore(dir, config.model, undefined, join(dir, "sessions"));
      const runtime = new Runtime({ config, logger: new Logger("error"), session });
      // Even if a widget were installed, yolo must take the default path.
      runtime.setAskUserHandler(() => new Promise<AskUserResult>(() => undefined));
      const result = await Promise.race([
        runtime.askUser(PAYLOAD),
        new Promise<AskUserResult>((resolve) =>
          setTimeout(() => resolve({ answers: {}, cancelled: false, autoSelected: false }), 250),
        ),
      ]);
      expect(result.autoSelected).toBe(true);
      expect(result.answers.engine).toBe("three");
      await runtime.close();
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      if (previousSystem === undefined) delete process.env.CARLS_SYSTEM_CONFIG;
      else process.env.CARLS_SYSTEM_CONFIG = previousSystem;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the answer map through the tool result", async () => {
    const tool = new AskUserTool();
    const result = await tool.run(
      tool.parse(PAYLOAD),
      context(async () => ({
        answers: { engine: "canvas", features: ["audio"], name: "mi juego", ship: false },
        cancelled: false,
        autoSelected: false,
      })),
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("engine: canvas");
    expect(result.output).toContain("features: audio");
    expect(result.output).toContain('"autoSelected":false');
    expect(result.metadata?.answers).toMatchObject({ engine: "canvas", ship: false });
  });

  it("returns the skip message when the user cancels", async () => {
    const tool = new AskUserTool();
    const result = await tool.run(
      tool.parse(PAYLOAD),
      context(async () => ({ answers: {}, cancelled: true, autoSelected: false })),
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("El usuario omitió el cuestionario");
    expect(result.metadata?.cancelled).toBe(true);
  });

  it("never prefetches the exclusive question tool", () => {
    const executor = new StreamingToolExecutor({ execute: async () => ({ ok: true, output: "" }) });
    expect(executor.submit({ id: "a", name: "ask_user", input: {} })).toBe(false);
  });
});

describe("PromptWizardBox rendering", () => {
  it("fits every line in the terminal and uses only monochrome technical glyphs", () => {
    const state = createWizardState(PAYLOAD);
    for (const width of [40, 60, 80, 120]) {
      const lines = buildWizardFrame(state, { width, boxHeight: wizardBoxHeight(PAYLOAD) });
      expect(lines.length).toBe(wizardBoxHeight(PAYLOAD));
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      const text = lines.join("\n");
      expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
      expect(text).toContain("╭");
      expect(text).toContain("╰");
      expect(text).toContain("[Pregunta 1/4]");
      expect(text).toContain("❯");
      expect(text).toContain("●");
      expect(text).toContain("○");
    }
  });

  it("renders checkboxes for multi-select and a visible caret for text", () => {
    const state = createWizardState(PAYLOAD);
    setAnyKey(state, { name: "return" }); // confirm engine and move to features
    const multi = buildWizardFrame(state, { width: 80, boxHeight: wizardBoxHeight(PAYLOAD) }).join("\n");
    expect(multi).toContain("☐");
    setAnyKey(state, { name: "space", sequence: " " }); // toggle the first feature
    const checked = buildWizardFrame(state, { width: 80, boxHeight: wizardBoxHeight(PAYLOAD) }).join("\n");
    expect(checked).toContain("☑");

    // Move to the text question and type one character so the caret is visible.
    setAnyKey(state, { name: "return" });
    setAnyKey(state, { sequence: "m" });
    const textFrame = buildWizardFrame(state, { width: 80, boxHeight: wizardBoxHeight(PAYLOAD) }).join("\n");
    expect(textFrame).toContain("│");
    expect(textFrame).toContain("[Enter] Confirmar");
  });

  it("shows a compact summary with the chosen answers", () => {
    const state = createWizardState(PAYLOAD);
    setAnyKey(state, { name: "return" }); // engine default three
    setAnyKey(state, { name: "return" }); // features empty
    setAnyKey(state, { name: "return" }); // name empty
    setAnyKey(state, { name: "return" }); // confirm true -> summary
    const frame = buildWizardFrame(state, { width: 80, boxHeight: wizardBoxHeight(PAYLOAD) }).join("\n");
    expect(frame).toContain("[Resumen]");
    expect(frame).toContain("engine: three");
    expect(frame).toContain("[Enter] Enviar");
  });
});

describe("PromptWizardBox keyboard state machine", () => {
  it("walks four question types and produces the answer map", () => {
    const state = createWizardState(PAYLOAD);
    expect(state.mode).toBe("options");
    expect(state.answers.engine).toBe("three");

    setAnyKey(state, { name: "down" });
    setAnyKey(state, { name: "return" });
    expect(state.answers.engine).toBe("canvas");
    expect(state.index).toBe(1);

    setAnyKey(state, { name: "space", sequence: " " }); // audio
    setAnyKey(state, { name: "down" });
    setAnyKey(state, { name: "space", sequence: " " }); // save
    setAnyKey(state, { name: "return" });
    expect(state.answers.features).toEqual(["audio", "save"]);
    expect(state.mode).toBe("text");

    for (const char of "mi juego") setAnyKey(state, { sequence: char });
    setAnyKey(state, { name: "return" });
    expect(state.answers.name).toBe("mi juego");
    expect(state.index).toBe(3);

    // Confirm defaults to true on the first option; move to No and submit.
    setAnyKey(state, { name: "down" });
    setAnyKey(state, { name: "return" });
    expect(state.mode).toBe("summary");
    setAnyKey(state, { name: "return" });

    const result = finishWizard(state);
    expect(result.cancelled).toBe(false);
    expect(result.answers).toEqual({
      engine: "canvas",
      features: ["audio", "save"],
      name: "mi juego",
      ship: false,
    });
  });

  it("opens the Other option as a mini text input", () => {
    const state = createWizardState(PAYLOAD);
    // Options: three, canvas, godot, Otro.
    setAnyKey(state, { name: "down" });
    setAnyKey(state, { name: "down" });
    setAnyKey(state, { name: "down" });
    setAnyKey(state, { name: "return" });
    expect(state.mode).toBe("text");
    for (const char of "Bevy") setAnyKey(state, { sequence: char });
    setAnyKey(state, { name: "backspace" });
    setAnyKey(state, { sequence: "y" });
    setAnyKey(state, { name: "return" });
    expect(finishWizard(state).answers.engine).toBe("Bevy");
    expect(state.index).toBe(1);
  });

  it("backtracks with Shift+Tab and keeps the other answers", () => {
    const state = createWizardState(PAYLOAD);
    setAnyKey(state, { name: "return" }); // engine = three
    setAnyKey(state, { name: "space", sequence: " " }); // features = [audio]
    setAnyKey(state, { name: "tab", sequence: "\u001b[Z" }); // back to engine
    expect(state.index).toBe(0);
    setAnyKey(state, { name: "down" });
    setAnyKey(state, { name: "down" });
    setAnyKey(state, { name: "return" }); // engine = godot
    expect(state.answers.engine).toBe("godot");
    expect(state.answers.features).toEqual(["audio"]);
  });

  it("cancels with Esc", () => {
    const state = createWizardState(PAYLOAD);
    setAnyKey(state, { name: "escape" });
    expect(state.done).toBe(true);
    const result = finishWizard(state);
    expect(result.cancelled).toBe(true);
    expect(result.answers).toEqual({});
  });
});

describe("PromptWizardBox raw-mode integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders with Mode 2026 and returns the selected answers from real keypresses", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = true;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    (output as unknown as { isTTY: boolean }).isTTY = true;
    (output as unknown as { columns: number }).columns = 80;
    (output as unknown as { rows: number }).rows = 24;
    const writes: string[] = [];
    output.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));

    const payload: AskUserPayload = {
      title: "Dos preguntas",
      questions: [
        {
          id: "engine",
          prompt: "Motor",
          type: "single_select",
          options: [
            { value: "three", label: "Three.js" },
            { value: "canvas", label: "Canvas" },
          ],
        },
        { id: "ship", prompt: "¿Publicar?", type: "confirm", defaultValue: true },
      ],
    };

    const pending = PromptWizardBox.run({ payload, input, output, boxHeight: 8 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // ↓ selects Canvas, Enter commits; Enter commits the default Yes; Enter
    // sends the summary.
    input.write("\u001b[B\r\r\r");
    const result = await pending;

    expect(result.cancelled).toBe(false);
    expect(result.answers).toEqual({ engine: "canvas", ship: true });
    const text = writes.join("");
    expect(text).toContain("\u001b[?2026h");
    expect(text).toContain("[Pregunta 1/2]");
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  }, 5000);

  it("resolves defaults immediately without a TTY", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const result = await PromptWizardBox.run({ payload: PAYLOAD, input, output });
    expect(result.autoSelected).toBe(true);
    expect(result.answers.engine).toBe("three");
  });
});
