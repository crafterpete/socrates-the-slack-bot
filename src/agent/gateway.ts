import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";

export type RequestContext = {
  userId: string;
  channel?: string;
  threadTs?: string;
};

export function requestConfig(context: RequestContext): RunnableConfig {
  return { configurable: { requestContext: context } };
}

function contextFrom(config?: RunnableConfig): RequestContext | undefined {
  return (config?.configurable as { requestContext?: RequestContext } | undefined)
    ?.requestContext;
}

function authorize(_context: RequestContext, _toolName: string, _args: unknown): void {}

function countRows(output: string): number | undefined {
  try {
    const rows = (JSON.parse(output) as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows.length : undefined;
  } catch {
    return undefined;
  }
}

function audit(
  context: RequestContext,
  record: { tool: string; args: unknown; ms: number; rows?: number; error?: string },
): void {
  console.log(
    JSON.stringify({
      event: "tool_call",
      ts: new Date().toISOString(),
      user: context.userId,
      channel: context.channel,
      ...record,
      ms: Math.round(record.ms),
    }),
  );
}

function wrapTool(original: StructuredToolInterface): StructuredToolInterface {
  const { func } = original as StructuredToolInterface & {
    func?: (input: unknown) => unknown;
  };
  if (!func) throw new Error(`Tool ${original.name} does not expose a callable func`);
  const run = async (args: unknown) => (await func(args)) as string;

  return tool(
    async (args: unknown, config?: RunnableConfig) => {
      const context = contextFrom(config);
      if (!context) return run(args);

      const started = performance.now();
      try {
        authorize(context, original.name, args);
        const output = await run(args);
        const ms = performance.now() - started;
        audit(context, { tool: original.name, args, ms, rows: countRows(output) });
        return output;
      } catch (error) {
        const ms = performance.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        audit(context, { tool: original.name, args, ms, error: message });
        throw error;
      }
    },
    {
      name: original.name,
      description: original.description,
      schema: original.schema,
    },
  ) as StructuredToolInterface;
}

export function withToolGateway(tools: StructuredToolInterface[]): StructuredToolInterface[] {
  return tools.map(wrapTool);
}
