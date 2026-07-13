import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

loadEnv({ path: path.join(projectRoot, ".env") });

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  DATABASE_PATH: z.string().default("src/db/synthetic_startup.sqlite"),
  STATE_DATABASE_PATH: z.string().default("data/state.sqlite"),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  NODE_ENV: z.string().default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = {
  ...parsed.data,
  projectRoot,
  databasePath: path.resolve(projectRoot, parsed.data.DATABASE_PATH),
  stateDatabasePath: path.resolve(projectRoot, parsed.data.STATE_DATABASE_PATH),
};

export type SlackEnv = {
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
};

export function getSlackEnv(): SlackEnv {
  const slackSchema = z.object({
    SLACK_BOT_TOKEN: z
      .string()
      .startsWith("xoxb-", "SLACK_BOT_TOKEN must be a bot token (xoxb-...)"),
    SLACK_APP_TOKEN: z
      .string()
      .startsWith("xapp-", "SLACK_APP_TOKEN is required for Socket Mode"),
  });

  const parsedSlack = slackSchema.safeParse(env);
  if (!parsedSlack.success) {
    const details = parsedSlack.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Slack environment is not configured:\n${details}`);
  }

  return parsedSlack.data;
}
