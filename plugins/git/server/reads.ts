import {
  experimental_PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import {
  GIT_DIFF_MAX_DIFF_BYTES,
  GIT_DIFF_MAX_FILE_LIST_BYTES,
  gitHostContract,
  type DiffPatchEntry,
  type GitDiffResult,
  type GitFileContent,
  type GitFileSideQuery,
  type GitFilesResult,
  type GitReadFreshness,
  type GitStatusResult,
} from "../contract.js";
import { environmentMergeBaseBranch } from "../merge-base-branch.js";
import type {
  GitBranchOptions,
  WorkspaceDiffTarget,
} from "bb-git-contract";

const READ_CACHE_TTL_MS = 3_000;
const HOST_CALL_TIMEOUT_MS = 30_000;

type Environment = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["get"]>
>;

interface ReadyGitEnvironment {
  environment: Environment;
  hostId: string;
  path: string;
}

const NOT_APPLICABLE_MESSAGES = {
  status: "Workspace status is not available for non-git environments",
  diff: "Workspace diff is not available for non-git environments",
} as const;

function notApplicable(kind: keyof typeof NOT_APPLICABLE_MESSAGES) {
  return {
    outcome: "not_applicable" as const,
    reason: "non_git_environment" as const,
    message: NOT_APPLICABLE_MESSAGES[kind],
  };
}

function workspaceUnavailableMessage(environment: Environment): string {
  switch (environment.status) {
    case "creating":
    case "provisioning":
      return "Workspace is still starting.";
    case "error":
      return "Workspace setup failed.";
    case "destroyed":
      return "Workspace no longer exists.";
    case "ready":
      return "Workspace is unavailable.";
  }
}

function requireWorkspacePath(environment: Environment): string {
  if (environment.status !== "ready" || environment.path === null) {
    throw new experimental_PluginRpcRefusal({
      code: "conflict",
      message: workspaceUnavailableMessage(environment),
    });
  }
  return environment.path;
}

function httpStatusOf(error: unknown): number | null {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : null;
}

interface CacheEntry<T> {
  environmentId: string;
  hostId: string;
  value: Promise<T>;
  expiresAt: number;
}

export class EnvironmentReadCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly retains: (value: T) => boolean = () => true,
  ) {}

  read(
    target: { environmentId: string; hostId: string },
    key: string,
    cache: ReadCacheUse,
    load: () => Promise<T>,
  ): Promise<T> {
    if (cache === "bypass") return load();
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > now) return cached.value;
    const entry: CacheEntry<T> = {
      environmentId: target.environmentId,
      hostId: target.hostId,
      value: load(),
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.entries.set(key, entry);
    entry.value.then(
      (value) => {
        if (this.entries.get(key) !== entry) return;
        if (this.ttlMs === 0 || !this.retains(value)) this.entries.delete(key);
        else entry.expiresAt = Date.now() + this.ttlMs;
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.value;
  }

  clear(environmentId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.environmentId === environmentId) this.entries.delete(key);
    }
  }

  clearHost(hostId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.hostId === hostId) this.entries.delete(key);
    }
  }
}

export type ReadCacheUse = "shared" | "bypass";

export interface GitReads {
  status(
    environmentId: string,
    mergeBase: { kind: "environment" } | { kind: "explicit"; branch?: string },
    cache: ReadCacheUse,
  ): Promise<GitStatusResult>;
  diff(
    environmentId: string,
    target: WorkspaceDiffTarget,
    limits?: { maxDiffBytes?: number; maxFileListBytes?: number },
  ): Promise<GitDiffResult>;
  files(
    environmentId: string,
    target: WorkspaceDiffTarget,
    ignoreWhitespace: boolean,
    cache: ReadCacheUse,
  ): Promise<GitFilesResult>;
  patches(
    environmentId: string,
    target: WorkspaceDiffTarget,
    ignoreWhitespace: boolean,
    paths: string[],
    cache: ReadCacheUse,
  ): Promise<
    | { outcome: "available"; patches: DiffPatchEntry[] }
    | Exclude<GitFilesResult, { outcome: "available" }>
  >;
  fileSide(
    environmentId: string,
    query: GitFileSideQuery,
  ): Promise<GitFileContent>;
  branches(args: {
    environmentId: string;
    query?: string;
    limit: number;
    selectedBranch?: string;
  }): Promise<GitBranchOptions>;
  clearCaches(environmentId: string): void;
  clearHostCaches(hostId: string): void;
}

function createHostClient(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: gitHostContract });
  return {
    call<Method extends keyof typeof gitHostContract & string>(
      method: Method,
      input: Parameters<typeof host.call<Method>>[1],
      hostId: string,
    ) {
      return host.call(method, input, {
        hostId,
        timeoutMs: HOST_CALL_TIMEOUT_MS,
      });
    },
  };
}

function resolveFileSideRef(query: GitFileSideQuery): string | null {
  switch (query.target) {
    case "uncommitted":
      return query.side === "old" ? "HEAD" : null;
    case "branch_committed":
      return query.side === "old" ? query.mergeBaseRef : "HEAD";
    case "all":
      return query.side === "old" ? query.mergeBaseRef : null;
    case "commit":
      return query.side === "old" ? `${query.sha}^` : query.sha;
  }
}

function isAvailable(result: { outcome: string }): boolean {
  return result.outcome === "available";
}

export function createGitReads(
  bb: BbPluginApi,
  freshness: (environmentId: string, shared: boolean) => GitReadFreshness,
): GitReads {
  const host = createHostClient(bb);
  const statusCache = new EnvironmentReadCache<GitStatusResult>(
    READ_CACHE_TTL_MS,
    isAvailable,
  );
  const filesCache = new EnvironmentReadCache<GitFilesResult>(
    READ_CACHE_TTL_MS,
    isAvailable,
  );

  async function requireEnvironment(
    environmentId: string,
  ): Promise<Environment> {
    try {
      return await bb.sdk.environments.get({ environmentId });
    } catch (error) {
      if (httpStatusOf(error) === 404) {
        throw new experimental_PluginRpcRefusal({
          code: "not_found",
          message: `Environment not found: ${environmentId}`,
        });
      }
      throw error;
    }
  }

  async function requireReady(
    environmentId: string,
  ): Promise<ReadyGitEnvironment | null> {
    const environment = await requireEnvironment(environmentId);
    const path = requireWorkspacePath(environment);
    if (!environment.isGitRepo) return null;
    return { environment, hostId: environment.hostId, path };
  }

  return {
    async status(environmentId, mergeBase, cache) {
      const ready = await requireReady(environmentId);
      if (ready === null) return notApplicable("status");
      const mergeBaseBranch =
        mergeBase.kind === "environment"
          ? environmentMergeBaseBranch(ready.environment)
          : mergeBase.branch;
      return statusCache.read(
        { environmentId, hostId: ready.hostId },
        JSON.stringify([environmentId, ready.hostId, ready.path, mergeBaseBranch ?? null]),
        cache,
        async () => {
          const result = await host.call(
            "status",
            {
              path: ready.path,
              freshness: freshness(environmentId, cache === "shared"),
              ...(mergeBaseBranch === undefined ? {} : { mergeBaseBranch }),
            },
            ready.hostId,
          );
          return result.outcome === "available"
            ? { outcome: "available", workspace: result.value }
            : result;
        },
      );
    },
    async diff(environmentId, target, limits = {}) {
      const ready = await requireReady(environmentId);
      if (ready === null) return notApplicable("diff");
      const result = await host.call(
        "diff",
        {
          path: ready.path,
          target,
          maxDiffBytes: limits.maxDiffBytes ?? GIT_DIFF_MAX_DIFF_BYTES,
          maxFileListBytes:
            limits.maxFileListBytes ?? GIT_DIFF_MAX_FILE_LIST_BYTES,
        },
        ready.hostId,
      );
      return result.outcome === "available"
        ? { outcome: "available", diff: result.value }
        : result;
    },
    async files(environmentId, target, ignoreWhitespace, cache) {
      const ready = await requireReady(environmentId);
      if (ready === null) return notApplicable("diff");
      return filesCache.read(
        { environmentId, hostId: ready.hostId },
        JSON.stringify([environmentId, ready.hostId, ready.path, target, ignoreWhitespace]),
        cache,
        async () => {
          const result = await host.call(
            "files",
            {
              path: ready.path,
              freshness: freshness(environmentId, cache === "shared"),
              target,
              ignoreWhitespace,
            },
            ready.hostId,
          );
          return result.outcome === "available"
            ? { outcome: "available", ...result.value }
            : result;
        },
      );
    },
    async patches(environmentId, target, ignoreWhitespace, paths, cache) {
      const ready = await requireReady(environmentId);
      if (ready === null) return notApplicable("diff");
      const result = await host.call(
        "patches",
        {
          path: ready.path,
          freshness: freshness(environmentId, cache === "shared"),
          target,
          ignoreWhitespace,
          paths,
        },
        ready.hostId,
      );
      return result.outcome === "available"
        ? { outcome: "available", patches: result.value }
        : result;
    },
    async fileSide(environmentId, query) {
      const environment = await requireEnvironment(environmentId);
      const path = requireWorkspacePath(environment);
      const result = await host.call(
        "fileSide",
        {
          path,
          relativePath: query.path,
          ref: resolveFileSideRef(query),
        },
        environment.hostId,
      );
      if (result.outcome === "refused") {
        throw new experimental_PluginRpcRefusal({
          code: result.code,
          message: result.message,
        });
      }
      return result.value;
    },
    async branches({ environmentId, query, limit, selectedBranch }) {
      const environment = await requireEnvironment(environmentId);
      const path = requireWorkspacePath(environment);
      return host.call(
        "branches",
        {
          path,
          limit,
          ...(query === undefined ? {} : { query }),
          ...(selectedBranch === undefined ? {} : { selectedBranch }),
        },
        environment.hostId,
      );
    },
    clearCaches(environmentId) {
      statusCache.clear(environmentId);
      filesCache.clear(environmentId);
    },
    clearHostCaches(hostId) {
      statusCache.clearHost(hostId);
      filesCache.clearHost(hostId);
    },
  };
}
