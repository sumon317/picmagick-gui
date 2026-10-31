import type { ElectrobunConfig } from "electrobun";

const isFull = process.env.COMPAKTA_FLAVOR === "full" || process.env.PICMAGIK_FLAVOR === "full";
const copy: Record<string, string> = {
  public: "public",
};

if (isFull) {
  copy.imagemagick = "imagemagick";
}

/**
 * Desktop packaging. The Bun main process starts the same local server the
 * browser launchers use, then opens a native window at its loopback URL.
 *
 * `app.version` must match package.json and the `v*` tag being released.
 */
export default {
  app: {
    name: isFull ? "Compakta Full" : "Compakta",
    identifier: isFull
      ? "com.github.esconer.compakta-full"
      : "com.github.esconer.compakta",
    version: "1.3.2",
    description:
      "Local GUI for compressing and converting photos and videos.",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/desktop.ts",
      sourcemap: "linked",
    },
    // The server reads these files at runtime; they must travel with the app.
    copy,
    win: {
      icon: "assets/icon.ico",
    },
    linux: {
      icon: "assets/icon.png",
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  // Installers are published on GitHub Releases. No update host is configured,
  // so there is no previous release for Hutch to diff against.
  release: {
    generatePatch: false,
  },
} satisfies ElectrobunConfig;
