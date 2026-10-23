import { useCallback, useSyncExternalStore } from "react";
import type { CodeOverflowMode } from "@get-bb/plugin-sdk";

export type GitDiffDisplayMode = "unified" | "split";
export type GitDiffDisplayModeChangeHandler = (
  mode: GitDiffDisplayMode,
) => void;
export type CodeOverflowModeChangeHandler = (mode: CodeOverflowMode) => void;

export const DEFAULT_CODE_OVERFLOW_MODE: CodeOverflowMode = "scroll";

export const GIT_DIFF_DISPLAY_MODE_STORAGE_KEY =
  "bb.thread.gitDiff.displayMode";
export const GIT_DIFF_LINE_OVERFLOW_MODE_STORAGE_KEY =
  "bb.thread.gitDiff.lineOverflowMode";
export const GIT_DIFF_IGNORE_WHITESPACE_STORAGE_KEY =
  "bb.thread.gitDiff.ignoreWhitespace";

const listenersByKey = new Map<string, Set<() => void>>();

function readStoredString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredString(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    return;
  }
  for (const listener of listenersByKey.get(key) ?? []) listener();
}

function subscribeToKey(key: string, listener: () => void): () => void {
  let listeners = listenersByKey.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === key) listener();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function useStoredString(
  key: string,
): [string | null, (value: string | null) => void] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToKey(key, listener),
    [key],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => readStoredString(key),
    () => null,
  );
  const setValue = useCallback(
    (next: string | null) => writeStoredString(key, next),
    [key],
  );
  return [value, setValue];
}

function isGitDiffDisplayMode(value: string): value is GitDiffDisplayMode {
  return value === "unified" || value === "split";
}

function isCodeOverflowMode(value: string): value is CodeOverflowMode {
  return value === "wrap" || value === "scroll";
}

export function useGitDiffDisplayModePreference(): [
  GitDiffDisplayMode | null,
  (mode: GitDiffDisplayMode | null) => void,
] {
  const [stored, setStored] = useStoredString(
    GIT_DIFF_DISPLAY_MODE_STORAGE_KEY,
  );
  return [
    stored !== null && isGitDiffDisplayMode(stored) ? stored : null,
    setStored,
  ];
}

export function useGitDiffLineOverflowModePreference(): [
  CodeOverflowMode,
  CodeOverflowModeChangeHandler,
] {
  const [stored, setStored] = useStoredString(
    GIT_DIFF_LINE_OVERFLOW_MODE_STORAGE_KEY,
  );
  return [
    stored !== null && isCodeOverflowMode(stored)
      ? stored
      : DEFAULT_CODE_OVERFLOW_MODE,
    setStored,
  ];
}

export function useGitDiffIgnoreWhitespacePreference(): [
  boolean,
  (ignoreWhitespace: boolean) => void,
] {
  const [stored, setStored] = useStoredString(
    GIT_DIFF_IGNORE_WHITESPACE_STORAGE_KEY,
  );
  const setIgnoreWhitespace = useCallback(
    (ignoreWhitespace: boolean) => setStored(JSON.stringify(ignoreWhitespace)),
    [setStored],
  );
  return [stored === "true", setIgnoreWhitespace];
}
