import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assert, canonicalize } from "./core.js";

const schemaRoot = resolve(import.meta.dirname, "../schemas");
const cache = new Map();
const supported = new Set(['$schema','$id','$ref','title','description','type','enum','const','minLength','maxLength','minItems','maxItems','uniqueItems','minimum','maximum','exclusiveMinimum','exclusiveMaximum','pattern','required','properties','additionalProperties','items','allOf','if','then','else']);
const types = new Set(['object','array','integer','number','string','boolean','null']);

// This is a deliberately bounded dialect, not a claim to implement every JSON
// Schema keyword. A contract extension cannot silently bypass enforcement.
export function assertSupportedSchema(schema) {
  if(typeof schema==='boolean')return true;
  assert(schema && typeof schema==='object' && !Array.isArray(schema),'invalid schema definition');
  for(const key of Object.keys(schema))assert(supported.has(key),'unsupported schema keyword: '+key);
  if(schema.type)assert((Array.isArray(schema.type)?schema.type:[schema.type]).every(t=>types.has(t)),'unsupported schema type');
  if(schema.$ref)assert(/^[A-Za-z0-9-]+\.schema\.json$/.test(schema.$ref),'schema references must be local catalogue names');
  for(const child of Object.values(schema.properties??{}))assertSupportedSchema(child);
  for(const key of ['items','additionalProperties','if','then','else'])if(schema[key]!==undefined)assertSupportedSchema(schema[key]);
  for(const child of schema.allOf??[])assertSupportedSchema(child);
  return true;
}

function loadSchema(name) {
  assert(/^[A-Za-z0-9-]+\.schema\.json$/.test(name),'invalid local schema name');
  if (!cache.has(name)) { const schema=JSON.parse(readFileSync(resolve(schemaRoot, name), "utf8")); assertSupportedSchema(schema); cache.set(name,schema); }
  return cache.get(name);
}

function typeMatches(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function validate(value, schema, path, rootSchema) {
  if(schema===true)return;
  if(schema===false)throw new Error(`${path}: forbidden value`);
  if (schema.$ref) return validate(value, loadSchema(schema.$ref.split("/").pop()), path, rootSchema);
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some((t) => typeMatches(value, t))) throw new Error(`${path}: expected ${schema.type}`);
  if (schema.enum && !schema.enum.some(item=>canonicalize(item)===canonicalize(value))) throw new Error(`${path}: value is not permitted`);
  if (schema.const !== undefined && canonicalize(value) !== canonicalize(schema.const)) throw new Error(`${path}: value must equal ${schema.const}`);
  if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path}: too short`);
  if (schema.maxLength !== undefined && typeof value==='string' && [...value].length > schema.maxLength) throw new Error(`${path}: too long`);
  if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path}: too few items`);
  if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path}: too many items`);
  if (schema.uniqueItems && new Set(value.map(canonicalize)).size !== value.length) throw new Error(`${path}: duplicate items`);
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path}: below minimum`);
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) throw new Error(`${path}: above maximum`);
  if (schema.exclusiveMinimum !== undefined && typeof value === "number" && value <= schema.exclusiveMinimum) throw new Error(`${path}: at or below exclusive minimum`);
  if (schema.exclusiveMaximum !== undefined && typeof value === "number" && value >= schema.exclusiveMaximum) throw new Error(`${path}: at or above exclusive maximum`);
  if (schema.pattern !== undefined && typeof value === "string" && !new RegExp(schema.pattern).test(value)) throw new Error(`${path}: pattern mismatch`);
  if (schema.required) for (const key of schema.required) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties??{},key)) validate(child, schema.properties[key], `${path}.${key}`, rootSchema);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: additional property`);
      else if(schema.additionalProperties && typeof schema.additionalProperties==='object')validate(child,schema.additionalProperties,`${path}.${key}`,rootSchema);
    }
  }
  if (Array.isArray(value) && schema.items!==undefined) value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, rootSchema));
  if (schema.allOf) for (const branch of schema.allOf) validate(value, branch, path, rootSchema);
  if (schema.if) {
    let condition = true;
    try { validate(value, schema.if, path, rootSchema); } catch { condition = false; }
    if (condition && schema.then) validate(value, schema.then, path, rootSchema);
    if (!condition && schema.else) validate(value, schema.else, path, rootSchema);
  }
}

export function assertValidSchema(value, schemaRef) {
  try { validate(value, loadSchema(schemaRef), "$", loadSchema(schemaRef)); }
  catch (error) { assert(false, `schema validation failed for ${schemaRef}: ${error.message}`); }
  return true;
}
