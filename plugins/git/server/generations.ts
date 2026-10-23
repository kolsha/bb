import { randomUUID } from "node:crypto";
import type { GitReadFreshness } from "../contract.js";

const WORK_TRUST_MS = 3_000;
const REFS_TRUST_MS = 30_000;

const REF_CHANGES: ReadonlySet<string> = new Set([
  "git-refs-changed",
  "status-changed",
  "environment-created",
  "environment-deleted",
]);

const WORK_KEEPING_CHANGES: ReadonlySet<string> = new Set([
  "metadata-changed",
  "thread-storage-changed",
  "diff-viewed-changed",
]);

interface Generation {
  work: number;
  workAt: number;
  refs: number;
  refsAt: number;
}

export function createReadGenerations(
  isWatched: (environmentId: string) => boolean,
  now: () => number = Date.now,
) {
  const generations = new Map<string, Generation>();

  function current(environmentId: string): Generation {
    const known = generations.get(environmentId);
    if (known !== undefined) return known;
    const at = now();
    const created = { work: 0, workAt: at, refs: 0, refsAt: at };
    generations.set(environmentId, created);
    return created;
  }

  function bump(environmentId: string, refs: boolean): void {
    const generation = current(environmentId);
    const at = now();
    generation.work += 1;
    generation.workAt = at;
    if (refs) {
      generation.refs += 1;
      generation.refsAt = at;
    }
  }

  return {
    freshness(environmentId: string, shared: boolean): GitReadFreshness {
      if (!shared || !isWatched(environmentId)) {
        const unique = randomUUID();
        return { work: unique, refs: unique };
      }
      const generation = current(environmentId);
      const at = now();
      if (at - generation.workAt > WORK_TRUST_MS) {
        generation.work += 1;
        generation.workAt = at;
      }
      if (at - generation.refsAt > REFS_TRUST_MS) {
        generation.refs += 1;
        generation.refsAt = at;
      }
      return {
        work: `${environmentId}:${generation.work}`,
        refs: `${environmentId}:${generation.refs}`,
      };
    },
    changed(environmentId: string, changes: readonly string[]): void {
      if (changes.every((change) => WORK_KEEPING_CHANGES.has(change))) return;
      bump(
        environmentId,
        changes.some((change) => REF_CHANGES.has(change)),
      );
    },
    reset(environmentId: string): void {
      bump(environmentId, true);
    },
    resetAll(): void {
      for (const environmentId of generations.keys()) bump(environmentId, true);
    },
    forget(environmentId: string): void {
      generations.delete(environmentId);
    },
  };
}

export type ReadGenerations = ReturnType<typeof createReadGenerations>;
