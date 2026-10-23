import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { gitStatusErrorMessage } from "@bb/shared-ui/git-status-display";
import {
  gitPatchKey,
  gitRpcContract,
  type DiffFileEntry,
  type GitFilesResult,
  type GitPatchResult,
  type GitStatusRow,
} from "../contract.js";
import type {
  WorkspaceDiffTarget,
  WorkspaceResolutionFailure,
  WorkspaceStatus,
} from "bb-git-contract";

export interface GitStatusState {
  result: GitStatusRow | undefined;
  workspace: WorkspaceStatus | undefined;
  failure: WorkspaceResolutionFailure | undefined;
  errorMessage: string | null;
  isLoading: boolean;
}

export function useGitStatus(environmentId: string | null): GitStatusState {
  const query = useRpcKeyedQuery({
    contract: gitRpcContract,
    method: "status",
    keys: environmentId === null ? [] : [environmentId],
    enabled: environmentId !== null,
  });
  const result =
    environmentId === null ? undefined : query.data?.[environmentId];
  return {
    result,
    workspace: result?.outcome === "available" ? result.workspace : undefined,
    failure: result?.outcome === "unavailable" ? result.failure : undefined,
    errorMessage:
      result?.outcome === "failed"
        ? result.message
        : gitStatusErrorMessage(query.error),
    isLoading: environmentId !== null && query.isLoading,
  };
}

export function useGitFiles(args: {
  environmentId: string | null;
  target: WorkspaceDiffTarget | undefined;
  ignoreWhitespace: boolean;
  enabled: boolean;
}): {
  result: GitFilesResult | undefined;
  isLoading: boolean;
  dataUpdatedAt: number;
} {
  const query = useRpcQuery({
    contract: gitRpcContract,
    method: "files",
    input: {
      environmentId: args.environmentId ?? "",
      target: args.target ?? { type: "uncommitted" },
      ignoreWhitespace: args.ignoreWhitespace,
    },
    enabled:
      args.enabled && args.environmentId !== null && args.target !== undefined,
  });
  return {
    result: query.data,
    isLoading: query.isLoading,
    dataUpdatedAt: query.data === undefined ? 0 : filesStamp(query.data),
  };
}

const filesStamps = new WeakMap<object, number>();
let nextFilesStamp = 1;

function filesStamp(result: GitFilesResult): number {
  const existing = filesStamps.get(result);
  if (existing !== undefined) return existing;
  const stamp = nextFilesStamp++;
  filesStamps.set(result, stamp);
  return stamp;
}

export function useGitPatches(args: {
  environmentId: string | null;
  target: WorkspaceDiffTarget | undefined;
  ignoreWhitespace: boolean;
  files: readonly Pick<DiffFileEntry, "path" | "revision">[];
}): Record<string, GitPatchResult | undefined> {
  const { environmentId, target, ignoreWhitespace, files } = args;
  const keyByPath = new Map<string, string>();
  if (environmentId !== null && target !== undefined) {
    for (const file of files) {
      keyByPath.set(
        file.path,
        gitPatchKey({
          environmentId,
          target,
          ignoreWhitespace,
          path: file.path,
          revision: file.revision,
        }),
      );
    }
  }
  const query = useRpcKeyedQuery({
    contract: gitRpcContract,
    method: "patches",
    keys: [...keyByPath.values()],
    enabled: keyByPath.size > 0,
  });
  const byPath: Record<string, GitPatchResult | undefined> = {};
  for (const [path, key] of keyByPath) byPath[path] = query.data?.[key];
  return byPath;
}

export function useGitViewed(args: {
  environmentId: string | null;
  target: WorkspaceDiffTarget | undefined;
  paths: readonly string[];
  enabled: boolean;
}) {
  return useRpcQuery({
    contract: gitRpcContract,
    method: "viewed",
    input: {
      environmentId: args.environmentId ?? "",
      target: args.target ?? { type: "uncommitted" },
      paths: [...args.paths].sort(),
    },
    enabled:
      args.enabled && args.environmentId !== null && args.target !== undefined,
  });
}

export function useMarkViewed() {
  return useRpcMutation({
    contract: gitRpcContract,
    method: "markViewed",
  });
}

export function useClearViewed() {
  return useRpcMutation({
    contract: gitRpcContract,
    method: "clearViewed",
  });
}

const BRANCH_SEARCH_DEBOUNCE_MS = 120;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

export function useGitBranches(args: {
  environmentId: string | null;
  query: string;
  selectedBranch: string | undefined;
  enabled: boolean;
}) {
  const trimmed = useDebouncedValue(
    args.query.trim(),
    BRANCH_SEARCH_DEBOUNCE_MS,
  );
  return useRpcQuery({
    contract: gitRpcContract,
    method: "branches",
    input: {
      environmentId: args.environmentId ?? "",
      ...(trimmed === "" ? {} : { query: trimmed }),
      ...(args.selectedBranch === undefined
        ? {}
        : { selectedBranch: args.selectedBranch }),
    },
    enabled: args.enabled && args.environmentId !== null,
  });
}

export function useSetMergeBase() {
  return useRpcMutation({
    contract: gitRpcContract,
    method: "setMergeBase",
  });
}
