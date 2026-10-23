import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useResizeObserver } from "usehooks-ts";
import {
  experimental_useFixedTabTarget as useFixedTabTarget,
  experimental_useRpcRefresh as useRpcRefresh,
  useBbNavigate,
  useSdk,
  type ExperimentalThreadFixedTabProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import type { DiffPresentation } from "@bb/shared-ui/git-diff/renderers";
import type { DiffFileEntry } from "../../contract.js";
import { environmentMergeBaseBranch } from "../../merge-base-branch.js";
import { GIT_DIFF_TAB_REFERENCE } from "../diff-tab-target.js";
import { useMergeBase } from "../merge-base.js";
import { useGitStatus, type GitStatusState } from "../queries.js";
import {
  DEFAULT_DIFF_FILE_FILTERS,
  diffExtensionCounts,
  filterDiffFiles,
} from "./diff-file-filters.js";
import { useDiffFiles, useDiffViewedRevisions } from "./diff-data.js";
import {
  summarizeDiffFileEntries,
  useDiffFilesCollapseControls,
} from "./diffFilesStore.js";
import {
  useGitDiffIgnoreWhitespacePreference,
  useGitDiffLineOverflowModePreference,
} from "./git-diff-view-preferences.js";
import { buildGitDiffIdentity } from "./gitDiffPanelHelpers.js";
import { GitDiffToolbar } from "./GitDiffToolbar.js";
import {
  GitDiffLoadingSkeleton,
  GitDiffNotApplicableNotice,
  GitDiffTabContent,
  GitDiffUnavailableNotice,
} from "./GitDiffTabContent.js";
import { DIFF_TOOLBAR_CHROME_CLASS } from "./panel-chrome.js";
import { useGitDiffPanelState } from "./useGitDiffPanelState.js";
import { useResponsiveGitDiffPanelDisplay } from "./useResponsiveGitDiffPanelDisplay.js";

const EMPTY_DIFF_FILES: readonly DiffFileEntry[] = [];

type DiffTabStatus =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "not_applicable"; message: string }
  | { kind: "eligible" };

function resolveDiffTabStatus(status: GitStatusState): DiffTabStatus {
  const { result } = status;
  if (result === undefined) {
    return status.errorMessage === null ? { kind: "loading" } : { kind: "error" };
  }
  if (result.outcome === "failed") return { kind: "error" };
  if (result.outcome === "not_applicable") {
    return { kind: "not_applicable", message: result.message };
  }
  return { kind: "eligible" };
}

type EnvironmentRecord = Awaited<
  ReturnType<ReturnType<typeof useSdk>["environments"]["get"]>
>;

function useEnvironmentRecord(environmentId: string): EnvironmentRecord | null {
  const sdk = useSdk();
  const [environment, setEnvironment] = useState<EnvironmentRecord | null>(
    null,
  );
  useEffect(() => {
    const controller = new AbortController();
    sdk.environments
      .get({ environmentId, signal: controller.signal })
      .then(setEnvironment, () => {});
    return () => controller.abort();
  }, [environmentId, sdk]);
  return environment?.id === environmentId ? environment : null;
}

export function DiffTab({
  environment,
  isOpen,
}: ExperimentalThreadFixedTabProps) {
  if (environment === null) return null;
  return (
    <EnvironmentDiffTab
      key={environment.id}
      environmentId={environment.id}
      isOpen={isOpen}
    />
  );
}

function EnvironmentDiffTab({
  environmentId,
  isOpen,
}: {
  environmentId: string;
  isOpen: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null!);
  const { width } = useResizeObserver({ ref: rootRef, box: "border-box" });
  const { gitDiffDisplayMode, handleGitDiffDisplayModeChange } =
    useResponsiveGitDiffPanelDisplay(width);
  const navigate = useBbNavigate();
  const { refresh } = useRpcRefresh();
  const status = useGitStatus(environmentId);
  const environment = useEnvironmentRecord(environmentId);
  const mergeBase = useMergeBase(environmentId, status.workspace, {
    loadOptions: isOpen,
  });
  const requestedMergeBaseBranch =
    mergeBase.effectiveMergeBaseBranch ??
    environmentMergeBaseBranch(environment);
  const tabTarget = useFixedTabTarget(GIT_DIFF_TAB_REFERENCE);
  const clearTabTarget = tabTarget?.clear;
  const clearPendingIntent = useCallback(() => {
    clearTabTarget?.();
  }, [clearTabTarget]);
  const pendingScrollPath =
    tabTarget?.target.kind === "file" ? tabTarget.target.path : null;
  const pendingCommitSha =
    tabTarget?.target.kind === "commit" ? tabTarget.target.sha : null;

  const openFileInEditor = useCallback(
    (path: string) => {
      navigate.experimental_openFileExternally({
        target: { kind: "workspace", environmentId, path },
        location: null,
      });
    },
    [environmentId, navigate],
  );
  const openFilePreview = useCallback(
    (path: string) => {
      navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId, path },
        location: null,
      });
    },
    [environmentId, navigate],
  );

  const {
    gitDiffFileFilter,
    gitDiffTarget,
    gitDiffSelectOptions,
    gitDiffSelectValue,
    onGitDiffSelectionChange,
    setGitDiffFileFilter,
  } = useGitDiffPanelState({
    requestedMergeBaseBranch,
    workspaceStatus: status.workspace,
    pendingScrollPath,
    pendingCommitSha,
    pendingSequence: tabTarget?.sequence ?? null,
    onClearPendingIntent: clearPendingIntent,
  });
  const tabStatus = resolveDiffTabStatus(status);
  const isEligible = tabStatus.kind === "eligible";
  const [gitDiffIgnoreWhitespace, setGitDiffIgnoreWhitespace] =
    useGitDiffIgnoreWhitespacePreference();
  const filesQuery = useDiffFiles({
    environmentId,
    target: isEligible ? gitDiffTarget : undefined,
    ignoreWhitespace: gitDiffIgnoreWhitespace,
    enabled: isOpen,
  });
  const diffFilesResponse = filesQuery.shown?.result;
  const shownTarget = filesQuery.shown?.target ?? gitDiffTarget;
  const shownIgnoreWhitespace =
    filesQuery.shown?.ignoreWhitespace ?? gitDiffIgnoreWhitespace;
  const isDiffFilesLoading = filesQuery.isLoading;
  const diffFiles =
    diffFilesResponse?.outcome === "available"
      ? diffFilesResponse.files
      : EMPTY_DIFF_FILES;
  const diffMergeBaseRef =
    diffFilesResponse?.outcome === "available"
      ? diffFilesResponse.mergeBaseRef
      : null;
  const isGitDiffTruncated =
    diffFilesResponse?.outcome === "available" && diffFilesResponse.truncated;
  const diffIdentity = useMemo(
    () =>
      buildGitDiffIdentity({
        environmentId,
        mergeBaseRef: diffMergeBaseRef,
        target: shownTarget,
      }),
    [diffMergeBaseRef, environmentId, shownTarget],
  );
  const [gitDiffFilters, setGitDiffFilters] = useState(
    DEFAULT_DIFF_FILE_FILTERS,
  );
  const diffPaths = useMemo(
    () => diffFiles.map((file) => file.path),
    [diffFiles],
  );
  const { viewedRevisionByPath } = useDiffViewedRevisions({
    environmentId,
    target: isEligible ? shownTarget : undefined,
    paths: diffPaths,
    enabled: isOpen,
  });
  const extensionCounts = useMemo(
    () => diffExtensionCounts(diffFiles),
    [diffFiles],
  );
  const filteredDiffFiles = useMemo(
    () =>
      filterDiffFiles(
        diffFiles,
        gitDiffFileFilter ?? "",
        gitDiffFilters,
        viewedRevisionByPath,
      ),
    [diffFiles, gitDiffFileFilter, gitDiffFilters, viewedRevisionByPath],
  );
  const gitDiffStats = useMemo(
    () => summarizeDiffFileEntries(filteredDiffFiles),
    [filteredDiffFiles],
  );
  const { areAllCollapsed, toggleAllCollapsed, hasFiles } =
    useDiffFilesCollapseControls(
      diffIdentity,
      filteredDiffFiles,
      diffFiles.length,
    );
  const [gitDiffLineOverflowMode, setGitDiffLineOverflowMode] =
    useGitDiffLineOverflowModePreference();
  const gitDiffPresentation = useMemo<DiffPresentation>(
    () => ({
      view: gitDiffDisplayMode,
      overflow: gitDiffLineOverflowMode,
      showLineNumbers: true,
    }),
    [gitDiffDisplayMode, gitDiffLineOverflowMode],
  );
  const statusFailure = status.failure;

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {isEligible ? (
        <div className={DIFF_TOOLBAR_CHROME_CLASS}>
          <GitDiffToolbar
            selectionValue={gitDiffSelectValue}
            selectionOptions={gitDiffSelectOptions}
            onSelectionChange={onGitDiffSelectionChange}
            isSelectorDisabled={
              isDiffFilesLoading || gitDiffTarget === undefined
            }
            stats={gitDiffStats}
            isStatsLoading={isDiffFilesLoading || gitDiffTarget === undefined}
            totalFilesCount={diffFiles.length}
            isTruncated={isGitDiffTruncated}
            fileFilter={gitDiffFileFilter}
            filters={gitDiffFilters}
            onFiltersChange={setGitDiffFilters}
            extensionCounts={extensionCounts}
            onFileFilterChange={setGitDiffFileFilter}
            areAllFilesCollapsed={areAllCollapsed}
            isCollapseAllDisabled={!hasFiles || isDiffFilesLoading}
            collapseAllDisabledReason={
              isDiffFilesLoading
                ? null
                : diffFiles.length === 0
                  ? "No changes"
                  : !hasFiles
                    ? "No files match filter"
                    : null
            }
            onToggleAllCollapsed={toggleAllCollapsed}
            displayMode={gitDiffDisplayMode}
            onDisplayModeChange={handleGitDiffDisplayModeChange}
            lineOverflowMode={gitDiffLineOverflowMode}
            onLineOverflowModeChange={setGitDiffLineOverflowMode}
            ignoreWhitespace={gitDiffIgnoreWhitespace}
            onIgnoreWhitespaceChange={setGitDiffIgnoreWhitespace}
          />
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {tabStatus.kind === "error" ? (
          <EmptyStatePanel className="m-4 rounded-lg" role="status">
            <div className="flex flex-col items-center gap-3 text-center">
              <span>Could not determine whether this workspace uses Git.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={refresh}
              >
                Retry
              </Button>
            </div>
          </EmptyStatePanel>
        ) : tabStatus.kind === "loading" ? (
          <GitDiffLoadingSkeleton />
        ) : tabStatus.kind === "not_applicable" ? (
          <GitDiffNotApplicableNotice message={tabStatus.message} />
        ) : gitDiffTarget === undefined && statusFailure !== undefined ? (
          <GitDiffUnavailableNotice message={statusFailure.message} />
        ) : (
          <GitDiffTabContent
            environmentId={environmentId}
            target={shownTarget}
            diffIdentity={diffIdentity}
            files={{
              result: diffFilesResponse,
              error: filesQuery.error,
              isLoading: isDiffFilesLoading,
            }}
            gitDiffPresentation={gitDiffPresentation}
            ignoreWhitespace={shownIgnoreWhitespace}
            isLive={isOpen}
            fileFilter={gitDiffFileFilter ?? ""}
            filters={gitDiffFilters}
            onClearPendingGitDiffIntent={clearPendingIntent}
            onOpenFileInEditor={openFileInEditor}
            onOpenFilePreview={openFilePreview}
            pendingGitDiffScrollPath={pendingScrollPath}
            workspaceRootPath={environment?.path ?? null}
          />
        )}
      </div>
    </div>
  );
}
