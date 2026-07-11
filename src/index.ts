import { createSlackApp } from "./slack/app.js";
import { env } from "./config/env.js";

async function main(): Promise<void> {
  console.log(`Database ready: ${env.databasePath}`);

  const app = createSlackApp();
  await app.start();

  console.log("Slack bot is running in Socket Mode.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
