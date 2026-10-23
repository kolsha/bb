import fs from "node:fs/promises";

process.env.GIT_OPTIONAL_LOCKS = "0";
import {
  experimental_defineHostEntry,
  internal_DO_NOT_USE_withVcsProcessPriority as withVcsProcessPriority,
} from "@get-bb/plugin-sdk/host";
import { gitHostContract } from "./contract.js";
import {
  selectInitialPatchPaths,
  toDiffFileEntry,
} from "./host/diff-tiering.js";
import { readFileSide } from "./host/file-side.js";
import { WorkspaceReads } from "./host/workspace-reads.js";
import {
  type WorkspaceResolutionFailure,
  workspaceResolutionFailureCodeSchema,
} from "bb-git-contract";
import {
  readBranchOptions,
  refreshRemoteBranches,
} from "bb-git-host/branch-options";
import { detectGitRepo, WorkspaceError } from "bb-git-host/git";

const STATUS_MAX_FILES = 200;
const STATUS_MAX_UNTRACKED_LINE_STAT_FILES = 50;
const STATUS_MAX_UNTRACKED_LINE_STAT_BYTES = 8 * 1024 * 1024;
const DIFF_MAX_FILES = 500;
const PATCH_MAX_BYTES_PER_FILE = 512 * 1024;

const readsByPath = new Map<string, WorkspaceReads>();

type HostRead<T> =
  | { outcome: "available"; value: T }
  | { outcome: "unavailable"; failure: WorkspaceResolutionFailure };

function failureFromError(
  error: unknown,
  workspacePath: string,
): WorkspaceResolutionFailure {
  if (error instanceof WorkspaceError) {
    const code = workspaceResolutionFailureCodeSchema.safeParse(error.code);
    return {
      code: code.success ? code.data : "unknown",
      message: error.message,
      workspacePath,
    };
  }
  const errno = error instanceof Error ? Reflect.get(error, "code") : null;
  if (errno === "EACCES" || errno === "EPERM") {
    return {
      code: "permission_denied",
      message: error instanceof Error ? error.message : String(error),
      workspacePath,
    };
  }
  if (errno === "ENOENT") {
    return {
      code: "path_not_found",
      message: `Path does not exist: ${workspacePath}`,
      workspacePath,
    };
  }
  return {
    code: "unknown",
    message:
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Unknown workspace resolution failure",
    workspacePath,
  };
}

async function resolveReads(path: string): Promise<HostRead<WorkspaceReads>> {
  const known = readsByPath.get(path);
  if (known !== undefined) return { outcome: "available", value: known };
  try {
    await fs.access(path);
    if (!(await detectGitRepo(path))) {
      return {
        outcome: "unavailable",
        failure: {
          code: "not_git_repo",
          message: `Path is not a git repository: ${path}`,
          workspacePath: path,
        },
      };
    }
  } catch (error) {
    return { outcome: "unavailable", failure: failureFromError(error, path) };
  }
  const reads = new WorkspaceReads(path);
  readsByPath.set(path, reads);
  return { outcome: "available", value: reads };
}

async function read<T>(
  path: string,
  run: (reads: WorkspaceReads) => Promise<T>,
): Promise<HostRead<T>> {
  const resolved = await resolveReads(path);
  if (resolved.outcome === "unavailable") return resolved;
  try {
    return { outcome: "available", value: await run(resolved.value) };
  } catch (error) {
    readsByPath.delete(path);
    void resolved.value.dispose();
    return { outcome: "unavailable", failure: failureFromError(error, path) };
  }
}

function fileSideRefusal(
  error: unknown,
): { code: "not_found" | "invalid"; message: string } | null {
  if (error instanceof WorkspaceError) {
    if (error.code === "invalid_path" || error.code === "file_too_large") {
      return { code: "invalid", message: error.message };
    }
    return null;
  }
  const errno = error instanceof Error ? Reflect.get(error, "code") : null;
  return errno === "ENOENT"
    ? { code: "not_found", message: "File not found" }
    : null;
}

function interactive<T>(operation: () => Promise<T>): Promise<T> {
  return withVcsProcessPriority("interactive", operation);
}

export default experimental_defineHostEntry({
  contract: gitHostContract,
  dispose: async () => {
    const reads = [...readsByPath.values()];
    readsByPath.clear();
    await Promise.all(reads.map((entry) => entry.dispose()));
  },
  handlers: {
    status: ({ path, freshness, mergeBaseBranch }) =>
      read(path, (reads) =>
        reads.getStatus({
          freshness,
          ...(mergeBaseBranch === undefined ? {} : { mergeBaseBranch }),
          maxFiles: STATUS_MAX_FILES,
          maxUntrackedLineStatFiles: STATUS_MAX_UNTRACKED_LINE_STAT_FILES,
          maxUntrackedLineStatBytes: STATUS_MAX_UNTRACKED_LINE_STAT_BYTES,
        }),
      ),
    diff: ({ path, target, maxDiffBytes, maxFileListBytes }) =>
      interactive(() =>
        read(path, (reads) =>
          reads.getDiff({
            target,
            maxDiffBytes,
            maxFileListBytes,
            maxUntrackedFiles: DIFF_MAX_FILES,
          }),
        ),
      ),
    files: ({ path, freshness, target, ignoreWhitespace }) =>
      interactive(() =>
        read(path, async (reads) => {
          const result = await reads.diffFiles({
            freshness,
            target,
            maxFiles: DIFF_MAX_FILES,
            ignoreWhitespace,
          });
          const files = result.files.map(toDiffFileEntry);
          const initialPatchPaths = selectInitialPatchPaths(files);
          const initialPatches =
            initialPatchPaths.length === 0
              ? []
              : await reads
                  .diffPatch({
                    freshness,
                    target,
                    paths: initialPatchPaths,
                    maxBytesPerFile: PATCH_MAX_BYTES_PER_FILE,
                    ignoreWhitespace,
                  })
                  .catch(() => []);
          return {
            files,
            truncated: result.truncated,
            shortstat: result.shortstat,
            mergeBaseRef: result.mergeBaseRef,
            initialPatches,
          };
        }),
      ),
    patches: ({ path, freshness, target, ignoreWhitespace, paths }) =>
      interactive(() =>
        read(path, (reads) =>
          reads.diffPatch({
            freshness,
            target,
            paths,
            maxBytesPerFile: PATCH_MAX_BYTES_PER_FILE,
            ignoreWhitespace,
          }),
        ),
      ),
    fileSide: ({ path, relativePath, ref }) =>
      interactive(() =>
        readFileSide({ root: path, relativePath, ref }).then(
          (value) => ({ outcome: "available" as const, value }),
          (error: unknown) => {
            const refusal = fileSideRefusal(error);
            if (refusal === null) throw error;
            return { outcome: "refused" as const, ...refusal };
          },
        ),
      ),
    branches: ({ path, query, limit, selectedBranch }) =>
      interactive(async () => {
        if ((await resolveReads(path)).outcome === "unavailable") {
          return {
            branches: [],
            branchesTruncated: false,
            remoteBranches: [],
            remoteBranchesTruncated: false,
            selectedBranch:
              selectedBranch === undefined
                ? null
                : { name: selectedBranch, kind: "missing" as const },
          };
        }
        void refreshRemoteBranches(path, {}, "background").catch(
          () => undefined,
        );
        return readBranchOptions({
          path,
          limit,
          ...(query === undefined ? {} : { query }),
          ...(selectedBranch === undefined ? {} : { selectedBranch }),
        });
      }),
  },
});
