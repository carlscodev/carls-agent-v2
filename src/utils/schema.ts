import { z } from "zod";

type JsonSchema = Record<string, unknown>;

/**
 * Minimal zod -> JSON Schema converter. Deliberately covers only the shapes
 * the built-in tools use (object/string/number/boolean/array/enum/optional/
 * default), which keeps the harness dependency-light versus pulling in a full
 * converter library.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName?: string } & Record<string, unknown>;
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
    const inner = zodToJsonSchema((def.innerType as z.ZodTypeAny) ?? z.any());
    if (schema instanceof z.ZodDefault) {
      const defaultValue = (def.defaultValue as () => unknown)();
      return { ...inner, default: defaultValue };
    }
    return inner;
  }

  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };

  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(def.type as z.ZodTypeAny) };
  }

  if (schema instanceof z.ZodEnum) {
    const values = (def.values as string[]) ?? [];
    return { type: "string", enum: values };
  }

  if (typeName === "ZodAny") return {};

  return {};
}
