// embed — vector quantization, similarity math, local Ollama failures, and network boundaries.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StoreError } from "../scripts/lib/db.ts";
import { VECTOR_TABLE_DDL, cosine, dequantize, embedTexts, quantize } from "../scripts/lib/embed.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const originalOllamaUrl = process.env.AI_MEMORY_OLLAMA_URL;
const originalEmbedModel = process.env.AI_MEMORY_EMBED_MODEL;

afterEach(() => {
  if (originalOllamaUrl === undefined) {
    delete process.env.AI_MEMORY_OLLAMA_URL;
  } else {
    process.env.AI_MEMORY_OLLAMA_URL = originalOllamaUrl;
  }
  if (originalEmbedModel === undefined) {
    delete process.env.AI_MEMORY_EMBED_MODEL;
  } else {
    process.env.AI_MEMORY_EMBED_MODEL = originalEmbedModel;
  }
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(dim: number, seed: number): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: dim }, () => random() * 2 - 1);
}

function floatCosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aMagnitude += a[index] ** 2;
    bMagnitude += b[index] ** 2;
  }
  return dot / Math.sqrt(aMagnitude * bMagnitude);
}

describe("embeddings", () => {
  test("quantize and dequantize preserve random 768-dimensional cosine similarity", () => {
    const first = randomVector(768, 0xdecafbad);
    const second = randomVector(768, 0x12345678);
    const expected = floatCosine(first, second);
    const firstRoundTrip = dequantize(quantize(first));
    const secondRoundTrip = dequantize(quantize(second));

    expect(Math.abs(floatCosine(firstRoundTrip, secondRoundTrip) - expected)).toBeLessThan(0.02);
  });

  test("quantize emits one bounded int8 value per input dimension", () => {
    const vector = randomVector(768, 0x9e3779b9);
    const encoded = quantize(vector);

    expect(encoded.length).toBe(vector.length);
    for (let index = 0; index < encoded.length; index += 1) {
      expect(encoded.readInt8(index)).toBeGreaterThanOrEqual(-127);
      expect(encoded.readInt8(index)).toBeLessThanOrEqual(127);
    }
  });

  test("cosine distinguishes identical, orthogonal, and opposite vectors", () => {
    const xAxis = quantize([1, 0, 0]);
    const yAxis = quantize([0, 1, 0]);
    const negativeXAxis = quantize([-1, 0, 0]);

    expect(cosine(xAxis, xAxis)).toBeCloseTo(1, 2);
    expect(cosine(xAxis, yAxis)).toBeCloseTo(0, 2);
    expect(cosine(xAxis, negativeXAxis)).toBeCloseTo(-1, 2);
  });

  test("cosine rejects buffers with mismatched dimensions", () => {
    expect(() => cosine(quantize([1, 0]), quantize([1, 0, 0]))).toThrow(StoreError);
  });

  test("embedTexts reports a local Ollama failure without waiting indefinitely", async () => {
    process.env.AI_MEMORY_OLLAMA_URL = "http://127.0.0.1:1";
    process.env.AI_MEMORY_EMBED_MODEL = "embed-test-model";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("embedTexts timed out waiting for local Ollama")), 1_000);
    });
    let failure: unknown;

    try {
      await Promise.race([embedTexts(["unreachable local embedding request"]), timeout]);
    } catch (error) {
      failure = error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    expect(failure).toBeInstanceOf(StoreError);
    if (failure instanceof StoreError) {
      expect(failure.message.toLowerCase()).toContain("ollama");
      expect(failure.message).toContain("embed-test-model");
    } else {
      throw new Error("embedTexts must reject with StoreError when local Ollama is unreachable");
    }
  }, 1_500);

  test("VECTOR_TABLE_DDL defines the keyed vector storage schema", () => {
    expect(VECTOR_TABLE_DDL).toMatch(/CREATE TABLE (?:IF NOT EXISTS )?vectors/i);
    expect(VECTOR_TABLE_DDL).toMatch(/kind\s+TEXT\s+NOT NULL/i);
    expect(VECTOR_TABLE_DDL).toMatch(/ref_id\s+INTEGER\s+NOT NULL/i);
    expect(VECTOR_TABLE_DDL).toMatch(/dim\s+INTEGER\s+NOT NULL/i);
    expect(VECTOR_TABLE_DDL).toMatch(/vec\s+BLOB\s+NOT NULL/i);
    expect(VECTOR_TABLE_DDL).toMatch(/model\s+TEXT\s+NOT NULL/i);
    expect(VECTOR_TABLE_DDL).toMatch(/PRIMARY KEY\s*\(\s*kind\s*,\s*ref_id\s*\)/i);
  });

  test("outbound network code lives only in scripts/lib/ask.ts and scripts/lib/embed.ts", () => {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else {
          files.push(path);
        }
      }
    };
    walk(join(REPO, "scripts"));
    const offenders = files.filter((file) => !file.endsWith("lib/ask.ts") && !file.endsWith("lib/embed.ts") &&
      /\bfetch\(|https?:\/\/(?!127\.0\.0\.1|localhost)/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);

    const embedPath = join(REPO, "scripts", "lib", "embed.ts");
    if (!existsSync(embedPath)) {
      throw new Error("scripts/lib/embed.ts must exist before its network policy can be checked");
    }
    const urls = readFileSync(embedPath, "utf8").match(/https?:\/\/[^\s"'`]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(/^https?:\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/.test(url)).toBeTrue();
    }
  });
});
