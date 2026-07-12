import { App, LogLevel } from "@slack/bolt";
import { env, getSlackEnv } from "../config/env.js";
import { registerSlackHandlers } from "./handlers.js";

export function createSlackApp(): App {
  const slackEnv = getSlackEnv();

  const app = new App({
    token: slackEnv.SLACK_BOT_TOKEN,
    appToken: slackEnv.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: env.NODE_ENV === "production" ? LogLevel.INFO : LogLevel.DEBUG,
  });

  registerSlackHandlers(app);

  app.error(async (error) => {
    console.error("Slack app error:", error);
  });

  return app;
}
