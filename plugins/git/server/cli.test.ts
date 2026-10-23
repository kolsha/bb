import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { makeWorkspaceMergeBase, makeWorkspaceStatus } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";

type Environment = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["get"]>
>;

const ENVIRONMENT = {
  id: "env-1",
  name: null,
  projectId: "project-1",
  hostId: "host-1",
  path: "/work/env-1",
  isGitRepo: true,
  isWorktree: true,
  branchName: "feature",
  baseBranch: null,
  defaultBranch: "main",
  mergeBaseBranch: null,
  status: "ready",
  environmentProviderId: "git-worktree",
  lifecycle: { phase: "active", retireAt: null, teardown: null },
  hostLifecycle: "active",
  environmentProviderSelection: null,
  environmentProviderInstanceKey: null,
  managed: true,
  workspaceProvisionType: "worktree",
} as Environment;

function setup(
  host: (call: ExperimentalFakeHostRpcCall) => unknown,
  environment: Environment = ENVIRONMENT,
) {
  const viewedCalls: { method: string; args: unknown }[] = [];
  const fake = createFakePluginHost({
    pluginId: "bb--git",
    sdk: {
      environments: {
        get: async () => environment,
        experimental_diffViewed: async (args: unknown) => {
          viewedCalls.push({ method: "list", args });
          return { files: [{ path: "src/a.ts", revision: "rev-a" }] };
        },
        experimental_markDiffViewed: async (args: unknown) => {
          viewedCalls.push({ method: "mark", args });
          return { ok: true };
        },
        experimental_clearDiffViewed: async (args: unknown) => {
          viewedCalls.push({ method: "clear", args });
          return { ok: true };
        },
      },
    },
    experimental_callHostRpc: host,
  });
  plugin(fake.bb);
  return { fake, viewedCalls };
}

async function stdout(
  fake: ReturnType<typeof setup>["fake"],
  argv: string[],
): Promise<string[]> {
  const result = await fake.harness.runCli(argv);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout.split("\n");
}

const dirtyStatus = makeWorkspaceStatus({
  workingTree: {
    hasUncommittedChanges: true,
    state: "dirty_uncommitted",
    insertions: 4,
    deletions: 1,
    lineStatsComplete: true,
    fileCount: 1,
    files: [{ path: "README.md", status: "M", insertions: 4, deletions: 1 }],
  },
  mergeBase: makeWorkspaceMergeBase({
    aheadCount: 2,
    squashMergeCheckComplete: false,
  }),
});

describe("bb git", () => {
  it("prints status against the requested merge base and qualifies incomplete counts", async () => {
    const { fake } = setup(() => ({ outcome: "available", value: dirtyStatus }));
    const output = await stdout(fake, [
      "status",
      "env-1",
      "--merge-base-branch",
      "main",
    ]);
    expect(output).toEqual(
      expect.arrayContaining([
        "State: dirty_uncommitted",
        "Changed files: 1",
        "Insertions: +4",
        "Merge base: main",
        "Squash-merge check incomplete; counts may include already-merged commits.",
        "Ahead: 2",
      ]),
    );
    expect(fake.harness.experimental_hostRpcCalls).toMatchObject([
      { method: "status", input: { mergeBaseBranch: "main" } },
    ]);
  });

  it("does not print line totals that untracked files leave incomplete", async () => {
    const { fake } = setup(() => ({
      outcome: "available",
      value: makeWorkspaceStatus({
        workingTree: { ...dirtyStatus.workingTree, lineStatsComplete: false },
      }),
    }));
    const output = await stdout(fake, ["status", "env-1"]);
    expect(output).toContain("Line stats: unavailable for untracked files");
    expect(output.some((line) => line.startsWith("Insertions:"))).toBe(false);
  });

  it("explains non-git environments", async () => {
    const { fake } = setup(() => {
      throw new Error("non-git environments do not reach the host");
    }, { ...ENVIRONMENT, isGitRepo: false });
    expect(await stdout(fake, ["status", "env-1"])).toEqual([
      "Status unavailable: Workspace status is not available for non-git environments",
    ]);
  });

  it("lists local and remote branches with truncation", async () => {
    const { fake } = setup(() => ({
      branches: ["main", "release"],
      branchesTruncated: false,
      remoteBranches: ["origin/main"],
      remoteBranchesTruncated: true,
      selectedBranch: null,
    }));
    expect(
      await stdout(fake, ["branches", "env-1", "--query", "main", "--limit", "20"]),
    ).toEqual([
      "Local branches:",
      "  main",
      "  release",
      "Remote branches:",
      "  origin/main",
      "  (truncated)",
    ]);
    expect(fake.harness.experimental_hostRpcCalls).toMatchObject([
      { method: "branches", input: { query: "main", limit: 20 } },
    ]);
  });

  it("prints the diff summary, patch and truncation", async () => {
    const { fake } = setup(() => ({
      outcome: "available",
      value: {
        files: "M\tREADME.md\n",
        shortstat: "1 file changed, 3 insertions(+)",
        diff: "diff --git a/README.md b/README.md",
        truncated: true,
        mergeBaseRef: "abc123",
      },
    }));
    expect(
      await stdout(fake, [
        "diff",
        "env-1",
        "--target",
        "all",
        "--merge-base-branch",
        "main",
      ]),
    ).toEqual([
      "M\tREADME.md",
      "1 file changed, 3 insertions(+)",
      "diff --git a/README.md b/README.md",
      "(diff truncated)",
    ]);
    expect(fake.harness.experimental_hostRpcCalls).toMatchObject([
      { method: "diff", input: { target: { type: "all", mergeBaseBranch: "main" } } },
    ]);
  });

  it("prints patches with truncation and forwards whitespace mode", async () => {
    const { fake } = setup(() => ({
      outcome: "available",
      value: [
        { path: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new", truncated: false },
        { path: "src/b.ts", patch: "@@ -1 +1 @@", truncated: true },
      ],
    }));
    expect(
      await stdout(fake, [
        "patch",
        "env-1",
        "--target",
        "uncommitted",
        "--path",
        "src/a.ts",
        "--path",
        "src/b.ts",
        "--ignore-whitespace",
      ]),
    ).toEqual([
      "File: src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "File: src/b.ts",
      "@@ -1 +1 @@",
      "(patch truncated)",
    ]);
    expect(fake.harness.experimental_hostRpcCalls).toMatchObject([
      {
        method: "patches",
        input: { paths: ["src/a.ts", "src/b.ts"], ignoreWhitespace: true },
      },
    ]);
  });

  it("marks a file Viewed at its current revision", async () => {
    const { fake, viewedCalls } = setup(() => ({
      outcome: "available",
      value: {
        files: [
          {
            path: "src/a.ts",
            previousPath: null,
            changeKind: "modified",
            additions: 1,
            deletions: 1,
            binary: false,
            origin: "tracked",
            loadMode: "auto",
            revision: "100644:aaa:100644:bbb",
          },
        ],
        truncated: false,
        shortstat: "1 file changed",
        mergeBaseRef: null,
        initialPatches: [],
      },
    }));
    expect(
      await stdout(fake, [
        "viewed",
        "mark",
        "env-1",
        "--target",
        "uncommitted",
        "--path",
        "src/a.ts",
      ]),
    ).toEqual(["Viewed state updated."]);
    expect(viewedCalls).toEqual([
      {
        method: "mark",
        args: {
          environmentId: "env-1",
          target: { type: "uncommitted" },
          path: "src/a.ts",
          revision: "100644:aaa:100644:bbb",
        },
      },
    ]);
  });

  it("rejects a commit target without a SHA before reading git", async () => {
    const { fake } = setup(() => {
      throw new Error("should not read git");
    });
    const result = await fake.harness.runCli([
      "diff",
      "env-1",
      "--target",
      "commit",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "--sha is required when --target commit is used.",
    );
    expect(fake.harness.experimental_hostRpcCalls).toEqual([]);
  });
});
