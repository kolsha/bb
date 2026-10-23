export { provisionWorkspace } from "./provision.js";
export type { HostWorkspace, ProvisionWorkspaceArgs } from "./provision.js";

export type { LocalStateSnapshot } from "./workspace.js";
export { withGitRefMutationLock } from "bb-environment-provider-host/process-local-lock";
