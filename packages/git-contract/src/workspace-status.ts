import { z } from "zod";
import { gitCheckoutRefSchema } from "./git-checkout.js";

const workspaceStateValues = [
  "clean",
  "untracked",
  "dirty_uncommitted",
  "committed_unmerged",
  "dirty_and_committed_unmerged",
] as const;
const workspaceStateSchema = z.enum(workspaceStateValues);

const workspaceFileStatusKindSchema = z.enum([
  "M",
  "A",
  "D",
  "R",
  "C",
  "U",
  "??",
  "?",
]);
export type WorkspaceFileStatusKind = z.infer<
  typeof workspaceFileStatusKindSchema
>;

const workspaceFileStatusSchema = z.object({
  path: z.string(),
  status: workspaceFileStatusKindSchema,
  insertions: z.number().nullable(),
  deletions: z.number().nullable(),
});
export type WorkspaceFileStatus = z.infer<typeof workspaceFileStatusSchema>;

const workspaceCommitSummarySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authoredAt: z.number(),
});
export type WorkspaceCommitSummary = z.infer<
  typeof workspaceCommitSummarySchema
>;

const workspaceChangeStatsSchema = z.object({
  insertions: z.number(),
  deletions: z.number(),
  lineStatsComplete: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  files: z.array(workspaceFileStatusSchema),
});
export type WorkspaceChangeStats = z.infer<typeof workspaceChangeStatsSchema>;

const workspaceWorkingTreeSchema = workspaceChangeStatsSchema.extend({
  hasUncommittedChanges: z.boolean(),
  state: workspaceStateSchema,
});
export type WorkspaceWorkingTree = z.infer<typeof workspaceWorkingTreeSchema>;

const workspaceBranchSchema = z.object({
  currentBranch: z.string().nullable(),
  defaultBranch: z.string(),
});

const workspaceMergeBaseSchema = workspaceChangeStatsSchema.extend({
  mergeBaseBranch: z.string(),
  baseRef: z.string().nullable(),
  aheadCount: z.number(),
  behindCount: z.number(),
  squashMergeCheckComplete: z.boolean(),
  hasCommittedUnmergedChanges: z.boolean(),
  commits: z.array(workspaceCommitSummarySchema),
});
export type WorkspaceMergeBase = z.infer<typeof workspaceMergeBaseSchema>;

export const workspaceStatusSchema = z.object({
  workingTree: workspaceWorkingTreeSchema,
  checkout: gitCheckoutRefSchema,
  branch: workspaceBranchSchema,
  mergeBase: workspaceMergeBaseSchema.nullable(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;
