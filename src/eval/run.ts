import { askAgent, createQaAgent } from "../agent/index.js";
import { applyFilters, loadDataset } from "./dataset.js";
import { printReport, writeReport } from "./report.js";
import { scoreAnswer, scoreRetrieval } from "./score.js";
import { extractRetrieval, RetrievalCaptureHandler } from "./trace.js";
import type { EvalResult, GoldenRecord } from "./types.js";

interface CliArgs {
  filters: Record<string, string>;
  onlyRetrieval: boolean;
  onlyAnswer: boolean;
  limit?: number;
  dataset?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { filters: {}, onlyRetrieval: false, onlyAnswer: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only-retrieval") args.onlyRetrieval = true;
    else if (a === "--only-answer") args.onlyAnswer = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--dataset") args.dataset = argv[++i];
    else if (a === "--filter") {
      const [key, value] = (argv[++i] ?? "").split("=");
      if (key && value) args.filters[key] = value;
    }
  }
  return args;
}

function buildMessages(rec: GoldenRecord): Array<{ role: "user" | "assistant"; content: string }> {
  if (rec.messages?.length) return rec.messages;
  return [{ role: "user", content: rec.question }];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let records = applyFilters(loadDataset(args.dataset), args.filters);
  if (args.limit) records = records.slice(0, args.limit);

  if (records.length === 0) {
    console.log("No matching records.");
    return;
  }

  const agent = createQaAgent();
  const results: EvalResult[] = [];

  for (const rec of records) {
    const handler = new RetrievalCaptureHandler();
    let answer: string;
    try {
      answer = await askAgent(agent, buildMessages(rec), { callbacks: [handler] });
    } catch (err) {
      answer = `ERROR: ${(err as Error).message}`;
    }

    const predicted = extractRetrieval(handler.toolCalls);
    results.push({
      id: rec.id,
      question: rec.question,
      answer,
      answerScore: args.onlyRetrieval ? null : scoreAnswer(rec, answer),
      retrievalScore: args.onlyAnswer ? null : scoreRetrieval(rec.relevant_ids, predicted),
      predicted,
      toolCalls: handler.toolCalls,
    });
    process.stdout.write(".");
  }

  printReport(results);
  const out = writeReport(results);
  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
