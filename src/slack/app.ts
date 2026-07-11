import { App, LogLevel } from "@slack/bolt";
import { getSlackEnv } from "../config/env.js";
import { getInstallationStore } from "./installation-store.js";
import { registerSlackHandlers } from "./handlers.js";

export function createSlackApp(): App {
  const slackEnv = getSlackEnv();

  const app = new App({
    appToken: slackEnv.SLACK_APP_TOKEN,
    socketMode: true,
    // OAuth credentials plus an installation store (rather than a static token) opt into Bolt's automatic token rotation.
    clientId: slackEnv.SLACK_CLIENT_ID,
    clientSecret: slackEnv.SLACK_CLIENT_SECRET,
    installationStore: getInstallationStore(),
    installerOptions: {
      // We seed the store manually and never expose the install flow, so no state store is needed.
      stateVerification: false,
    },
    logLevel: process.env.NODE_ENV === "production" ? LogLevel.INFO : LogLevel.DEBUG,
  });

  registerSlackHandlers(app);

  app.error(async (error) => {
    console.error("Slack app error:", error);
  });

  return app;
}
