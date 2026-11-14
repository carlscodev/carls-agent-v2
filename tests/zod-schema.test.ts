import { describe, expect, it } from "vitest";
import { z } from "zod";

import { zodToJsonSchema } from "../src/utils/schema.js";
import { GrepSearch } from "../src/tools/GrepSearch.js";
import { MultiRead } from "../src/tools/FileOps.js";

/**
 * The JSON Schema a tool advertises is the only thing the model sees before it
 * calls the tool. These tests pin the refinements that used to be dropped on the
 * floor: `.describe()` prose, `.int()`, `.min()/.max()`, `.regex()`, array length
 * bounds and `z.record()`. Losing them is not a cosmetic diff — it hides the
 * constraint the model needs to build a valid call.
 */

describe("zodToJsonSchema", () => {
  it("keeps the description of a required, optional and defaulted field", () => {
    const schema = z.object({
      required: z.string().describe("Always send this."),
      optional: z.string().optional().describe("Only when needed."),
      defaulted: z.number().default(3).describe("Has a default."),
    });

    const out = zodToJsonSchema(schema);
    const properties = out.properties as Record<string, { description?: string; default?: unknown }>;
    expect(properties.required?.description).toBe("Always send this.");
    expect(properties.optional?.description).toBe("Only when needed.");
    expect(properties.defaulted?.description).toBe("Has a default.");
    expect(properties.defaulted?.default).toBe(3);
    expect(out.required).toEqual(["required"]);
  });

  it("keeps string length bounds and a pattern", () => {
    const schema = z.object({
      name: z.string().min(2).max(40).regex(/^[a-z][a-z0-9-]*$/).describe("Slug."),
      exact: z.string().length(4),
    });

    const properties = zodToJsonSchema(schema).properties as Record<string, Record<string, unknown>>;
    expect(properties.name).toMatchObject({ minLength: 2, maxLength: 40, pattern: "^[a-z][a-z0-9-]*$" });
    expect(properties.exact).toMatchObject({ minLength: 4, maxLength: 4 });
  });

  it("marks an integer and keeps inclusive and exclusive numeric bounds", () => {
    const schema = z.object({
      count: z.number().int().min(0).max(5).describe("A bounded count."),
      positive: z.number().int().positive(),
      negative: z.number().negative(),
      even: z.number().multipleOf(2),
    });

    const properties = zodToJsonSchema(schema).properties as Record<string, Record<string, unknown>>;
    expect(properties.count).toMatchObject({ type: "integer", minimum: 0, maximum: 5 });
    // `.positive()`/`.negative()` are exclusive bounds, not inclusive ones.
    expect(properties.positive).toMatchObject({ type: "integer", exclusiveMinimum: 0 });
    expect(properties.negative).toMatchObject({ exclusiveMaximum: 0 });
    expect(properties.even).toMatchObject({ multipleOf: 2 });
  });

  it("keeps array item type and its length bounds", () => {
    const schema = z.object({
      paths: z.array(z.string()).min(1).max(20).describe("Files."),
      fixed: z.array(z.number().int()).length(3),
    });

    const properties = zodToJsonSchema(schema).properties as Record<string, Record<string, unknown>>;
    expect(properties.paths).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
    expect(properties.paths?.items).toEqual({ type: "string" });
    expect(properties.fixed).toMatchObject({ minItems: 3, maxItems: 3 });
  });

  it("describes a record as an object with a typed additionalProperties", () => {
    const schema = z.object({ headers: z.record(z.string()).optional().describe("Request headers.") });

    const properties = zodToJsonSchema(schema).properties as Record<string, Record<string, unknown>>;
    expect(properties.headers).toMatchObject({
      type: "object",
      additionalProperties: { type: "string" },
      description: "Request headers.",
    });
  });

  it("unwraps a superRefine so the inner shape still reaches the model", () => {
    const schema = z
      .object({ questions: z.array(z.object({ id: z.string().min(1).describe("Key.") })) })
      .superRefine(() => undefined);

    const properties = zodToJsonSchema(schema).properties as Record<string, Record<string, unknown>>;
    expect(properties.questions).toMatchObject({ type: "array" });
    const items = properties.questions?.items as { properties?: Record<string, { description?: string }> };
    expect(items.properties?.id?.description).toBe("Key.");
  });

  it("keeps a description attached to an optional wrapper", () => {
    // `.optional()` returns a new node, so a later `.describe()` lands on the
    // wrapper; the converter has to read it after unwrapping the inner type.
    const schema = z.object({ value: z.string().describe("inner").optional() });
    const properties = zodToJsonSchema(schema).properties as Record<string, { description?: string }>;
    expect(properties.value?.description).toBe("inner");
  });
});

describe("built-in tool schemas expose their descriptions", () => {
  it("grep_search advertises every parameter description and the integer bounds", () => {
    const input = new GrepSearch().schema().input_schema as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(input.properties.pattern?.description).toContain("regular expression");
    expect(input.properties.max_results).toMatchObject({ type: "integer", exclusiveMinimum: 0 });
    expect(input.properties.context).toMatchObject({ type: "integer", minimum: 0, maximum: 5 });
  });

  it("multi_read advertises its path-array bounds", () => {
    const input = new MultiRead().schema().input_schema as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(input.properties.paths).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
    expect(input.properties.paths?.description).toContain("Files to read");
  });
});
