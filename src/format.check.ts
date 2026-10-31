/**
 * Output-format checks.
 *
 * The AVIF cases are a regression contract: they assert the exact command,
 * paths, defaults, and source arguments the app used before format selection
 * existed. If one of these fails, AVIF behaviour changed.
 *
 *   bun run src/format.check.ts
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CASE_INSENSITIVE, REL_SEP } from "./platform.ts";
import {
  DEFAULT_POLICY, applyPolicy, normalisePolicy, outputPathFor, type Decision, type Policy,
} from "./policy.ts";
import {
  DEFAULT_FORMAT, FORMAT_SPECS, OUTPUT_FORMATS, buildEncoderArgs, jp2Rate,
  jxlEffort, qualityDisplay, sourceArgFor, speedDisplay, webpMethod,
  type OutputFormat,
} from "./formats.ts";
import { parseFormatSupport } from "./paths.ts";
import { manifestPath, readManifest, writeManifest } from "./manifest.ts";
import { analyseSync } from "./sync.ts";
import type { ScannedFile } from "./scan.ts";
import type { ScanResult } from "./scan.ts";
import * as destination from "../src/client/format-logic.ts";

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

const nativeRel = (...parts: string[]) => parts.join(REL_SEP);

function scanned(
  parts: string[],
  size = 2 * 1024 * 1024,
  ext = "jpg",
): ScannedFile {
  const rel = nativeRel(...parts);
  return {
    abs: path.resolve("/library", rel),
    rel,
    dir: path.dirname(rel),
    name: parts[parts.length - 1],
    ext,
    size,
    category: "image",
    mtime: 1_700_000_000_000,
  };
}

function decided(file: ScannedFile, verdict: "convert" | "copy" = "convert"): Decision {
  return {
    file,
    verdict,
    reason: verdict === "copy" ? "undersized" : "ok",
  };
}

function withPolicy(patch: Partial<Policy>): Policy {
  return normalisePolicy({ ...DEFAULT_POLICY, ...patch });
}

const SRC = path.resolve("/library", nativeRel("album", "sub", "a.jpg"));
const OUT = path.resolve("/out", nativeRel("album", "sub", "a.avif"));

console.log(`format: ${process.platform}, separator: ${JSON.stringify(REL_SEP)}`);

await check("registry order and default", () => {
  assert.deepEqual([...OUTPUT_FORMATS], ["jxl", "avif", "webp", "heic", "jp2", "jpeg", "png"]);
  assert.equal(DEFAULT_FORMAT, "avif");
});

await check("AVIF defaults are unchanged", () => {
  assert.equal(DEFAULT_POLICY.outputFormat, "avif");
  assert.deepEqual(DEFAULT_POLICY.qualities, [60]);
  assert.equal(DEFAULT_POLICY.heicSpeed, 6);
  assert.equal(normalisePolicy(undefined).outputFormat, "avif");
  assert.deepEqual(normalisePolicy(undefined).qualities, [60]);
  assert.equal(normalisePolicy(undefined).heicSpeed, 6);
});

await check("an invalid output format falls back to AVIF", () => {
  assert.equal(normalisePolicy({ outputFormat: "tiff" as OutputFormat }).outputFormat, "avif");
});

await check("format metadata is unique where it matters", () => {
  for (const key of ["ext", "destinationSuffix", "mime", "magickPrefix"] as const) {
    const values = OUTPUT_FORMATS.map((id) => FORMAT_SPECS[id][key]);
    assert.equal(new Set(values).size, values.length, `duplicate ${key}`);
  }
});

await check("AVIF encoder arguments are byte-for-byte unchanged", () => {
  assert.deepEqual(
    buildEncoderArgs({
      srcArg: "C:\\library\\a.jpg",
      out: "C:\\out\\a.avif",
      format: "avif",
      quality: 60,
      speed: 6,
    }),
    [
      "C:\\library\\a.jpg",
      "-auto-orient",
      "-colorspace", "sRGB",
      "-quality", "60",
      "-define", "heic:speed=6",
      "AVIF:C:\\out\\a.avif",
    ],
  );
});

await check("AVIF arguments contain no other format's flags", () => {
  const args = buildEncoderArgs({
    srcArg: "a.jpg", out: "a.avif", format: "avif", quality: 60, speed: 6,
  }).join(" ");
  for (const foreign of ["jxl:", "webp:", "jp2:", "PNG:", "JPEG:", "-background"]) {
    assert.equal(args.includes(foreign), false, `unexpected ${foreign}`);
  }
});

await check("AVIF output paths keep the existing naming", () => {
  const decision = decided(scanned(["album", "sub", "a.jpg"]));
  const destinationRoot = path.resolve("/out");

  assert.equal(
    outputPathFor(decision, "/library", destinationRoot, withPolicy({ outputFormat: "avif" })),
    path.join(destinationRoot, nativeRel("album", "sub"), "a.avif"),
  );
  assert.equal(
    outputPathFor(
      decision, "/library", destinationRoot,
      withPolicy({ outputFormat: "avif", qualities: [60, 80] }), 80,
    ),
    path.join(destinationRoot, nativeRel("album", "sub"), "a-q80.avif"),
  );
});

await check("same-stem siblings get distinct output paths", () => {
  const files = [
    scanned(["album", "IMG_001.JPG"], 2 * 1024 * 1024, "jpg"),
    scanned(["album", "IMG_001.HEIC"], 2 * 1024 * 1024, "heic"),
  ];
  const policy = withPolicy({ outputFormat: "avif" });
  const preview = applyPolicy({ files } as ScanResult, policy);
  const outs = preview.convert
    .map((d) => path.basename(outputPathFor(d, "/library", path.resolve("/out"), policy)))
    .sort();
  assert.deepEqual(outs, ["IMG_001-heic.avif", "IMG_001-jpg.avif"]);
});

await check("AVIF source arguments preserve the existing GIF rule", () => {
  const gif = path.resolve("/library", "anim.gif");
  const jpg = path.resolve("/library", "a.jpg");

  assert.equal(sourceArgFor(gif, "gif", "avif", true), `${gif}[0]`);
  assert.equal(sourceArgFor(gif, "gif", "avif", false), gif);
  assert.equal(sourceArgFor(jpg, "jpg", "avif", true), jpg);
});

await check("JXL arguments and effort mapping", () => {
  const args = buildEncoderArgs({
    srcArg: SRC, out: "a.jxl", format: "jxl", quality: 80, speed: 6,
  });
  assert.deepEqual(args, [
    SRC, "-auto-orient", "-colorspace", "sRGB",
    "-quality", "80", "-define", "jxl:effort=5", "JXL:a.jxl",
  ]);
  assert.deepEqual([4, 5, 6, 7, 8, 9].map(jxlEffort), [7, 6, 5, 4, 3, 2]);
  assert.equal(speedDisplay("jxl", 4), "effort 7");
  assert.equal(speedDisplay("jxl", 6), "effort 5");
  assert.equal(speedDisplay("jxl", 9), "effort 2");
});

await check("WebP arguments and method mapping", () => {
  const args = buildEncoderArgs({
    srcArg: SRC, out: "a.webp", format: "webp", quality: 80, speed: 6,
  });
  assert.deepEqual(args, [
    SRC, "-auto-orient", "-colorspace", "sRGB",
    "-quality", "80", "-define", "webp:method=4", "WEBP:a.webp",
  ]);
  assert.deepEqual([4, 5, 6, 7, 8, 9].map(webpMethod), [6, 5, 4, 3, 2, 1]);
  assert.equal(speedDisplay("webp", 4), "method 6");
  assert.equal(speedDisplay("webp", 6), "method 4");
  assert.equal(speedDisplay("webp", 9), "method 1");
});

await check("HEIC arguments mirror AVIF", () => {
  assert.deepEqual(
    buildEncoderArgs({
      srcArg: SRC, out: "a.heic", format: "heic", quality: 60, speed: 6,
    }),
    [
      SRC, "-auto-orient", "-colorspace", "sRGB",
      "-quality", "60", "-define", "heic:speed=6", "HEIC:a.heic",
    ],
  );
});

await check("JPEG 2000 uses jp2:rate, not -quality", () => {
  const args = buildEncoderArgs({
    srcArg: SRC, out: "a.jp2", format: "jp2", quality: 60, speed: 6,
  });
  assert.deepEqual(args, [
    SRC, "-auto-orient", "-colorspace", "sRGB",
    "-define", "jp2:rate=20", "JP2:a.jp2",
  ]);
  assert.equal(args.includes("-quality"), false);
  assert.equal(jp2Rate(20), 80);
  assert.equal(jp2Rate(40), 40);
  assert.equal(jp2Rate(60), 20);
  assert.equal(jp2Rate(80), 10);
  assert.equal(jp2Rate(90), 5);
  assert.equal(qualityDisplay("jp2", 60), "q60 (20:1)");
});

await check("JPEG arguments flatten transparency onto white", () => {
  const args = buildEncoderArgs({
    srcArg: SRC, out: "a.jpg", format: "jpeg", quality: 85, speed: 6,
  });
  assert.deepEqual(args, [
    SRC, "-auto-orient", "-colorspace", "sRGB",
    "-background", "white", "-alpha", "remove", "-alpha", "off",
    "-quality", "85", "-sampling-factor", "4:2:0", "-interlace", "Plane",
    "JPEG:a.jpg",
  ]);
  assert.equal(
    buildEncoderArgs({
      srcArg: SRC, out: "a.jpg", format: "jpeg", quality: 85, speed: 4,
    }).join(" ").includes("4:4:4 -interlace Plane"),
    true,
  );
  assert.equal(
    buildEncoderArgs({
      srcArg: SRC, out: "a.jpg", format: "jpeg", quality: 85, speed: 9,
    }).join(" ").includes("4:2:0 -interlace None"),
    true,
  );
});

await check("PNG arguments are lossless and format-specific flags are absent", () => {
  const args = buildEncoderArgs({
    srcArg: SRC, out: "a.png", format: "png", quality: 90, speed: 6,
  });
  assert.deepEqual(args, [
    SRC, "-auto-orient", "-colorspace", "sRGB",
    "-quality", "90", "PNG:a.png",
  ]);
  const text = args.join(" ");
  for (const foreign of ["heic:speed", "webp:method", "jxl:effort", "jp2:rate"]) {
    assert.equal(text.includes(foreign), false, `unexpected ${foreign}`);
  }
  assert.equal(qualityDisplay("png", 20), "level 2");
  assert.equal(qualityDisplay("png", 60), "level 6");
  assert.equal(qualityDisplay("png", 90), "level 9");
});

await check("source arguments select frame 0 for single-frame formats", () => {
  const gif = path.resolve("/library", "anim.gif");
  for (const format of ["heic", "jp2", "jpeg", "png"] as const) {
    assert.equal(sourceArgFor(gif, "gif", format, false), `${gif}[0]`, format);
  }
  for (const format of ["jxl", "avif", "webp"] as const) {
    assert.equal(sourceArgFor(gif, "gif", format, true), `${gif}[0]`, format);
    assert.equal(sourceArgFor(gif, "gif", format, false), gif, format);
  }
});

await check("output paths use the selected extension", () => {
  const decision = decided(scanned(["album", "sub", "a.jpg"]));
  const destinationRoot = path.resolve("/out");
  for (const id of OUTPUT_FORMATS) {
    assert.equal(
      outputPathFor(decision, "/library", destinationRoot, withPolicy({ outputFormat: id })),
      path.join(destinationRoot, nativeRel("album", "sub"), `a.${FORMAT_SPECS[id].ext}`),
      id,
    );
  }
});

await check("multi-quality naming uses the slider value and selected extension", () => {
  const decision = decided(scanned(["album", "a.jpg"]));
  assert.equal(
    path.basename(outputPathFor(
      decision, "/library", path.resolve("/out"),
      withPolicy({ outputFormat: "jp2", qualities: [60, 80] }), 60,
    )),
    "a-q60.jp2",
  );
});

await check("copied files keep their original filename and extension", () => {
  const decision = decided(scanned(["album", "a.jpg"]), "copy");
  const out = outputPathFor(
    decision, "/library", path.resolve("/out"),
    withPolicy({ outputFormat: "jxl", qualities: [60, 80] }), 80,
  );
  assert.equal(out, path.join(path.resolve("/out"), nativeRel("album"), "a.jpg"));
});

await check("compare quality sets are per format", () => {
  assert.deepEqual(FORMAT_SPECS.jxl.compareQualities, [50, 70, 80, 85, 90]);
  assert.deepEqual(FORMAT_SPECS.avif.compareQualities, [30, 50, 60, 70, 80]);
  assert.deepEqual(FORMAT_SPECS.webp.compareQualities, [30, 50, 60, 70, 80]);
  assert.deepEqual(FORMAT_SPECS.heic.compareQualities, [30, 50, 60, 70, 80]);
  assert.deepEqual(FORMAT_SPECS.jp2.compareQualities, [20, 40, 60, 80, 90]);
  assert.deepEqual(FORMAT_SPECS.jpeg.compareQualities, [30, 50, 70, 85, 90]);
  assert.deepEqual(FORMAT_SPECS.png.compareQualities, [20, 40, 60, 75, 90]);
});

await check("destination follows a format change only from the old default", () => {
  assert.equal(destination.defaultDestination("D:\\Photos", "avif"), "D:\\Photos-avif");
  assert.equal(destination.defaultDestination("D:\\Photos\\", "avif"), "D:\\Photos-avif");
  assert.equal(
    destination.nextDestinationOnFormatChange(
      "D:\\Photos-avif", "D:\\Photos", "avif", "jxl", true,
    ),
    "D:\\Photos-jxl",
  );
  assert.equal(
    destination.nextDestinationOnFormatChange(
      "D:\\Exports\\small", "D:\\Photos", "avif", "jxl", true,
    ),
    "D:\\Exports\\small",
  );
  assert.equal(
    destination.nextDestinationOnFormatChange(
      "D:\\PHOTOS-AVIF", "D:\\Photos", "avif", "jxl", true,
    ),
    "D:\\Photos-jxl",
  );
  assert.equal(
    destination.nextDestinationOnFormatChange(
      "D:\\PHOTOS-AVIF", "D:\\Photos", "avif", "jxl", false,
    ),
    "D:\\PHOTOS-AVIF",
  );
  assert.equal(
    destination.nextDestinationOnFormatChange(
      "D:\\Photos-avif\\", "D:\\Photos\\", "avif", "jxl", true,
    ),
    "D:\\Photos-jxl",
  );
  assert.equal(destination.nextDestinationOnFormatChange("", "D:\\Photos", "avif", "jxl", true), "");
});

await check("a filesystem root is not stripped into an invalid path", () => {
  assert.equal(destination.defaultDestination("C:\\", "avif"), "C:\\-avif");
  assert.equal(destination.defaultDestination("/", "jxl"), "/-jxl");
  assert.equal(
    destination.nextDestinationOnFormatChange("C:\\-avif", "C:\\", "avif", "jxl", true),
    "C:\\-jxl",
  );
});

await check("format capability parsing covers all seven formats", () => {
  const text = [
    "     AVIF  rw+   AV1 Image File Format (1.23.6)",
    "     HEIC  r--   High Efficiency Image File Format (1.23.6)",
    "      JP2* rw-   JPEG-2000 File Format Syntax (2.5.4)",
    "     JPEG* rw-   Joint Photographic Experts Group JFIF format (libjpeg-turbo 3.2.0)",
    "      JXL* rw+   JPEG XL (ISO/IEC 18181) (libjxl 0.12.0)",
    "      PNG* rw-   Portable Network Graphics (libpng 1.6.59)",
    "     WEBP* rw+   WebP Image Format (libwebp 1.6.0 [0210])",
  ].join("\n");

  const support = parseFormatSupport(text);
  assert.equal(support.jxl.mode, "rw+");
  assert.equal(support.jxl.detail, "libjxl 0.12.0");
  assert.equal(support.avif.mode, "rw+");
  assert.equal(support.avif.detail, "1.23.6");
  assert.equal(support.webp.mode, "rw+");
  assert.equal(support.webp.detail, "libwebp 1.6.0 [0210]");
  assert.equal(support.heic.mode, "r--");
  assert.equal(support.heic.writable, false);
  assert.equal(support.jp2.mode, "rw-");
  assert.equal(support.jp2.detail, "2.5.4");
  assert.equal(support.jpeg.detail, "libjpeg-turbo 3.2.0");
  assert.equal(support.png.detail, "libpng 1.6.59");

  for (const id of ["jxl", "avif", "webp", "jp2", "jpeg", "png"] as const) {
    assert.equal(support[id].writable, true, id);
  }
});

await check("manifest writes the format and reads old manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picmagick-format-"));
  try {
    const out = path.join(root, "out");
    await mkdir(out);
    const written = await writeManifest(
      out,
      "run-format-check",
      {
        createdAt: 0,
        sourceRoot: path.join(root, "src"),
        destination: out,
        quality: [80],
        heicSpeed: 6,
        outputFormat: "jxl",
        tool: "format-check",
      },
      [],
    );
    assert.equal(written.outputFormat, "jxl");
    assert.deepEqual(written.quality, [80]);
    assert.equal(written.heicSpeed, 6);
    assert.equal((await readManifest(manifestPath(out, "run-format-check"))).outputFormat, "jxl");

    // A manifest from before this feature has no outputFormat. Reading it must
    // still work; the API/UI treat the missing value as AVIF.
    const oldPath = path.join(out, ".picmagic-manifest-old.json");
    await writeFile(oldPath, JSON.stringify({
      id: "old",
      createdAt: 0,
      sourceRoot: path.join(root, "src"),
      destination: out,
      quality: [60],
      heicSpeed: 6,
      tool: "picmagick-gui",
      entries: [],
      summary: { converted: 0, copied: 0, skipped: 0, failed: 0, bytes: 0 },
    }), "utf8");
    const old = await readManifest(oldPath);
    assert.equal(old.outputFormat, undefined);
    assert.equal(old.outputFormat ?? "avif", "avif");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check("sync follows the selected format and reports old outputs as orphans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picmagick-format-sync-"));
  try {
    const source = path.join(root, "src");
    const destinationRoot = path.join(root, "out");
    await mkdir(source);
    await mkdir(destinationRoot);

    const srcPath = path.join(source, "a.jpg");
    await writeFile(srcPath, "source-bytes");
    const srcStat = await stat(srcPath);

    const avifPath = path.join(destinationRoot, "a.avif");
    await writeFile(avifPath, "avif-bytes");
    const newer = new Date(srcStat.mtimeMs + 10_000);
    await utimes(avifPath, newer, newer);

    const file: ScannedFile = {
      abs: srcPath,
      rel: "a.jpg",
      dir: ".",
      name: "a.jpg",
      ext: "jpg",
      size: srcStat.size,
      category: "image",
      mtime: srcStat.mtimeMs,
    };
    const decision = decided(file);

    let report = await analyseSync(
      [decision], source, destinationRoot, withPolicy({ outputFormat: "avif" }),
    );
    assert.equal(report.entries[0].state, "upToDate");

    report = await analyseSync(
      [decision], source, destinationRoot, withPolicy({ outputFormat: "jxl" }),
    );
    assert.equal(report.entries[0].state, "new");
    assert.equal(report.orphans.some((o) => path.basename(o.out) === "a.avif"), true);

    const jxlPath = path.join(destinationRoot, "a.jxl");
    await writeFile(jxlPath, "jxl-bytes");
    await utimes(jxlPath, newer, newer);

    report = await analyseSync(
      [decision], source, destinationRoot, withPolicy({ outputFormat: "jxl" }),
    );
    assert.equal(report.entries[0].state, "upToDate");

    // The extension is the only difference: repeat for two more formats.
    for (const format of ["webp", "jp2"] as const) {
      const outPath = path.join(destinationRoot, `a.${format}`);
      await writeFile(outPath, `${format}-bytes`);
      await utimes(outPath, newer, newer);
      const next = await analyseSync(
        [decision], source, destinationRoot, withPolicy({ outputFormat: format }),
      );
      assert.equal(next.entries[0].state, "upToDate", format);
      assert.equal(
        next.orphans.some((o) => path.basename(o.out) === "a.avif"), true, format,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check("format check files stay readable", async () => {
  // Guards against a future edit turning this file into a syntax-only check.
  assert.equal((await readFile(new URL(import.meta.url))).length > 0, true);
  assert.equal(CASE_INSENSITIVE, process.platform === "win32");
});

console.log(failures ? `\n${failures} format check(s) failed` : "\nformat OK");
if (failures) process.exit(1);
