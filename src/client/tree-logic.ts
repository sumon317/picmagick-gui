/**
 * Pure tree logic, kept out of the DOM code so it can be tested directly.
 *
 * Exclusion is prefix-based on purpose: excluding "backup" also excludes
 * everything beneath it, which is what the user means when they tick a parent.
 * Everything here mirrors that rule.
 *
 * Two sets are tracked:
 *   excluded - folders to skip
 *   included - folders forced back in despite an excluded ancestor
 *
 * Include always beats exclude, so a single subfolder can be rescued without
 * giving up the parent's exclusion.
 */

/** A file as the tree logic sees it. Server-supplied fields are carried through unchanged. */
export type TreeFile = {
  rel: string;
  name?: string;
};

/** A folder node. Only the fields the pure tree logic walks are required here. */
export type TreeNode = {
  rel: string;
  files?: readonly TreeFile[];
  children: readonly TreeNode[];
};

/** Path matching options supplied by the server through /api/status. */
export type PathOptions = {
  sep?: string;
  caseInsensitive?: boolean;
};

/** Path matching options after defaults have been filled in. */
type ResolvedPathOptions = {
  sep: string;
  caseInsensitive: boolean;
};

/** The pair of file-level override sets returned by a toggle. */
export type FileSelection = {
  excludedFiles: Set<string>;
  includedFiles: Set<string>;
};

/** Folder exclusions plus the explicit includes that override them. */
export type FolderSelection = {
  excluded: Set<string>;
  included: Set<string>;
};

/** File totals for one folder, as displayed by a tri-state folder checkbox. */
export type SelectionCount = {
  total: number;
  selected: number;
};

/** Lowercased (or unchanged) copy for path matching. */
export const excludedLower = (
  set: ReadonlySet<string>,
  caseInsensitive = true,
): Set<string> =>
  new Set([...set].map((e) => caseInsensitive ? e.toLowerCase() : e));

/**
 * Path matching options supplied by the server through /api/status.
 * Defaults preserve the original Windows behaviour for direct callers.
 */
const pathOptions = (opts?: PathOptions): ResolvedPathOptions => ({
  sep: opts?.sep === "/" ? "/" : "\\",
  caseInsensitive: opts?.caseInsensitive !== false,
});

const fold = (s: string, caseInsensitive: boolean): string =>
  caseInsensitive ? s.toLowerCase() : s;

/** Does `prefix` cover `rel`, matching only on a path boundary? */
/**
 * @param {string} prefix
 * @param {string} rel
 * @param {string} dir
 */
function covers(prefix: string, rel: string, dir: string): boolean {
  return dir === prefix || dir.startsWith(prefix + "/") || rel.startsWith(prefix + "/");
}

/**
 * True when this folder, or any ancestor of it, is excluded.
 *
 * Two passes on purpose: an explicit include anywhere along the path must win
 * over an exclusion higher up, so all prefixes are checked for include first.
 */
export function isFullyExcluded(
  rel: string,
  ex: ReadonlySet<string>,
  inc: ReadonlySet<string> = new Set<string>(),
  opts: PathOptions = {},
): boolean {
  if (!rel) return false;
  const { sep, caseInsensitive } = pathOptions(opts);
  const parts = rel.split(sep);
  // Walk from deepest path to shallowest so the most specific rule wins
  for (let i = parts.length; i >= 1; i--) {
    const prefix = fold(parts.slice(0, i).join(sep), caseInsensitive);
    if (inc.has(prefix)) return false;
    if (ex.has(prefix)) return true;
  }
  return false;
}

/** True when a descendant is excluded but this folder itself is not. */
export function hasExcludedDescendant(
  node: TreeNode,
  ex: ReadonlySet<string>,
  inc: ReadonlySet<string> = new Set<string>(),
  opts: PathOptions = {},
): boolean {
  const { caseInsensitive } = pathOptions(opts);
  if (node.rel && ex.has(fold(node.rel, caseInsensitive))) return true;
  return node.children.some((c) => hasExcludedDescendant(c, ex, inc, opts));
}

/**
 * Is one file excluded, taking both folder and file rules into account?
 *
 * Every set passed here must already be folded with `excludedLower`, exactly
 * like `isFullyExcluded`. The most specific rule wins: an explicit file include
 * survives an excluded folder, and an explicit file exclusion drops a file from
 * an included folder.
 *
 * @param {string} rel
 * @param {Set<string>} exFolders
 * @param {Set<string>} incFolders
 * @param {Set<string>} exFiles
 * @param {Set<string>} incFiles
 * @param {{sep?: string, caseInsensitive?: boolean}} [opts]
 */
export function isFileExcluded(
  rel: string,
  exFolders: ReadonlySet<string>,
  incFolders: ReadonlySet<string>,
  exFiles: ReadonlySet<string>,
  incFiles: ReadonlySet<string>,
  opts: PathOptions = {},
): boolean {
  const { caseInsensitive } = pathOptions(opts);
  const key = fold(rel, caseInsensitive);
  if (incFiles.has(key)) return false;
  if (exFiles.has(key)) return true;
  return isFullyExcluded(rel, exFolders, incFolders, opts);
}

/**
 * Toggle one file without disturbing any other choice.
 *
 * The caller only ever stores the file the user touched; folder rules still
 * cover everything else. The opposite set is cleared for the same path so a
 * file cannot end up both included and excluded.
 *
 * @param {string} rel
 * @param {boolean} nowExcluded
 * @param {Set<string>} [excludedFiles]
 * @param {Set<string>} [includedFiles]
 * @param {{sep?: string, caseInsensitive?: boolean}} [opts]
 * @returns {{excludedFiles: Set<string>, includedFiles: Set<string>}}
 */
export function toggleFile(
  rel: string,
  nowExcluded: boolean,
  excludedFiles: ReadonlySet<string> = new Set<string>(),
  includedFiles: ReadonlySet<string> = new Set<string>(),
  opts: PathOptions = {},
): FileSelection {
  const { caseInsensitive } = pathOptions(opts);
  const key = fold(rel, caseInsensitive);
  const ex = new Set(excludedFiles);
  const inc = new Set(includedFiles);

  for (const e of [...ex]) if (fold(e, caseInsensitive) === key) ex.delete(e);
  for (const e of [...inc]) if (fold(e, caseInsensitive) === key) inc.delete(e);

  if (nowExcluded) ex.add(rel);
  else inc.add(rel);
  return { excludedFiles: ex, includedFiles: inc };
}

/**
 * Drop file-level overrides at or below a folder. A folder checkbox means
 * "all of this" or "none of this", so any per-file choice underneath it is no
 * longer meaningful once the folder itself is toggled.
 *
 * @param {string} rel
 * @param {Set<string>} excludedFiles
 * @param {Set<string>} includedFiles
 * @param {{sep?: string, caseInsensitive?: boolean}} [opts]
 * @returns {{excludedFiles: Set<string>, includedFiles: Set<string>}}
 */
export function clearFileOverridesUnder(
  rel: string,
  excludedFiles: ReadonlySet<string>,
  includedFiles: ReadonlySet<string>,
  opts: PathOptions = {},
): FileSelection {
  const { sep, caseInsensitive } = pathOptions(opts);
  const key = fold(rel, caseInsensitive);
  const atOrBelow = (p: string): boolean => {
    const k = fold(p, caseInsensitive);
    return k === key || k.startsWith(key + sep);
  };
  return {
    excludedFiles: new Set([...excludedFiles].filter((p) => !atOrBelow(p))),
    includedFiles: new Set([...includedFiles].filter((p) => !atOrBelow(p))),
  };
}

/**
 * Count every file in a node and how many are selected.
 *
 * Counts are computed once per render so a folder checkbox can show
 * checked / indeterminate / unchecked without re-walking the subtree for every
 * row. `out` maps a folder rel to its {total, selected} pair.
 *
 * @param {any} node
 * @param {(file: any) => boolean} isSelected
 * @param {Map<string, {total: number, selected: number}>} [out]
 * @returns {{total: number, selected: number}}
 */
export function countSelection(
  node: TreeNode,
  isSelected: (file: TreeFile) => boolean,
  out: Map<string, SelectionCount> = new Map(),
): SelectionCount {
  let total = 0;
  let selected = 0;
  for (const f of node.files ?? []) {
    total++;
    if (isSelected(f)) selected++;
  }
  for (const c of node.children ?? []) {
    const child = countSelection(c, isSelected, out);
    total += child.total;
    selected += child.selected;
  }
  out.set(node.rel, { total, selected });
  return { total, selected };
}

/** Every file in a tree, including files sitting directly in the root. */
export function collectFiles(node: TreeNode): TreeFile[] {
  return [
    ...(node.files ?? []),
    ...(node.children ?? []).flatMap((c) => collectFiles(c)),
  ];
}

/**
 * Toggle one folder without disturbing any other choice.
 *
 * The original rebuilt the entire set from a single toggle, so unchecking a
 * second folder silently re-included the first. Only the folder itself is
 * recorded here, never its descendants: exclusion is prefix-based, so the
 * server already covers the whole subtree and the payload stays small.
 *
 * @param nowExcluded true when the folder should be skipped.
 * @returns {{excluded: Set<string>, included: Set<string>}}
 */
export function toggleFolder(
  tree: TreeNode | null,
  excluded: ReadonlySet<string>,
  rel: string,
  nowExcluded: boolean,
  included: ReadonlySet<string> = new Set<string>(),
  opts: PathOptions = {},
): FolderSelection {
  const ex = new Set(excluded);
  const inc = new Set(included);
  const { sep, caseInsensitive } = pathOptions(opts);
  const key = fold(rel, caseInsensitive);

  // "At or below the target": the target itself, or a recorded descendant.
  // Descendants follow the target, so they are cleared in both directions.
  // Ancestors are deliberately NOT in here: excluding a child must never
  // cancel an exclusion the user set on its parent.
  const atOrBelow = (e: string): boolean => {
    const k = fold(e, caseInsensitive);
    return k === key || k.startsWith(key + sep);
  };
  const ancestorExcluded = [...ex].some((e) =>
    key.startsWith(fold(e, caseInsensitive) + sep));

  for (const e of [...ex]) if (atOrBelow(e)) ex.delete(e);
  for (const e of [...inc]) if (atOrBelow(e)) inc.delete(e);

  if (nowExcluded) {
    ex.add(rel);
  } else if (ancestorExcluded) {
    // The parent stays excluded, so this needs an explicit include override or
    // the ancestor's prefix match would swallow it.
    inc.add(rel);
  }

  return { excluded: ex, included: inc };
}

/** Every rel in the tree, depth first. */
export function collectRels(node: TreeNode): string[] {
  return node.children.flatMap((c) => [c.rel, ...collectRels(c)]);
}

/** Top-level folder rels only. */
export function topLevelRels(tree: TreeNode): string[] {
  return tree.children.map((c) => c.rel);
}
