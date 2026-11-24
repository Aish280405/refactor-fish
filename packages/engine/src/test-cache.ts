import type { TestOutcome } from "./types.js";

export interface CachedResult {
  outcome: TestOutcome;
}

export interface TestCache {
  get(contentHash: string): CachedResult | undefined;
  set(contentHash: string, result: CachedResult): void;
}

/**
 * In-memory cache keyed by Content_Hash. Create one instance per analysis
 * run and discard it afterwards; there is no global or on-disk state.
 */
export class InMemoryTestCache implements TestCache {
  private readonly entries = new Map<string, CachedResult>();

  get(contentHash: string): CachedResult | undefined {
    return this.entries.get(contentHash);
  }

  set(contentHash: string, result: CachedResult): void {
    this.entries.set(contentHash, result);
  }

  get size(): number {
    return this.entries.size;
  }
}

export function createTestCache(): TestCache {
  return new InMemoryTestCache();
}
