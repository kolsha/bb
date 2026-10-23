import fs from "node:fs/promises";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import mimeTypes from "mime-types";
import type { GitFileContent } from "../contract.js";
import {
  readGitBlob,
  WorkspaceError,
} from "bb-git-host/git";

const IMAGE_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const NON_IMAGE_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

function isBinaryImageMimeType(mimeType: string | undefined): boolean {
  return Boolean(
    mimeType && mimeType.startsWith("image/") && mimeType !== "image/svg+xml",
  );
}

function encode(
  resultPath: string,
  contents: Buffer,
  sizeBytes: number,
  mimeType: string | undefined,
): GitFileContent {
  const base64 = isBinaryImageMimeType(mimeType) || !isUtf8(contents);
  return {
    path: resultPath,
    content: contents.toString(base64 ? "base64" : "utf8"),
    contentEncoding: base64 ? "base64" : "utf8",
    ...(mimeType === undefined ? {} : { mimeType }),
    sizeBytes,
  };
}

async function readWorkingTreeFile(
  root: string,
  absolutePath: string,
  limit: number,
): Promise<Buffer> {
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(root),
    fs.realpath(absolutePath),
  ]);
  const relative = path.relative(realRoot, realFile);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceError("invalid_path", "Path escapes the workspace");
  }
  const stat = await fs.stat(realFile);
  if (stat.size > limit) {
    throw new WorkspaceError(
      "file_too_large",
      `File size ${stat.size} bytes exceeds the ${Math.floor(limit / (1024 * 1024))} MB limit`,
    );
  }
  return fs.readFile(realFile);
}

export async function readFileSide(args: {
  root: string;
  relativePath: string;
  ref: string | null;
}): Promise<GitFileContent> {
  const relativePath = args.relativePath.replace(/^\/+/u, "");
  if (relativePath.length === 0 || relativePath.split("/").includes("..")) {
    throw new WorkspaceError("invalid_path", "Invalid path");
  }
  const absolutePath = path.join(args.root, ...relativePath.split("/"));
  const mimeType = mimeTypes.lookup(absolutePath) || undefined;
  const limit = isBinaryImageMimeType(mimeType)
    ? IMAGE_FILE_SIZE_LIMIT_BYTES
    : NON_IMAGE_FILE_SIZE_LIMIT_BYTES;
  if (args.ref === null) {
    const contents = await readWorkingTreeFile(args.root, absolutePath, limit);
    return encode(absolutePath, contents, contents.byteLength, mimeType);
  }
  const blob = await readGitBlob(args.root, args.ref, relativePath, limit);
  return blob.contents === null
    ? encode(absolutePath, Buffer.alloc(0), 0, mimeType)
    : encode(absolutePath, blob.contents, blob.sizeBytes, mimeType);
}
