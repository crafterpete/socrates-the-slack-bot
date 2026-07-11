import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Installation } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { env, getSlackSeedEnv } from "../config/env.js";
import { getInstallationStore } from "./installation-store.js";

// Exchanges the initial refresh token for a full installation record and writes it to the store, after which the running app rotates on its own.
export async function seedInstallation(): Promise<void> {
  const { SLACK_BOT_REFRESH_TOKEN, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } =
    getSlackSeedEnv();

  const oauthClient = new WebClient();
  const refreshed = await oauthClient.oauth.v2.access({
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: SLACK_BOT_REFRESH_TOKEN,
  });

  const accessToken = refreshed.access_token;
  const refreshToken = refreshed.refresh_token;
  const expiresIn = refreshed.expires_in;
  const team = refreshed.team as { id: string; name?: string } | undefined;

  if (!accessToken || !refreshToken || expiresIn === undefined || !team?.id) {
    throw new Error(
      `Unexpected oauth.v2.access response; token rotation may not be enabled for this app: ${JSON.stringify(
        refreshed,
      )}`,
    );
  }

  // auth.test fills in the bot id, which the refresh response omits.
  const identity = await new WebClient(accessToken).auth.test();
  const botUserId = (refreshed.bot_user_id as string | undefined) ?? identity.user_id;
  const botId = identity.bot_id;

  if (!botUserId || !botId) {
    throw new Error(`Could not resolve bot identity from auth.test: ${JSON.stringify(identity)}`);
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const installation: Installation<"v2", false> = {
    team: { id: team.id, name: team.name },
    enterprise: undefined,
    user: { id: botUserId, token: undefined, scopes: undefined },
    bot: {
      token: accessToken,
      refreshToken,
      expiresAt: nowSec + expiresIn, // UTC seconds, matching what Bolt writes on rotation.
      scopes: refreshed.scope ? refreshed.scope.split(",") : [],
      id: botId,
      userId: botUserId,
    },
    appId: refreshed.app_id,
    tokenType: "bot",
    authVersion: "v2", // Required, else Bolt refuses to rotate a record that has a refresh token.
    isEnterpriseInstall: false,
  };

  await getInstallationStore().storeInstallation(installation);

  console.log(
    `Seeded installation for team ${team.name ?? team.id} (${team.id}). ` +
      `Bot token expires at ${new Date((nowSec + expiresIn) * 1000).toISOString()}.`,
  );
  console.log(
    "You can now remove SLACK_BOT_REFRESH_TOKEN from .env; the store owns the tokens from here on.",
  );
}

function hasStoredInstallation(): boolean {
  if (!fs.existsSync(env.installationsDir)) {
    return false;
  }

  return fs
    .readdirSync(env.installationsDir, { withFileTypes: true })
    .some(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(env.installationsDir, entry.name, "app-latest")),
    );
}

// Seeds the store on first run only; a single-use refresh token means re-seeding an already-populated store would fail.
export async function ensureInstallation(): Promise<void> {
  if (hasStoredInstallation()) {
    return;
  }

  console.log("No stored Slack installation found; seeding from SLACK_BOT_REFRESH_TOKEN.");
  await seedInstallation();
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  seedInstallation().catch((error) => {
    console.error("Failed to seed installation:", error);
    process.exit(1);
  });
}
