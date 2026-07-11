import type { InstallationStore } from "@slack/bolt";
import { FileInstallationStore } from "@slack/bolt";
import { env } from "../config/env.js";

let store: InstallationStore | undefined;

// Durable home for the rotating tokens; swap FileInstallationStore for a database or secret manager store to run on an ephemeral or multi-instance deploy.
export function getInstallationStore(): InstallationStore {
  if (!store) {
    // Passing clientId nests token files under installationsDir as
    // <clientId><teamId>/; without it they land in a sibling path the
    // .gitignore rule would miss.
    store = new FileInstallationStore({
      baseDir: env.installationsDir,
      clientId: env.SLACK_CLIENT_ID,
    });
  }

  return store;
}
