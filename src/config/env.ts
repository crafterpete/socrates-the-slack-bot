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
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_BOT_REFRESH_TOKEN: z.string().optional(),
  SLACK_INSTALLATIONS_DIR: z.string().default(".slack-installations"),
  DATABASE_PATH: z.string().default("src/db/synthetic_startup.sqlite"),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
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
  installationsDir: path.resolve(projectRoot, parsed.data.SLACK_INSTALLATIONS_DIR),
};

export type SlackEnv = {
  SLACK_APP_TOKEN: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
};

// Bolt fetches and rotates the bot token via the installation store, so only the OAuth credentials come from the environment.
export function getSlackEnv(): SlackEnv {
  const slackSchema = z.object({
    SLACK_APP_TOKEN: z
      .string()
      .startsWith("xapp-", "SLACK_APP_TOKEN is required for Socket Mode"),
    SLACK_CLIENT_ID: z.string().min(1, "SLACK_CLIENT_ID is required for token rotation"),
    SLACK_CLIENT_SECRET: z
      .string()
      .min(1, "SLACK_CLIENT_SECRET is required for token rotation"),
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

export type SlackSeedEnv = {
  SLACK_BOT_REFRESH_TOKEN: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
};

// Credentials the one-time seed script needs to mint the first installation.
export function getSlackSeedEnv(): SlackSeedEnv {
  const seedSchema = z.object({
    SLACK_BOT_REFRESH_TOKEN: z
      .string()
      .startsWith("xoxe-", "SLACK_BOT_REFRESH_TOKEN must be a refresh token (xoxe-...)"),
    SLACK_CLIENT_ID: z.string().min(1, "SLACK_CLIENT_ID is required"),
    SLACK_CLIENT_SECRET: z.string().min(1, "SLACK_CLIENT_SECRET is required"),
  });

  const parsedSeed = seedSchema.safeParse(env);
  if (!parsedSeed.success) {
    const details = parsedSeed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Slack seed environment is not configured:\n${details}`);
  }

  return parsedSeed.data;
}
