import type { OcxRequestOptions, OcxTool } from "./types.cjs";

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "definitions",
  "$defs",
  "default",
  "examples",
  "title",
  // Responses-only collaboration annotation; it is not a JSON-Schema keyword
  // understood by external provider tool APIs.
  "encrypted",
]);

const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  ...UNSUPPORTED_SCHEMA_KEYS,
  "$comment",
  "patternProperties",
  "propertyNames",
  "if",
  "then",
  "else",
  "uniqueItems",
  "additionalItems",
  "dependentRequired",
  "dependentSchemas",
  "contains",
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

function normalizeGeminiValue(value: unknown, defs: Map<string, unknown>, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeGeminiValue(item, defs, depth));
  if (!isRecord(value)) return value;

  if (typeof value.$ref === "string" && depth < 64) {
    const match = value.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
    const targetName = match?.[1].replace(/~1/g, "/").replace(/~0/g, "~");
    const target = targetName ? defs.get(decodeURIComponent(targetName)) : undefined;
    if (isRecord(target)) {
      const merged: Schema = { ...target };
      for (const [key, child] of Object.entries(value)) if (key !== "$ref") merged[key] = child;
      return normalizeGeminiValue(merged, defs, depth + 1);
    }
  }

  const result: Schema = {};
  let composition: Schema | undefined;
  for (const [key, child] of Object.entries(value)) {
    // `properties` is a map of user-facing argument names, not a schema node.
    // Preserve names such as `title`, `default`, and `examples` while still
    // normalizing each property's schema value. Filtering the map itself makes
    // required connector arguments disappear from Gemini tool declarations.
    if (key === "properties" && isRecord(child)) {
      const properties: Schema = {};
      for (const [name, propertySchema] of Object.entries(child)) {
        properties[name] = normalizeGeminiValue(propertySchema, defs, depth + 1);
      }
      result.properties = properties;
      continue;
    }
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "$ref") continue;
    if (COMPOSITION_KEYS.has(key)) {
      const first = Array.isArray(child) ? child.find(isRecord) : undefined;
      if (first) composition = normalizeGeminiValue(first, defs, depth + 1) as Schema;
      continue;
    }
    if (key === "type" && Array.isArray(child)) {
      const nonNull = child.filter((type) => type !== "null");
      if (nonNull.length) result.type = nonNull[0];
      if (child.includes("null")) result.nullable = true;
      continue;
    }
    if (key === "const") {
      result.enum = [child];
      continue;
    }
    if (key === "exclusiveMinimum" && typeof child === "number") {
      result.minimum = child;
      continue;
    }
    if (key === "exclusiveMaximum" && typeof child === "number") {
      result.maximum = child;
      continue;
    }
    if (key === "additionalProperties") {
      result.additionalProperties = typeof child === "boolean" ? child : normalizeGeminiValue(child, defs, depth + 1);
      continue;
    }
    result[key] = normalizeGeminiValue(child, defs, depth + 1);
  }
  return normalizeGeminiRequired(composition ? { ...composition, ...result } : result);
}

function collectGeminiDefs(root: unknown, defs: Map<string, unknown>): void {
  if (!isRecord(root)) return;
  for (const key of ["$defs", "definitions"]) {
    const group = root[key];
    if (!isRecord(group)) continue;
    for (const [name, value] of Object.entries(group)) if (!defs.has(name)) defs.set(name, value);
  }
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
  const defs = new Map<string, unknown>();
  collectGeminiDefs(schema, defs);
  const normalized = normalizeGeminiValue(schema, defs);
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

export function buildToolCatalogNudge(
  names: readonly string[],
  choice?: OcxRequestOptions["toolChoice"],
): string | undefined {
  if (choice === "none") return undefined;
  const unique = [...new Set(names.filter((name) => name.trim().length > 0))];
  if (!unique.length) return undefined;
  const neighboringNames = ["Read", "Grep", "Glob", "Bash", "LS", "apply_patch"]
    .filter((name) => !unique.includes(name));
  return [
    "Tool contract: use the current tool catalog as ground truth.",
    `Valid tool names for this turn are exactly ${unique.map((name) => `\`${name}\``).join(", ")}.`,
    "Call only listed names with their listed argument keys; do not invent, translate, or rename tools.",
    neighboringNames.length ? `Do not use neighboring-agent tool names ${neighboringNames.map((name) => `\`${name}\``).join(", ")} unless this turn's catalog lists those exact names.` : undefined,
    "If you need shell, file search, file read, edit, or discovery behavior, choose the listed tool that provides that capability.",
    "Count a tool call only after its tool result returns; batch independent read-only calls when the runtime supports it.",
    "Treat tool results as ground truth; never claim an external create, update, save, publish, or deployment succeeded unless its result confirms success.",
    "If a referenced existing remote resource is missing or inaccessible, report that blocker instead of silently substituting a local URL or creating a replacement unless the user explicitly requested or authorized that fallback.",
    "Keep calling tools until the requested work is complete; a progress statement alone is not completion.",
  ].filter((line): line is string => typeof line === "string").join(" ");
}
