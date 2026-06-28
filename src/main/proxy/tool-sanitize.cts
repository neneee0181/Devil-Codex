import type { OcxTool } from "./types.cjs";

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "definitions",
  "$defs",
  "default",
  "examples",
  "title",
]);

const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  ...UNSUPPORTED_SCHEMA_KEYS,
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

const COMPOSITION_KEYS = new Set(["oneOf", "anyOf", "allOf"]);
const CORE_TOOL_NAME = /(?:apply|patch|exec|shell|terminal|file|read|write|search|find|list|browser|command)/i;

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!isRecord(value)) return value;

  const result: Schema = {};
  let composition: Schema | undefined;
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (COMPOSITION_KEYS.has(key)) {
      const first = Array.isArray(child) ? child.find(isRecord) : undefined;
      if (first) composition = normalizeValue(first) as Schema;
      continue;
    }
    result[key] = normalizeValue(child);
  }
  return composition ? { ...composition, ...result } : result;
}

function normalizeGeminiValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeGeminiValue);
  if (!isRecord(value)) return value;

  const result: Schema = {};
  let composition: Schema | undefined;
  for (const [key, child] of Object.entries(value)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (COMPOSITION_KEYS.has(key)) {
      const first = Array.isArray(child) ? child.find(isRecord) : undefined;
      if (first) composition = normalizeGeminiValue(first) as Schema;
      continue;
    }
    result[key] = normalizeGeminiValue(child);
  }
  return normalizeGeminiRequired(composition ? { ...composition, ...result } : result);
}

function normalizeGeminiRequired(schema: Schema): Schema {
  if (!Array.isArray(schema.required)) return schema;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const required = schema.required.filter((name): name is string => {
    if (typeof name !== "string") return false;
    return properties ? Object.prototype.hasOwnProperty.call(properties, name) : false;
  });
  if (required.length) return { ...schema, required };
  const { required: _required, ...rest } = schema;
  return rest;
}

export function normalizeSchema(schema: unknown): Schema {
  const normalized = normalizeValue(schema);
  if (!isRecord(normalized)) return { type: "object", properties: {}, required: [] };
  if (typeof normalized.type === "string") return normalized;
  return { type: "object", properties: {}, required: [], ...normalized };
}

export function normalizeGeminiSchema(schema: unknown): Schema {
  const normalized = normalizeGeminiValue(schema);
  if (!isRecord(normalized)) return { type: "object", properties: {}, required: [] };
  if (typeof normalized.type === "string") return normalized;
  return { type: "object", properties: {}, required: [], ...normalized };
}

export function sanitizeName(name: string): string {
  return (name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool");
}

export function limitTools<T extends OcxTool>(tools: T[], max: number): T[] {
  if (tools.length <= max) return tools;
  const core = tools.filter((tool) => CORE_TOOL_NAME.test(tool.name));
  const rest = tools.filter((tool) => !CORE_TOOL_NAME.test(tool.name));
  return [...core, ...rest].slice(0, max);
}

export function budgetTools<T extends OcxTool>(tools: T[], max: number, requiredName?: string): T[] {
  if (max <= 0) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  const add = (items: T[]): void => {
    for (const tool of items) {
      const key = `${tool.namespace ?? ""}:${tool.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tool);
      if (out.length >= max) return;
    }
  };

  add(tools.filter((tool) => tool.toolSearch || tool.name === "tool_search"));
  if (requiredName) add(tools.filter((tool) => tool.name === requiredName || `${tool.namespace ?? ""}__${tool.name}` === requiredName));
  add(tools.filter((tool) => tool.loaded));
  add(tools.filter((tool) => CORE_TOOL_NAME.test(tool.name)));
  add(tools);
  return out;
}
