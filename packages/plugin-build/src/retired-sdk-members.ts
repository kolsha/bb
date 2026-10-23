import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Metafile } from "esbuild";

const GIT_READS_REPLACEMENT: Readonly<Record<string, string>> = {
  status: 'bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "workspaceStatus", input: { environmentId, mergeBaseBranch } })',
  diff: 'bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "diff", input: { environmentId, target } })',
  diffFiles:
    'bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "files", input: { environmentId, target, ignoreWhitespace } })',
  diffPatch:
    'bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "patches", input: { keys } })',
  diffFile:
    'bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "fileSide", input: { environmentId, query } })',
  diffBranches:
    'bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "branches", input: { environmentId, query, limit } })',
};

const RETIRED_ENVIRONMENT_READ =
  /\benvironments\s*\.\s*(status|diff|diffFiles|diffPatch|diffFile|diffBranches)\s*\(/gu;

export function retiredSdkMemberWarnings(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(RETIRED_ENVIRONMENT_READ)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].map(
    (name) =>
      `environments.${name} is retired from the bb SDK typings and keeps working only for existing plugins. Read through the Git plugin instead: ${GIT_READS_REPLACEMENT[name]}. See bb-plugin-authoring, git-reads.md.`,
  );
}

export async function retiredSdkMemberWarningsForInputs(
  metafile: Metafile,
  absWorkingDir: string,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const input of Object.keys(metafile.inputs)) {
    if (input.startsWith("(") || input.includes(":")) continue;
    if (input.includes("node_modules")) continue;
    const path = resolve(absWorkingDir, input);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const warning of retiredSdkMemberWarnings(source)) {
      warnings.push(`${input}: ${warning}`);
    }
  }
  return warnings;
}
