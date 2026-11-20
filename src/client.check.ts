/**
 * Guard against client-shell regressions.
 *
 * TypeScript and the bundler already prove that every imported symbol exists.
 * This check covers the seam they cannot see: every element id the client looks
 * up must exist in index.html or be created by the client itself. It also keeps
 * the old un-bundled modules from creeping back into the served artifact.
 *
 *   bun run src/client.check.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let bad = 0;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const sources = walk("src/client").filter((file) => file.endsWith(".ts"));
const html = readFileSync("public/index.html", "utf8");
const bundle = readFileSync("public/app.js", "utf8");

// ── 1. The served artifact must be current and self-contained ───────────────
console.log(`\n== bundle ==`);
if (bundle.length < 50_000) {
  bad++;
  console.log(`  app.js is only ${bundle.length} bytes — run bun run build:client`);
} else {
  console.log(`  app.js is ${(bundle.length / 1024).toFixed(1)} KB`);
}

if (/from\s+["']\.\/(?:treelogic|formatlogic)/.test(bundle)) {
  bad++;
  console.log("  app.js still imports the deleted treelogic/formatlogic modules");
} else {
  console.log("  no imports of the deleted un-bundled modules");
}

if (!bundle.includes("/api/")) {
  bad++;
  console.log("  app.js does not look like the client bundle");
}

// ── 2. Every literal element id must resolve ───────────────────────────────
const htmlIds = new Set<string>();
for (const match of html.matchAll(/\bid="([A-Za-z_$][\w$]*)"/g)) {
  const id = match[1];
  if (htmlIds.has(id)) {
    bad++;
    console.log(`  duplicate id in index.html: #${id}`);
  }
  htmlIds.add(id);
}

const created = new Set<string>();
for (const file of sources) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bid="([A-Za-z_$][\w$]*)"/g)) created.add(match[1]);
  for (const match of source.matchAll(/\bid='([A-Za-z_$][\w$]*)'/g)) created.add(match[1]);
}

const referenced = new Map<string, string>();
for (const file of sources) {
  const source = readFileSync(file, "utf8");
  const patterns = [
    /\$(?:<[^>]+>)?\("([^"]+)"\)/g,
    /\binput\("([^"]+)"\)/g,
    /\bselect\("([^"]+)"\)/g,
    /document\.getElementById\("([^"]+)"\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!referenced.has(match[1])) referenced.set(match[1], file);
    }
  }
}

console.log(`\n== element ids ==`);
const absent = [...referenced.entries()].filter(
  ([id]) => !htmlIds.has(id) && !created.has(id),
);
if (absent.length) {
  bad++;
  for (const [id, file] of absent) console.log(`  MISSING in index.html: #${id}  (${file})`);
} else {
  console.log(`  all ${referenced.size} literal ids resolve in HTML or are created by the client`);
}

// ── 2b. Every sprite icon reference must resolve in index.html ─────────────
const spriteIds = new Set([...html.matchAll(/<symbol\s+id="(i-[^"]+)"/g)].map((m) => m[1]));
const missingIcons: string[] = [];
for (const file of sources) {
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/\bicon\(\s*"([^"]+)"/g)) {
    if (!spriteIds.has(`i-${m[1]}`)) missingIcons.push(`i-${m[1]} (${file})`);
  }
}
if (missingIcons.length) {
  bad++;
  for (const miss of missingIcons) console.log(`  MISSING sprite symbol: #${miss}`);
} else {
  console.log(`  all sprite icon references resolve in index.html`);
}

// ── 3. The shell must not assume macOS chrome ──────────────────────────────
console.log(`\n== platform ==`);
if (/traffic-light|titleBarStyle\s*[:=]\s*["']hiddenInset/.test(html)) {
  bad++;
  console.log("  index.html still contains macOS-only chrome");
} else {
  console.log("  no macOS-only chrome in index.html");
}

// ── 4. fold parity: client tree-logic.ts ↔ server policy.ts ──────────────────
// The client bundler cannot import a server-side leaf (policy.ts pulls in
// node:path etc.), and both fold implementations are module-private, so a
// direct runtime equality check is impossible. Instead we (a) compare the two
// implementations' algorithm "fingerprints" straight from source — the check
// fails the moment either file drifts — and (b) exercise an inlined copy of
// that exact algorithm against the documented edge cases. The fingerprints tie
// the inlined copy to the real code rather than faking parity.
console.log(`\n== fold parity (client ↔ server) ==`);
const treeLogicSrc = readFileSync("src/client/tree-logic.ts", "utf8");
const policySrc = readFileSync("src/policy.ts", "utf8");

const SLASH_DEF_RE = /const SLASH_LIKE = \/(.+?)\/g;/;
const treeSlash = treeLogicSrc.match(SLASH_DEF_RE)?.[1];
const policySlash = policySrc.match(SLASH_DEF_RE)?.[1];
if (!treeSlash || !policySlash || treeSlash !== policySlash) {
  bad++;
  console.log(`  SLASH_LIKE definitions differ (tree-logic=${treeSlash}, policy=${policySlash})`);
} else {
  console.log(`  SLASH_LIKE lookalike family identical in both files`);
}

const FOLD_CORE_RE = /\.normalize\("NFC"\)[\s\S]*?folded\.toLowerCase\(\)\s*:\s*folded/;
const canon = (s: string): string =>
  s.replace(/\s+/g, "").replace(/CASE_INSENSITIVE|caseInsensitive/g, "CI");
const treeCore = treeLogicSrc.match(FOLD_CORE_RE)?.[0];
const policyCore = policySrc.match(FOLD_CORE_RE)?.[0];
if (!treeCore || !policyCore || canon(treeCore) !== canon(policyCore)) {
  bad++;
  console.log(`  fold algorithm drifted between tree-logic.ts and policy.ts`);
} else {
  console.log(`  fold algorithm equivalent in both files (modulo CI variable name)`);
}

// Inlined copy of the canonical algorithm above (verified against both real
// files by the fingerprints). Behavioural vectors for the four categories the
// contract calls out: NFC/NFD, SLASH_LIKE lookalikes, trailing slashes, and
// case-insensitive on/off.
const INLINE_SLASH_LIKE = /[\u002F\u005C\u2044\u2215\u29F5\u29F8\uFF0F\uFF3C]/g;
// The two source fingerprints above catch one-sided drift. This one catches
// COORDINATED drift: if both real files change but the inlined copy used by the
// behavioural vectors below does not, the vectors would silently test a stale
// family. Tie the inlined regex to the real tree-logic.ts definition directly.
if (INLINE_SLASH_LIKE.source !== treeSlash) {
  bad++;
  console.log(`  inlined SLASH_LIKE drifted from tree-logic.ts (inline=${INLINE_SLASH_LIKE.source}, tree=${treeSlash})`);
} else {
  console.log(`  inlined SLASH_LIKE matches tree-logic.ts SLASH_LIKE`);
}
const referenceFold = (s: string, caseInsensitive: boolean): string => {
  const folded = s.normalize("NFC").replace(INLINE_SLASH_LIKE, "/").replace(/\/+$/, "");
  return caseInsensitive ? folded.toLowerCase() : folded;
};
const parityVectors: Array<{ label: string; inputs: string[]; ci: boolean; want: string }> = [
  { label: "NFC vs NFD", inputs: ["caf\u00e9", "cafe\u0301"], ci: false, want: "caf\u00e9" },
  {
    label: "slash lookalikes",
    inputs: ["a/b", "a\u2044b", "a\u2215b", "a\u29f5b", "a\u29f8b", "a\uff0fb", "a\uff3cb", "a\\b"],
    ci: false,
    want: "a/b",
  },
  { label: "trailing slashes", inputs: ["album", "album/", "album///", "album\u2044"], ci: false, want: "album" },
  { label: "case-insensitive on", inputs: ["Album"], ci: true, want: "album" },
  { label: "case-insensitive off", inputs: ["Album"], ci: false, want: "Album" },
];
let parityFails = 0;
for (const v of parityVectors) {
  const wrong = v.inputs.filter((input) => referenceFold(input, v.ci) !== v.want);
  if (wrong.length) {
    bad++;
    parityFails++;
    console.log(`  ${v.label}: expected ${JSON.stringify(v.want)}, got ${wrong.map((w) => JSON.stringify(referenceFold(w, v.ci))).join(", ")}`);
  }
}
console.log(`  fold parity: ${parityVectors.length - parityFails}/${parityVectors.length} vectors agree`);

console.log(bad ? `\n${bad} problem(s)` : "\nclient OK");
if (bad) process.exit(1);
