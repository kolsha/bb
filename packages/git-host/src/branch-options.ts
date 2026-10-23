import {
  fetchRemoteBranches,
  getGitCommonDir,
  listBranchRefsWithDefaults,
  type GitProcessOptions,
} from "./git.js";
import { withGitRefMutationLock } from "bb-environment-provider-host/process-local-lock";
import type {
  GitBranchOptions,
  GitBranchRefClassification,
} from "bb-git-contract";

interface LimitBranchListArgs {
  branches: readonly string[];
  limit: number;
  query?: string;
}

interface LimitedBranchList {
  branches: string[];
  truncated: boolean;
}

interface PinBranchArgs {
  branches: readonly string[];
  branch: string | undefined;
}

interface ClassifySelectedBranchArgs {
  branches: readonly string[];
  remoteBranches: readonly string[];
  selectedBranch?: string;
}

export interface ReadBranchOptionsArgs extends GitProcessOptions {
  path: string;
  limit: number;
  query?: string;
  selectedBranch?: string;
}

const REMOTE_BRANCH_FETCH_THROTTLE_MS = 30_000;
const REMOTE_BRANCH_FETCH_TIMEOUT_MS = 5_000;
export type RemoteRefreshMode = "background" | "blocking";

const remoteBranchFetchStateByCommonDir = new Map<
  string,
  {
    fetchedAt: number;
    inFlight: Promise<void> | null;
    needsInteractiveRetry: boolean;
  }
>();

function limitBranchList({
  branches,
  limit,
  query,
}: LimitBranchListArgs): LimitedBranchList {
  const normalizedQuery = query?.trim().toLowerCase();
  const filteredBranches =
    normalizedQuery && normalizedQuery.length > 0
      ? branches.filter((branch) =>
          branch.toLowerCase().includes(normalizedQuery),
        )
      : [...branches];
  return {
    branches: filteredBranches.slice(0, limit),
    truncated: filteredBranches.length > limit,
  };
}

function pinBranch({ branches, branch }: PinBranchArgs): string[] {
  if (!branch || !branches.includes(branch)) {
    return [...branches];
  }

  return [branch, ...branches.filter((candidate) => candidate !== branch)];
}

export function classifySelectedBranch({
  branches,
  remoteBranches,
  selectedBranch,
}: ClassifySelectedBranchArgs): GitBranchRefClassification | null {
  if (!selectedBranch) {
    return null;
  }

  if (branches.includes(selectedBranch)) {
    return { name: selectedBranch, kind: "local" };
  }

  if (remoteBranches.includes(selectedBranch)) {
    return { name: selectedBranch, kind: "remote" };
  }

  return { name: selectedBranch, kind: "missing" };
}

export async function refreshRemoteBranches(
  cwd: string,
  options: GitProcessOptions,
  mode: RemoteRefreshMode,
): Promise<void> {
  const commonDir = await getGitCommonDir(cwd, options);
  const interactive = mode === "blocking";
  const existingState = remoteBranchFetchStateByCommonDir.get(commonDir);
  if (existingState?.inFlight) {
    await existingState.inFlight;
  }

  const settledState = remoteBranchFetchStateByCommonDir.get(commonDir);
  if (settledState?.inFlight) {
    await settledState.inFlight;
    return;
  }
  const throttled =
    settledState !== undefined &&
    Date.now() - settledState.fetchedAt < REMOTE_BRANCH_FETCH_THROTTLE_MS;
  if (throttled && !(interactive && settledState.needsInteractiveRetry)) {
    return;
  }

  const refreshDeadline = Date.now() + REMOTE_BRANCH_FETCH_TIMEOUT_MS;
  const inFlight = withGitRefMutationLock(
    commonDir,
    () => {
      const remainingTimeoutMs = Math.max(1, refreshDeadline - Date.now());
      return fetchRemoteBranches(cwd, {
        ...options,
        interactive,
        timeoutMs: remainingTimeoutMs,
      });
    },
    { timeoutMs: REMOTE_BRANCH_FETCH_TIMEOUT_MS },
  )
    .then(
      (result) => !interactive && result.status === "failed",
      () => false,
    )
    .then((needsInteractiveRetry) => {
      remoteBranchFetchStateByCommonDir.set(commonDir, {
        fetchedAt: Date.now(),
        inFlight: null,
        needsInteractiveRetry,
      });
    });

  remoteBranchFetchStateByCommonDir.set(commonDir, {
    fetchedAt: Date.now(),
    inFlight,
    needsInteractiveRetry: false,
  });

  await inFlight;
}

export async function readBranchOptions({
  path: cwd,
  limit,
  query,
  selectedBranch: requestedBranch,
  ...gitProcessOptions
}: ReadBranchOptionsArgs): Promise<GitBranchOptions> {
  const { branches, defaultBranch, originDefaultBranch, remoteBranches } =
    await listBranchRefsWithDefaults(cwd, gitProcessOptions, true);
  const limitedBranches = limitBranchList({
    branches: pinBranch({ branches, branch: defaultBranch }),
    limit,
    query,
  });
  const limitedRemoteBranches = limitBranchList({
    branches: pinBranch({
      branches: remoteBranches,
      branch: originDefaultBranch,
    }),
    limit,
    query,
  });
  return {
    branches: limitedBranches.branches,
    branchesTruncated: limitedBranches.truncated,
    remoteBranches: limitedRemoteBranches.branches,
    remoteBranchesTruncated: limitedRemoteBranches.truncated,
    selectedBranch: classifySelectedBranch({
      branches,
      remoteBranches,
      selectedBranch: requestedBranch,
    }),
  };
}

