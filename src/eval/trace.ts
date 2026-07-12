import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { EntityType, GroupedIds, ToolCall } from "./types.js";

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
    const ids = (parsed as { ids?: Record<string, string[]> } | null)?.ids;
    if (!ids || typeof ids !== "object") continue;
    for (const [entity, values] of Object.entries(ids)) {
      if (!Array.isArray(values)) continue;
      let set = seen.get(entity as EntityType);
      if (!set) {
        set = new Set();
        seen.set(entity as EntityType, set);
        grouped[entity as EntityType] = [];
      }
      for (const value of values) {
        if (typeof value !== "string" || set.has(value)) continue;
        set.add(value);
        grouped[entity as EntityType]!.push(value);
      }
    }
  }

  return grouped;
}
