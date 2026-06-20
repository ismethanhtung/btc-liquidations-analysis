import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PATHNAME = "phatich5/live-paper-history.json";
const LOCAL_PATH = path.join(process.cwd(), "data", "live-paper-history.json");
const TMP_PATH = path.join(os.tmpdir(), "phatich5-live-paper-history.json");

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  const createdAt = nowIso();
  return {
    version: 1,
    createdAt,
    updatedAt: createdAt,
    runs: [],
    trades: [],
  };
}

function normalizeState(value) {
  const base = defaultState();
  const state = value && typeof value === "object" ? value : {};
  return {
    ...base,
    ...state,
    version: 1,
    runs: Array.isArray(state.runs) ? state.runs : [],
    trades: Array.isArray(state.trades) ? state.trades : [],
  };
}

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || "";
}

function blobPathname() {
  return process.env.LIVE_PAPER_BLOB_PATH || DEFAULT_PATHNAME;
}

function localPath() {
  return process.env.VERCEL ? TMP_PATH : LOCAL_PATH;
}

function storageKind() {
  if (blobToken()) return "blob";
  return process.env.VERCEL ? "tmp" : "local";
}

async function readBlobState() {
  const { get } = await import("@vercel/blob");
  const pathname = blobPathname();
  const result = await get(pathname, {
    access: "private",
    useCache: false,
    token: blobToken(),
  });
  if (!result || result.statusCode === 304 || !result.stream) return defaultState();
  const text = await new Response(result.stream).text();
  return normalizeState(JSON.parse(text));
}

async function writeBlobState(state) {
  const { put } = await import("@vercel/blob");
  const pathname = blobPathname();
  const blob = await put(pathname, JSON.stringify(state, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
    token: blobToken(),
  });
  return { kind: "blob", pathname, url: blob.url };
}

async function readFileState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return defaultState();
    throw error;
  }
}

async function writeFileState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return {
    kind: storageKind(),
    pathname: filePath,
    url: null,
    durable: storageKind() !== "tmp",
  };
}

export function getLivePaperStoreInfo() {
  const kind = storageKind();
  return {
    kind,
    durable: kind === "blob" || kind === "local",
    pathname: kind === "blob" ? blobPathname() : localPath(),
    warning: kind === "tmp"
      ? "BLOB_READ_WRITE_TOKEN is not set. Vercel will use /tmp storage, so history can disappear between function instances."
      : null,
  };
}

export async function readLivePaperState() {
  if (storageKind() === "blob") {
    return readBlobState();
  }
  return readFileState(localPath());
}

export async function writeLivePaperState(nextState) {
  const state = normalizeState({
    ...nextState,
    updatedAt: nowIso(),
  });
  if (storageKind() === "blob") {
    return writeBlobState(state);
  }
  return writeFileState(localPath(), state);
}
