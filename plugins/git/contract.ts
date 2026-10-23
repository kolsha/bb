import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BRANCH_LIST_LIMIT_MAX,
  gitBranchNameSchema,
  gitBranchOptionsSchema,
  gitDiffFileChangeKindSchema,
  threadGitDiffResponseSchema,
  type WorkspaceDiffTarget,
  workspaceDiffTargetSchema,
  workspaceResolutionFailureSchema,
  workspaceStatusSchema,
} from "bb-git-contract";

export const GIT_PLUGIN_ID = "bb--git";
export const GIT_DIFF_TAB_ID = "diff";
export const GIT_STATUS_MAX_KEYS = 200;
export const GIT_PATCHES_MAX_KEYS = 50;
export const GIT_VIEWED_MAX_PATHS = 500;
export const GIT_DIFF_MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const GIT_DIFF_MAX_FILE_LIST_BYTES = 256 * 1024;

export function gitStatusTag(environmentId: string): string {
  return `status:${environmentId}`;
}

export function gitFilesTag(environmentId: string): string {
  return `files:${environmentId}`;
}

export function gitRefsTag(environmentId: string): string {
  return `refs:${environmentId}`;
}

export function gitViewedTag(environmentId: string): string {
  return `viewed:${environmentId}`;
}

const notApplicableSchema = z
  .object({
    outcome: z.literal("not_applicable"),
    reason: z.literal("non_git_environment"),
    message: z.string().min(1),
  })
  .strict();

const unavailableSchema = z
  .object({
    outcome: z.literal("unavailable"),
    failure: workspaceResolutionFailureSchema,
  })
  .strict();

export const gitStatusResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("available"), workspace: workspaceStatusSchema })
    .strict(),
  notApplicableSchema,
  unavailableSchema,
]);
export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;

export const gitStatusRowSchema = z.discriminatedUnion("outcome", [
  ...gitStatusResultSchema.options,
  z
    .object({ outcome: z.literal("failed"), message: z.string().min(1) })
    .strict(),
]);
export type GitStatusRow = z.infer<typeof gitStatusRowSchema>;

export const gitDiffResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("available"), diff: threadGitDiffResponseSchema })
    .strict(),
  notApplicableSchema,
  unavailableSchema,
]);
export type GitDiffResult = z.infer<typeof gitDiffResultSchema>;

export const diffFileEntrySchema = z
  .object({
    path: z.string(),
    previousPath: z.string().nullable(),
    changeKind: gitDiffFileChangeKindSchema,
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
    origin: z.enum(["tracked", "untracked"]),
    loadMode: z.enum(["auto", "on_demand", "too_large"]),
    revision: z.string().min(1),
  })
  .strict();
export type DiffFileEntry = z.infer<typeof diffFileEntrySchema>;

export const diffPatchEntrySchema = z
  .object({
    path: z.string(),
    patch: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type DiffPatchEntry = z.infer<typeof diffPatchEntrySchema>;

export const gitFilesResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      files: z.array(diffFileEntrySchema),
      truncated: z.boolean(),
      shortstat: z.string(),
      mergeBaseRef: z.string().nullable(),
      initialPatches: z.array(diffPatchEntrySchema),
    })
    .strict(),
  notApplicableSchema,
  unavailableSchema,
]);
export type GitFilesResult = z.infer<typeof gitFilesResultSchema>;

export const gitPatchResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("available"), patch: diffPatchEntrySchema })
    .strict(),
  notApplicableSchema,
  unavailableSchema,
]);
export type GitPatchResult = z.infer<typeof gitPatchResultSchema>;

export const gitPatchKeySchema = z
  .object({
    environmentId: z.string().min(1),
    target: workspaceDiffTargetSchema,
    ignoreWhitespace: z.boolean(),
    path: z.string().min(1),
    revision: z.string().min(1),
  })
  .strict();
export type GitPatchKey = z.infer<typeof gitPatchKeySchema>;

export function gitPatchKey(key: GitPatchKey): string {
  return JSON.stringify([
    key.environmentId,
    key.target,
    key.ignoreWhitespace,
    key.path,
    key.revision,
  ]);
}

const patchKeyTupleSchema = z.tuple([
  z.string().min(1),
  workspaceDiffTargetSchema,
  z.boolean(),
  z.string().min(1),
  z.string().min(1),
]);

export function parseGitPatchKey(key: string): GitPatchKey | null {
  let raw: unknown;
  try {
    raw = JSON.parse(key);
  } catch {
    return null;
  }
  const parsed = patchKeyTupleSchema.safeParse(raw);
  if (!parsed.success) return null;
  const [environmentId, target, ignoreWhitespace, path, revision] = parsed.data;
  return { environmentId, target, ignoreWhitespace, path, revision };
}

export const gitDiffTabTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string().min(1) }).strict(),
]);
export type GitDiffTabTarget = z.infer<typeof gitDiffTabTargetSchema>;

const diffFileSideSchema = z.enum(["old", "new"]);
const objectIdSchema = z.string().regex(/^[0-9a-f]{4,40}$/iu);

export const gitFileSideQuerySchema = z.discriminatedUnion("target", [
  z
    .object({
      target: z.literal("uncommitted"),
      path: z.string().min(1),
      side: diffFileSideSchema,
    })
    .strict(),
  z
    .object({
      target: z.literal("branch_committed"),
      mergeBaseRef: objectIdSchema,
      path: z.string().min(1),
      side: diffFileSideSchema,
    })
    .strict(),
  z
    .object({
      target: z.literal("all"),
      mergeBaseRef: objectIdSchema,
      path: z.string().min(1),
      side: diffFileSideSchema,
    })
    .strict(),
  z
    .object({
      target: z.literal("commit"),
      sha: objectIdSchema,
      path: z.string().min(1),
      side: diffFileSideSchema,
    })
    .strict(),
]);
export type GitFileSideQuery = z.infer<typeof gitFileSideQuerySchema>;

export const gitFileContentSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    contentEncoding: z.enum(["base64", "utf8"]),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type GitFileContent = z.infer<typeof gitFileContentSchema>;

export const diffViewedFileSchema = z
  .object({ path: z.string().min(1), revision: z.string().min(1) })
  .strict();
export type DiffViewedFile = z.infer<typeof diffViewedFileSchema>;

const environmentInputSchema = z
  .object({ environmentId: z.string().min(1) })
  .strict();

export const gitDiffQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommitted") }).strict(),
  z
    .object({
      type: z.literal("branch_committed"),
      mergeBaseBranch: gitBranchNameSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("all"), mergeBaseBranch: gitBranchNameSchema })
    .strict(),
  z.object({ type: z.literal("commit"), sha: objectIdSchema }).strict(),
]);

export function diffViewedTargetKey(target: WorkspaceDiffTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "uncommitted";
    case "branch_committed":
    case "all":
      return `${target.type}:${target.mergeBaseBranch}`;
    case "commit":
      return `commit:${target.sha.toLowerCase()}`;
  }
}

export const gitRpcContract = defineRpcContract({
  status: {
    experimental_description:
      "Git status of each environment's workspace, keyed by environment id. Branch comparison uses the environment's merge base.",
    input: z
      .object({
        keys: z.array(z.string().min(1)).min(1).max(GIT_STATUS_MAX_KEYS),
      })
      .strict(),
    output: z.record(z.string(), gitStatusRowSchema),
    keyTags: (key) => [gitStatusTag(key)],
  },
  workspaceStatus: {
    experimental_description:
      "Git status of one environment's workspace, compared with mergeBaseBranch when given.",
    input: environmentInputSchema
      .extend({ mergeBaseBranch: gitBranchNameSchema.optional() })
      .strict(),
    output: gitStatusResultSchema,
    tags: ({ environmentId }) => [gitStatusTag(environmentId)],
  },
  diff: {
    experimental_description:
      "The unified diff, file list and shortstat for one environment and target.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        maxDiffBytes: z.number().int().min(1).max(GIT_DIFF_MAX_DIFF_BYTES).optional(),
        maxFileListBytes: z
          .number()
          .int()
          .min(1)
          .max(GIT_DIFF_MAX_FILE_LIST_BYTES)
          .optional(),
      })
      .strict(),
    output: gitDiffResultSchema,
    tags: ({ environmentId }) => [gitFilesTag(environmentId)],
  },
  files: {
    experimental_description:
      "Changed files with per-file line counts for one environment and target, with patches for small files.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        ignoreWhitespace: z.boolean(),
      })
      .strict(),
    output: gitFilesResultSchema,
    tags: ({ environmentId }) => [gitFilesTag(environmentId)],
  },
  patches: {
    experimental_description:
      "One file's patch per key. Build keys with the contract's gitPatchKey from a files entry's path and revision.",
    input: z
      .object({
        keys: z.array(z.string().min(1)).min(1).max(GIT_PATCHES_MAX_KEYS),
      })
      .strict(),
    output: z.record(z.string(), gitPatchResultSchema),
    keyTags: () => [],
  },
  fileSide: {
    experimental_description:
      "The old or new side of one changed file, for expanding diff context.",
    input: environmentInputSchema
      .extend({ query: gitFileSideQuerySchema })
      .strict(),
    output: gitFileContentSchema,
  },
  branches: {
    experimental_description:
      "Local and remote branches to compare an environment against.",
    input: environmentInputSchema
      .extend({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(BRANCH_LIST_LIMIT_MAX).optional(),
        selectedBranch: gitBranchNameSchema.optional(),
      })
      .strict(),
    output: gitBranchOptionsSchema,
    tags: ({ environmentId }) => [gitRefsTag(environmentId)],
  },
  viewed: {
    experimental_description:
      "Files marked Viewed for an environment and diff target.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        paths: z
          .array(z.string().min(1).max(4096))
          .max(GIT_VIEWED_MAX_PATHS)
          .optional(),
      })
      .strict(),
    output: z.object({ files: z.array(diffViewedFileSchema) }).strict(),
    tags: ({ environmentId }) => [gitViewedTag(environmentId)],
  },
  markViewed: {
    experimental_description:
      "Mark a file Viewed at a revision returned by files.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        path: z.string().min(1).max(4096),
        revision: z.string().min(1).max(1024),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
    invalidates: ({ environmentId }) => [gitViewedTag(environmentId)],
  },
  clearViewed: {
    experimental_description:
      "Clear one file's Viewed mark, or every mark for the target.",
    input: environmentInputSchema
      .extend({
        target: gitDiffQuerySchema,
        path: z.string().min(1).max(4096).optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
    invalidates: ({ environmentId }) => [gitViewedTag(environmentId)],
  },
  setMergeBase: {
    experimental_description:
      "Compare an environment against a branch, or null for its default.",
    input: environmentInputSchema
      .extend({ mergeBaseBranch: gitBranchNameSchema.nullable() })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
    invalidates: ({ environmentId }) => [
      gitStatusTag(environmentId),
      gitFilesTag(environmentId),
    ],
  },
  refresh: {
    experimental_description:
      "Drop an environment's cached git reads and refresh every view of them, for example after a commit.",
    input: environmentInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export const hostReadResultSchema = <T extends z.ZodType>(available: T) =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("available"), value: available }).strict(),
    unavailableSchema,
  ]);

const hostPathSchema = z.object({ path: z.string().min(1) }).strict();

const hostReadFreshnessSchema = z
  .object({ work: z.string().min(1), refs: z.string().min(1) })
  .strict();

export type GitReadFreshness = z.infer<typeof hostReadFreshnessSchema>;

const fileSideHostResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), value: gitFileContentSchema }).strict(),
  z
    .object({
      outcome: z.literal("refused"),
      code: z.enum(["not_found", "invalid"]),
      message: z.string(),
    })
    .strict(),
]);

export const gitHostContract = defineRpcContract({
  status: {
    experimental_retryable: true,
    input: hostPathSchema
      .extend({
        freshness: hostReadFreshnessSchema,
        mergeBaseBranch: gitBranchNameSchema.optional(),
      })
      .strict(),
    output: hostReadResultSchema(workspaceStatusSchema),
  },
  diff: {
    experimental_retryable: true,
    input: hostPathSchema
      .extend({
        target: workspaceDiffTargetSchema,
        maxDiffBytes: z.number().int().min(1).max(GIT_DIFF_MAX_DIFF_BYTES),
        maxFileListBytes: z
          .number()
          .int()
          .min(1)
          .max(GIT_DIFF_MAX_FILE_LIST_BYTES),
      })
      .strict(),
    output: hostReadResultSchema(threadGitDiffResponseSchema),
  },
  files: {
    experimental_retryable: true,
    input: hostPathSchema
      .extend({
        freshness: hostReadFreshnessSchema,
        target: workspaceDiffTargetSchema,
        ignoreWhitespace: z.boolean(),
      })
      .strict(),
    output: hostReadResultSchema(
      z
        .object({
          files: z.array(diffFileEntrySchema),
          truncated: z.boolean(),
          shortstat: z.string(),
          mergeBaseRef: z.string().nullable(),
          initialPatches: z.array(diffPatchEntrySchema),
        })
        .strict(),
    ),
  },
  patches: {
    experimental_retryable: true,
    input: hostPathSchema
      .extend({
        freshness: hostReadFreshnessSchema,
        target: workspaceDiffTargetSchema,
        ignoreWhitespace: z.boolean(),
        paths: z.array(z.string().min(1)).min(1).max(GIT_PATCHES_MAX_KEYS),
      })
      .strict(),
    output: hostReadResultSchema(z.array(diffPatchEntrySchema)),
  },
  fileSide: {
    experimental_retryable: true,
    input: hostPathSchema
      .extend({
        relativePath: z.string().min(1),
        ref: z.string().min(1).nullable(),
      })
      .strict(),
    output: fileSideHostResultSchema,
  },
  branches: {
    experimental_retryable: true,
    input: hostPathSchema
      .extend({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(BRANCH_LIST_LIMIT_MAX),
        selectedBranch: gitBranchNameSchema.optional(),
      })
      .strict(),
    output: gitBranchOptionsSchema,
  },
});
