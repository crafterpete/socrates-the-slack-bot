import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { EntityType, GroupedIds, ToolCall } from "./types.js";

// Maps a row's *_id column to the entity_type it belongs to. This is the seam that
// makes retrieval scoring independent of tool design. Today the tools return JSON
// strings, so we infer ids from column names below. Once tools return structured
// { [entity_type]: { ids, text } }, delete extractRetrieval and read that directly.
const ID_FIELD_TO_ENTITY: Record<string, EntityType> = {
  artifact_id: "artifacts",
  customer_id: "customers",
  competitor_id: "competitors",
  product_id: "products",
  employee_id: "employees",
  implementation_id: "implementations",
  scenario_id: "scenarios",
  company_id: "company_profile",
};

export class RetrievalCaptureHandler extends BaseCallbackHandler {
  name = "retrieval_capture";
  toolCalls: ToolCall[] = [];
  private pending = new Map<string, { name: string; input: string }>();

  handleToolStart(
    _tool: unknown,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    this.pending.set(runId, { name: runName ?? "unknown", input });
  }

  handleToolEnd(output: unknown, runId: string): void {
    const text =
      typeof output === "string"
        ? output
        : typeof (output as { content?: unknown })?.content === "string"
          ? ((output as { content: string }).content)
          : JSON.stringify(output ?? "");
    const call = this.pending.get(runId);
    this.toolCalls.push({ name: call?.name ?? "unknown", input: call?.input ?? "", output: text });
  }
}

export function extractRetrieval(toolCalls: ToolCall[]): GroupedIds {
  const grouped: GroupedIds = {};
  const seen = new Map<EntityType, Set<string>>();

  for (const { output } of toolCalls) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        const entity = ID_FIELD_TO_ENTITY[key];
        if (!entity || typeof value !== "string") continue;
        let set = seen.get(entity);
        if (!set) {
          set = new Set();
          seen.set(entity, set);
          grouped[entity] = [];
        }
        if (set.has(value)) continue;
        set.add(value);
        grouped[entity]!.push(value);
      }
    }
  }

  return grouped;
}
