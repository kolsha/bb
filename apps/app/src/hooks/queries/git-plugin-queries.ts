import { GIT_PLUGIN_ID, gitRpcContract } from "bb-plugin-bb--git/contract";
import { gitStatusErrorMessage } from "@bb/shared-ui/git-status-display";
import { experimental_useRpcKeyedQuery as useRpcKeyedQuery } from "@/lib/plugin-sdk-hooks";
import type {
  WorkspaceResolutionFailure,
  WorkspaceStatus,
} from "bb-git-contract";

export interface GitWorkspaceStatusState {
  workspace: WorkspaceStatus | undefined;
  failure: WorkspaceResolutionFailure | undefined;
  errorMessage: string | null;
}

export function useGitWorkspaceStatus(
  environmentId: string | null,
): GitWorkspaceStatusState {
  const query = useRpcKeyedQuery({
    pluginId: GIT_PLUGIN_ID,
    contract: gitRpcContract,
    method: "status",
    keys: environmentId === null ? [] : [environmentId],
    enabled: environmentId !== null,
  });
  const row = environmentId === null ? undefined : query.data?.[environmentId];
  return {
    workspace: row?.outcome === "available" ? row.workspace : undefined,
    failure: row?.outcome === "unavailable" ? row.failure : undefined,
    errorMessage:
      row?.outcome === "failed"
        ? row.message
        : gitStatusErrorMessage(query.error),
  };
}
