import { pathExists } from "@bb/process-utils";
import {
  ensureGitRepo,
  getCurrentBranch,
  parsePorcelainV2StatusZ,
  readSharedGitRefsSnapshot,
  type SharedGitRefsSnapshot,
  revParse,
  runGit,
  type GitCommandResult,
  type GitProcessOptions,
  type RunGitOptions,
  WorkspaceError,
} from "bb-git-host/git";
import { withCheckoutMutationLock } from "./checkout-mutation-lock.js";

export interface LocalStateSnapshot {
  fingerprint: string;
  branchName: string | null;
}

export interface CommitOptions {
  message: string;
  noVerify: boolean;
}

export interface CommitResult {
  commitSha: string;
  commitSubject: string;
}

type WorkspaceMutationWork<T> = () => Promise<T>;

const WORKSPACE_STATUS_GIT_TIMEOUT_MS = 15_000;

function isMissingHeadRevisionError(stderr: string): boolean {
  return (
    stderr.includes("ambiguous argument 'HEAD'") ||
    stderr.includes("bad revision 'HEAD'") ||
    stderr.includes("unknown revision or path not in the working tree") ||
    stderr.includes("Needed a single revision")
  );
}

export class Workspace {
  readonly path: string;
  private readonly gitProcessOptions: GitProcessOptions;

  constructor(
    path: string,
    gitProcessOptions: GitProcessOptions = {},
    private readonly gitRepositoryKnown = false,
  ) {
    this.path = path;
    this.gitProcessOptions = { ...gitProcessOptions };
  }

  withMutation<T>(work: WorkspaceMutationWork<T>): Promise<T> {
    return withCheckoutMutationLock(
      this.path,
      work,
      undefined,
      this.gitProcessOptions,
    );
  }

  private runGit(
    args: string[],
    options: RunGitOptions,
  ): Promise<GitCommandResult> {
    return runGit(args, { ...options, ...this.gitProcessOptions });
  }

  get exists(): Promise<boolean> {
    return pathExists(this.path);
  }

  get currentBranch(): Promise<string | undefined> {
    return getCurrentBranch(this.path, this.gitProcessOptions);
  }

  async getLocalStateSnapshot(): Promise<LocalStateSnapshot> {
    if (!this.gitRepositoryKnown)
      await ensureGitRepo(this.path, {
        timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS,
        ...this.gitProcessOptions,
      });
    const status = await this.runGit(
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=normal",
      ],
      { cwd: this.path, timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS },
    );
    const { headOid, headBranch } = parsePorcelainV2StatusZ(status.stdout);
    return {
      fingerprint: JSON.stringify({ headSha: headOid, porcelain: status.stdout }),
      branchName: headBranch,
    };
  }

  getSharedGitRefsSnapshot(): Promise<SharedGitRefsSnapshot> {
    return readSharedGitRefsSnapshot(
      this.path,
      this.gitProcessOptions,
      this.gitRepositoryKnown,
    );
  }

  async getHeadSha(): Promise<string | null> {
    await ensureGitRepo(this.path, this.gitProcessOptions);

    const result = await this.runGit(["rev-parse", "HEAD"], {
      allowFailure: true,
      cwd: this.path,
    });
    if (result.exitCode === 0) {
      return result.stdout.trim() || null;
    }
    if (isMissingHeadRevisionError(result.stderr)) {
      return null;
    }
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse HEAD failed: ${result.stderr.trim()}`,
    );
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    await ensureGitRepo(this.path, this.gitProcessOptions);

    return this.withMutation(async () => {
      await this.runGit(["add", "-A"], { cwd: this.path });
      const staged = await this.runGit(["diff", "--cached", "--quiet"], {
        cwd: this.path,
        allowFailure: true,
      });
      if (staged.exitCode === 0) {
        throw new WorkspaceError("no_changes", "No changes to commit");
      }
      const commitArgs = ["commit", "-m", options.message];
      if (options.noVerify) {
        commitArgs.push("--no-verify");
      }
      await this.runGit(commitArgs, { cwd: this.path });
      const commitSha = await revParse(
        this.path,
        "HEAD",
        this.gitProcessOptions,
      );
      const commitSubject = (
        await this.runGit(["log", "-1", "--pretty=%s"], { cwd: this.path })
      ).stdout.trim();

      return { commitSha, commitSubject };
    });
  }

}
