import { cosineSimilarity } from "@langchain/core/utils/math";
import { OpenAIEmbeddings } from "@langchain/openai";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { getDatabase } from "./client.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(dir, "artifact_embeddings.bin");
const MANIFEST_PATH = path.resolve(dir, "artifact_embeddings.manifest.json");

interface Manifest {
  model: string;
  dim: number;
  artifactIds: string[];
  contentFingerprints: string[];
  builtAt: string;
}

interface EmbeddingIndex {
  dim: number;
  matrix: Float32Array; // artifactIds.length * dim, row-major, raw (unnormalized) embeddings
  rowByArtifactId: Map<string, number>;
}

let index: EmbeddingIndex | undefined;
let embeddings: OpenAIEmbeddings | undefined;

// Guards against the sidecar going stale if the DB fixture is regenerated without a rebuild.
function loadIndex(): EmbeddingIndex {
  if (index) return index;

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  const buf = readFileSync(BIN_PATH);
  const matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);

  const expectedLength = manifest.artifactIds.length * manifest.dim;
  if (matrix.length !== expectedLength) {
    throw new Error(
      `artifact_embeddings.bin size mismatch: expected ${expectedLength} floats, got ${matrix.length}. ` +
        `Re-run 'npm run db:build-embeddings'.`,
    );
  }

  const db = getDatabase();
  const live = db.prepare("SELECT artifact_id, content_fingerprint FROM artifacts").all() as {
    artifact_id: string;
    content_fingerprint: string;
  }[];
  const liveFingerprintById = new Map(live.map((r) => [r.artifact_id, r.content_fingerprint]));
  for (const [i, artifactId] of manifest.artifactIds.entries()) {
    if (liveFingerprintById.get(artifactId) !== manifest.contentFingerprints[i]) {
      throw new Error(
        `artifact_embeddings sidecar is stale (content_fingerprint mismatch for ${artifactId}). ` +
          `Re-run 'npm run db:build-embeddings'.`,
      );
    }
  }

  index = {
    dim: manifest.dim,
    matrix,
    rowByArtifactId: new Map(manifest.artifactIds.map((id, i) => [id, i])),
  };
  return index;
}

function getEmbeddings(): OpenAIEmbeddings {
  if (!embeddings) embeddings = new OpenAIEmbeddings({ model: env.EMBEDDING_MODEL });
  return embeddings;
}

export async function embedQuery(text: string): Promise<number[]> {
  return getEmbeddings().embedQuery(text);
}

export interface SimilarityRank {
  artifactId: string;
  rank: number; // 1-indexed, best match first
  similarity: number;
}

// Returns the full ranking, best first; callers apply their own top-k window (hybrid search
// keeps only the top CANDIDATE_POOL_SIZE so the vector side abstains on poor matches).
export function rankBySimilarity(queryVec: number[], candidateIds: string[]): SimilarityRank[] {
  const { matrix, dim, rowByArtifactId } = loadIndex();
  const validIds: string[] = [];
  const candidateVectors: number[][] = [];
  for (const artifactId of candidateIds) {
    const row = rowByArtifactId.get(artifactId);
    if (row === undefined) continue; // not in the embedded corpus; shouldn't happen post-drift-check
    const offset = row * dim;
    candidateVectors.push(Array.from(matrix.subarray(offset, offset + dim)));
    validIds.push(artifactId);
  }
  if (!validIds.length) return [];

  const similarities = cosineSimilarity([queryVec], candidateVectors)[0] ?? [];
  const scored = validIds
    .map((artifactId, i) => ({ artifactId, similarity: similarities[i] ?? 0 }))
    .sort((a, b) => b.similarity - a.similarity);
  return scored.map((s, i) => ({ artifactId: s.artifactId, rank: i + 1, similarity: s.similarity }));
}
