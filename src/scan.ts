/**
 * One walk of the library produces a flat cached file list plus a directory
 * tree. Everything downstream (policy, preview, dedupe, budget) reads that
 * cache, so moving a slider never re-touches the disk.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CONVERT_EXTS, RAW_EXTS, VIDEO_EXTS, JUNK_EXTS, extOf } from "./paths.ts";

export type Category = "image" | "raw" | "video" | "other";

export type ScannedFile = {
  /** Absolute path on disk. */
  abs: string;
  /** Path relative to the scan root, using the platform separator. Drives the output mirror. */
  rel: string;
  dir: string;
  name: string;
  ext: string;
  size: number;
  category: Category;
  mtime: number;
};

export type TreeNode = {
  name: string;
  rel: string;
  path: string;
  depth: number;
  children: TreeNode[];
  files: ScannedFile[];
  count: number;
  bytes: number;
  imageCount: number;
  imageBytes: number;
  rawCount: number;
  rawBytes: number;
  videoCount: number;
  videoBytes: number;
  otherCount: number;
  otherBytes: number;
};

export type ScanResult = {
  root: string;
  scannedAt: number;
  durationMs: number;
  tree: TreeNode;
  files: ScannedFile[];
  totals: {
    count: number;
    bytes: number;
    imageCount: number;
    imageBytes: number;
    rawCount: number;
    rawBytes: number;
    videoCount: number;
    videoBytes: number;
    otherCount: number;
    otherBytes: number;
  };
  /** Folders that exist but hold nothing convertible. Surfaced in the UI so the user can prune them. */
  deadFolders: string[];
  /** Folder names that will bite the user: look-alike slashes, invisible chars, mixed scripts. */
  riskyNames: { rel: string; reason: string }[];
  skipped: { path: string; reason: string }[];
};

function categorise(ext: string): Category {
  if ((CONVERT_EXTS as readonly string[]).includes(ext)) return "image";
  if ((RAW_EXTS as readonly string[]).includes(ext)) return "raw";
  if ((VIDEO_EXTS as readonly string[]).includes(ext)) return "video";
  return "other";
}

function blankNode(name: string, rel: string, nodePath: string, depth: number): TreeNode {
  return {
    name, rel, path: nodePath, depth, children: [], files: [],
    count: 0, bytes: 0,
    imageCount: 0, imageBytes: 0, rawCount: 0, rawBytes: 0,
    videoCount: 0, videoBytes: 0, otherCount: 0, otherBytes: 0,
  };
}

function addToNode(node: TreeNode, f: ScannedFile): void {
  node.files.push(f);
  node.count++;
  node.bytes += f.size;
  switch (f.category) {
    case "image":
      node.imageCount++; node.imageBytes += f.size; break;
    case "raw":
      node.rawCount++; node.rawBytes += f.size; break;
    case "video":
      node.videoCount++; node.videoBytes += f.size; break;
    case "other":
      node.otherCount++; node.otherBytes += f.size; break;
  }
}

/** Roll child counts up into the parent. Own-file counts are already set. */
function rollup(node: TreeNode): void {
  for (const child of node.children) rollup(child);
  for (const child of node.children) {
    node.count += child.count;
    node.bytes += child.bytes;
    node.imageCount += child.imageCount; node.imageBytes += child.imageBytes;
    node.rawCount += child.rawCount; node.rawBytes += child.rawBytes;
    node.videoCount += child.videoCount; node.videoBytes += child.videoBytes;
    node.otherCount += child.otherCount; node.otherBytes += child.otherBytes;
  }
}

const IGNORED_DIRS = new Set([
  "$recycle.bin", "system volume information", "node_modules", ".git",
  "avif", "avif-q80", "avif-q60", "avif-quality-tests",
]);

/**
 * Never scan the toolchain or the app's own folder - neither holds photos.
 * The folder name has been spelled a few ways over time, so match loosely.
 */
const IGNORED_PATTERNS = [
  /^image[_-]?magick/i,
  /^ffmpeg$/i,
  /^picmag\w*-gui$/i,
  /^compakta$/i,
  /^\.[^.]/,          // dot-folders: .stfolder, .git, .cache, .thumbnails
  /^\$/,              // Windows system dirs
];

const isIgnoredDir = (name: string) =>
  IGNORED_DIRS.has(name.toLowerCase()) || IGNORED_PATTERNS.some((re) => re.test(name));

export async function scanLibrary(
  root: string,
  opts: { maxDepth?: number } = {},
): Promise<ScanResult> {
  const started = Date.now();
  const maxDepth = opts.maxDepth ?? 24;
  const absRoot = path.resolve(root);
  const files: ScannedFile[] = [];
  const skipped: { path: string; reason: string }[] = [];

  async function walk(dirAbs: string, node: TreeNode, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dirAbs, reason: (err as Error).message });
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const childAbs = path.join(dirAbs, name);

      if (entry.isSymbolicLink()) {
        // Following links risks cycles; a photo library has no legitimate use for them here.
        skipped.push({ path: childAbs, reason: "symlink" });
        continue;
      }

      if (entry.isDirectory()) {
        if (isIgnoredDir(name)) continue;
        const relChild = path.relative(absRoot, childAbs);
        const child = blankNode(name, relChild, childAbs, depth + 1);
        node.children.push(child);
        await walk(childAbs, child, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = extOf(name);
      let st;
      try {
        st = await stat(childAbs);
      } catch {
        continue; // vanished mid-scan; harmless
      }
      if (!st.isFile()) continue;

      const f: ScannedFile = {
        abs: childAbs,
        rel: path.relative(absRoot, childAbs),
        dir: path.dirname(path.relative(absRoot, childAbs)),
        name,
        ext,
        size: st.size,
        category: categorise(ext),
        mtime: st.mtimeMs,
      };
      files.push(f);
      addToNode(node, f);
    }
  }

  const rootNode = blankNode(path.basename(absRoot), "", absRoot, 0);
  await walk(absRoot, rootNode, 0);
  rollup(rootNode);

  // Files sitting directly in the root never got attached via a child node,
  // but addToNode already credited rootNode for them, so totals are correct.

  const deadFolders: string[] = [];
  (function prune(node: TreeNode) {
    for (const child of node.children) {
      prune(child);
      if (child.imageCount === 0 && child.rawCount === 0 && child.videoCount === 0) {
        deadFolders.push(child.rel);
      }
    }
  })(rootNode);

  const totals = {
    count: rootNode.count,
    bytes: rootNode.bytes,
    imageCount: rootNode.imageCount,
    imageBytes: rootNode.imageBytes,
    rawCount: rootNode.rawCount,
    rawBytes: rootNode.rawBytes,
    videoCount: rootNode.videoCount,
    videoBytes: rootNode.videoBytes,
    otherCount: rootNode.otherCount,
    otherBytes: rootNode.otherBytes,
  };

  const riskyNames: { rel: string; reason: string }[] = [];
  (function checkNames(node: TreeNode) {
    if (node.rel) {
      const n = node.name;
      if (/[\u2044\u2215\u29F5\u29F8\uFF0F]/.test(n)) {
        riskyNames.push({
          rel: node.rel,
          reason: "uses a slash-like character (U+" +
            (n.match(/[\u2044\u2215\u29F5\u29F8\uFF0F]/)![0].charCodeAt(0)).toString(16).toUpperCase() +
            ") that is not an ordinary '/' - typing or copying this path can silently fail",
        });
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u200B-\u200F\u2028-\u202F\uFEFF]|[\u0300-\u036F]/.test(n)) {
        riskyNames.push({ rel: node.rel, reason: "contains invisible or combining characters" });
      }
      if (n !== n.normalize("NFC")) {
        riskyNames.push({ rel: node.rel, reason: "name is not in Unicode NFC form" });
      }
    }
    for (const c of node.children) checkNames(c);
  })(rootNode);

  return {
    root: absRoot,
    scannedAt: started,
    durationMs: Date.now() - started,
    tree: rootNode,
    files,
    totals,
    deadFolders: deadFolders.sort(),
    riskyNames,
    skipped,
  };
}