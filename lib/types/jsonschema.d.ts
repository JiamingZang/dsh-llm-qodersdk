/**
 * Convert dsh `ToolSchema.parameters` (a JSON Schema object) into a zod raw
 * shape for the SDK's in-process MCP `tool()` registration. Fidelity is
 * one-directional on purpose: anything the converter does not recognize maps
 * to `z.unknown()`, and objects stay loose (zod strips unknown keys instead
 * of rejecting them), so a converted tool never rejects arguments the host
 * tool would have accepted. Unmapped PROPERTY NAMES still appear in the shape
 * (as `z.unknown()`), so nothing the model sends is silently stripped.
 * @module dsh-llm-qoder/jsonschema
 */
import { z } from 'zod';
type JsonSchema = Record<string, unknown>;
/** A zod raw shape: property name → property schema. */
export type ZodShape = Record<string, z.ZodType>;
/**
 * Convert one JSON Schema node into one zod schema.
 * @param schema - a JSON Schema node (object form expected).
 * @param depth - recursion guard; past the cap every node becomes `z.unknown()`.
 * @returns a zod schema covering the recognized constructs.
 */
export declare function jsonSchemaToZod(schema: JsonSchema | undefined, depth?: number): z.ZodType;
/**
 * Convert a tool's `parameters` JSON Schema into a zod raw shape for `tool()`.
 * A non-object schema yields a single catch-all shape so registration stays valid.
 * @param parameters - the JSON Schema object from a dsh `ToolSchema`.
 * @returns the zod raw shape handed to the SDK MCP `tool()`.
 */
export declare function jsonSchemaToShape(parameters: Record<string, unknown>): ZodShape;
export {};
//# sourceMappingURL=jsonschema.d.ts.map