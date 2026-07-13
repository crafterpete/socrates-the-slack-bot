import { OpenAIEmbeddings } from "@langchain/openai";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { getDatabase } from "./client.js";

// One-time offline build for artifact_embeddings.bin/.manifest.json; re-run with `npm run db:build-embeddings`.

const dir = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(dir, "artifact_embeddings.bin");
const MANIFEST_PATH = path.resolve(dir, "artifact_embeddings.manifest.json");

interface ArtifactRow {
  artifact_id: string;
  title: string;
  summary: string;
  content_text: string;
  content_fingerprint: string;
}

async function main(): Promise<void> {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT artifact_id, title, summary, content_text, content_fingerprint FROM artifacts ORDER BY artifact_id")
    .all() as ArtifactRow[];

  console.log(`Embedding ${rows.length} artifacts with ${env.EMBEDDING_MODEL}...`);
  const embeddings = new OpenAIEmbeddings({ model: env.EMBEDDING_MODEL });
  const texts = rows.map((r) => `${r.title}\n\n${r.summary}\n\n${r.content_text}`);
  const vectors = await embeddings.embedDocuments(texts);

  const dim = vectors[0]?.length ?? 0;
  if (!dim) throw new Error("Embedding provider returned an empty vector set");

  const matrix = new Float32Array(rows.length * dim);
  vectors.forEach((vec, i) => matrix.set(vec, i * dim));

  writeFileSync(BIN_PATH, Buffer.from(matrix.buffer));
  writeFileSync(
    MANIFEST_PATH,
    JSON.stringify(
      {
        model: env.EMBEDDING_MODEL,
        dim,
        artifactIds: rows.map((r) => r.artifact_id),
        contentFingerprints: rows.map((r) => r.content_fingerprint),
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`Wrote ${BIN_PATH} (${rows.length} x ${dim} float32) and ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
