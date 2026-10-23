export function environmentMergeBaseBranch(
  environment: {
    mergeBaseBranch: string | null;
    baseBranch: string | null;
    defaultBranch: string | null;
  } | null,
): string | undefined {
  return (
    environment?.mergeBaseBranch ??
    environment?.baseBranch ??
    environment?.defaultBranch ??
    undefined
  );
}
