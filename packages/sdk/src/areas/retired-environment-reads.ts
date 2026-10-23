import { z } from "zod";
import {
  jsonValueSchema,
} from "@bb/domain";
import type { BbSdkTransport } from "../transport.js";
import type {
  WorkspaceDiffTarget,
} from "bb-git-contract";

const GIT_PLUGIN_ID = "bb--git";

type DiffTargetArgs =
  | { target: "uncommitted" }
  | { target: "branch_committed" | "all"; mergeBaseBranch: string }
  | { target: "commit"; sha: string };

type EnvironmentReadArgs = { environmentId: string; signal?: AbortSignal };

type RetiredDiffFileArgs = EnvironmentReadArgs & { path: string; side: "old" | "new" } & (
    | { target: "uncommitted" }
    | { target: "branch_committed" | "all"; mergeBaseRef: string }
    | { target: "commit"; sha: string }
  );

const rpcEnvelopeSchema = z.object({ ok: z.literal(true), result: jsonValueSchema });
const recordSchema = z.record(z.string(), jsonValueSchema);
const patchRowSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), patch: jsonValueSchema }),
  z.object({ outcome: z.literal("not_applicable") }).passthrough(),
  z.object({ outcome: z.literal("unavailable") }).passthrough(),
]);

function toWorkspaceDiffTarget(args: DiffTargetArgs): WorkspaceDiffTarget {
  switch (args.target) {
    case "uncommitted":
      return { type: "uncommitted" };
    case "branch_committed":
    case "all":
      return { type: args.target, mergeBaseBranch: args.mergeBaseBranch };
    case "commit":
      return { type: "commit", sha: args.sha };
  }
}

function patchKey(
  environmentId: string,
  target: WorkspaceDiffTarget,
  ignoreWhitespace: boolean,
  path: string,
): string {
  return JSON.stringify([environmentId, target, ignoreWhitespace, path, "current"]);
}

export function createRetiredEnvironmentReads(transport: BbSdkTransport) {
  async function callGit(
    method: string,
    input: unknown,
    signal: AbortSignal | undefined,
  ) {
    const path = `/api/v1/plugins/${GIT_PLUGIN_ID}/rpc/${method}`;
    const url = transport.baseUrl
      ? `${transport.baseUrl.replace(/\/$/u, "")}${path}`
      : path;
    const response = await transport.resolve(
      transport.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    return rpcEnvelopeSchema.parse(await response.json()).result;
  }

  return {
    status(args: EnvironmentReadArgs & { mergeBaseBranch?: string }) {
      return callGit(
        "workspaceStatus",
        {
          environmentId: args.environmentId,
          ...(args.mergeBaseBranch === undefined
            ? {}
            : { mergeBaseBranch: args.mergeBaseBranch }),
        },
        args.signal,
      );
    },
    diff(args: EnvironmentReadArgs & DiffTargetArgs) {
      return callGit(
        "diff",
        { environmentId: args.environmentId, target: toWorkspaceDiffTarget(args) },
        args.signal,
      );
    },
    diffFiles(
      args: EnvironmentReadArgs & DiffTargetArgs & { ignoreWhitespace?: boolean },
    ) {
      return callGit(
        "files",
        {
          environmentId: args.environmentId,
          target: toWorkspaceDiffTarget(args),
          ignoreWhitespace: args.ignoreWhitespace === true,
        },
        args.signal,
      );
    },
    async diffPatch(
      args: EnvironmentReadArgs & {
        target: WorkspaceDiffTarget;
        paths: string[];
        ignoreWhitespace?: boolean;
      },
    ) {
      const ignoreWhitespace = args.ignoreWhitespace === true;
      const keys = args.paths.map((path) =>
        patchKey(args.environmentId, args.target, ignoreWhitespace, path),
      );
      const rows = recordSchema.parse(
        await callGit("patches", { keys }, args.signal),
      );
      const patches = [];
      for (const key of keys) {
        const row = rows[key];
        if (row === undefined) continue;
        const parsed = patchRowSchema.parse(row);
        if (parsed.outcome !== "available") return row;
        patches.push(parsed.patch);
      }
      return { outcome: "available", patches };
    },
    diffFile(args: RetiredDiffFileArgs) {
      const { environmentId, signal, ...query } = args;
      return callGit("fileSide", { environmentId, query }, signal);
    },
    diffBranches(
      args: EnvironmentReadArgs & {
        query?: string;
        limit?: string;
        selectedBranch?: string;
      },
    ) {
      return callGit(
        "branches",
        {
          environmentId: args.environmentId,
          ...(args.query === undefined || args.query.trim() === ""
            ? {}
            : { query: args.query.trim() }),
          ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
          ...(args.selectedBranch === undefined
            ? {}
            : { selectedBranch: args.selectedBranch }),
        },
        args.signal,
      );
    },
  };
}
