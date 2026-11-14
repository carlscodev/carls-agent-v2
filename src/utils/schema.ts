import { z } from "zod";

type JsonSchema = Record<string, unknown>;

/** A single `.min()`/`.max()`/`.int()`/`.regex()` refinement on a zod node. */
interface ZodCheck {
  kind?: string;
  value?: number;
  inclusive?: boolean;
  regex?: RegExp;
}

/** The fields this converter reads off `schema._def`. */
interface ZodDef {
  typeName?: string;
  description?: unknown;
  checks?: ZodCheck[];
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  values?: unknown;
  value?: unknown;
  valueType?: z.ZodTypeAny;
  defaultValue?: () => unknown;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return schema._def as ZodDef;
}

/**
 * Minimal zod -> JSON Schema converter. Deliberately covers only the shapes
 * the built-in tools use, which keeps the harness dependency-light versus
 * pulling in a full converter library.
 *
 * Every refinement the model can act on has to survive the trip: the
 * `.describe()` prose on 167 parameters, the `.int()`/`.min()`/`.max()` bounds
 * and the `pattern` of a validated name. A schema that advertises only
 * `{ type: "number" }` for a field the server rejects outside 0..5 is not a
 * smaller schema, it is a wrong one — the model cannot see the constraint and
 * spends a turn on a tool error instead of a valid call.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const base = convert(schema);
  // `.describe()` on a wrapper (`.optional().describe(...)`) is stored on the
  // wrapper, not the inner type, so the text is attached after the unwrap.
  const description = defOf(schema).description;
  if (typeof description === "string" && description.length > 0 && base.description === undefined) {
    return { ...base, description };
  }
  return base;
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  const typeName = def.typeName;

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    const out: JsonSchema = { type: "object", properties };
    if (required.length > 0) out.required = required;
    return out;
  }

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(def.innerType ?? z.any());
    if (schema instanceof z.ZodDefault) {
      const defaultValue = def.defaultValue?.();
      return { ...inner, default: defaultValue };
    }
    return inner;
  }

  // `.superRefine`/`.refine` wrap the object in a ZodEffects; the JSON schema
  // must describe the inner shape, not an empty object.
  if (schema instanceof z.ZodEffects) {
    return zodToJsonSchema(def.schema ?? z.any());
  }

  if (schema instanceof z.ZodUnion) {
    return { anyOf: (def.options ?? []).map((option) => zodToJsonSchema(option)) };
  }

  if (schema instanceof z.ZodString) return stringSchema(def.checks ?? []);
  if (schema instanceof z.ZodNumber) return numberSchema(def.checks ?? []);
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };

  if (schema instanceof z.ZodArray) return arraySchema(def);
  if (schema instanceof z.ZodRecord) return { type: "object", additionalProperties: zodToJsonSchema(def.valueType ?? z.any()) };
  if (schema instanceof z.ZodLiteral) return { const: def.value };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: (def.values as string[]) ?? [] };
  if (schema instanceof z.ZodNativeEnum) {
    return { enum: Object.values((def.values as Record<string, unknown>) ?? {}) };
  }

  if (typeName === "ZodAny" || typeName === "ZodUnknown") return {};

  return {};
}

/** `minLength`/`maxLength`/`pattern` from a string's `.min()/.max()/.regex()` checks. */
function stringSchema(checks: ZodCheck[]): JsonSchema {
  const out: JsonSchema = { type: "string" };
  for (const check of checks) {
    // A `regex` check carries the pattern, not a numeric `value`, so it is
    // handled before the value guard below.
    if (check.kind === "regex") {
      if (check.regex instanceof RegExp) out.pattern = check.regex.source;
      continue;
    }
    if (check.value === undefined) continue;
    if (check.kind === "min") out.minLength = check.value;
    else if (check.kind === "max") out.maxLength = check.value;
    else if (check.kind === "length") {
      out.minLength = check.value;
      out.maxLength = check.value;
    }
  }
  return out;
}

/** `integer`/`minimum`/`maximum`/`multipleOf` from a number's checks. */
function numberSchema(checks: ZodCheck[]): JsonSchema {
  const out: JsonSchema = { type: "number" };
  for (const check of checks) {
    if (check.kind === "int") {
      out.type = "integer";
      continue;
    }
    if (check.value === undefined) continue;
    if (check.kind === "min") {
      if (check.inclusive === false) out.exclusiveMinimum = check.value;
      else out.minimum = check.value;
    } else if (check.kind === "max") {
      if (check.inclusive === false) out.exclusiveMaximum = check.value;
      else out.maximum = check.value;
    } else if (check.kind === "multipleOf") {
      out.multipleOf = check.value;
    }
  }
  return out;
}

/** `items` plus the length bounds a zod array carries on `_def`, not in `checks`. */
function arraySchema(def: ZodDef): JsonSchema {
  const out: JsonSchema = { type: "array", items: zodToJsonSchema(def.type ?? z.any()) };
  const exact = def.exactLength?.value;
  if (exact !== undefined) {
    out.minItems = exact;
    out.maxItems = exact;
    return out;
  }
  const min = def.minLength?.value;
  const max = def.maxLength?.value;
  if (min !== undefined) out.minItems = min;
  if (max !== undefined) out.maxItems = max;
  return out;
}
