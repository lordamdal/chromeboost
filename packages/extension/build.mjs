import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";

const watch = process.argv.includes("--watch");

/**
 * Mirror the built extension into the plugin package.
 *
 * Loading an unpacked extension is the one manual step ChromeBoost can't
 * remove — but it can remove the build step in front of it. Shipping dist/
 * inside the plugin means that after `/plugin install chromeboost`, the
 * extension is already on disk at a known path, so `/chromeboost-setup` can
 * just hand the user a folder to select. No clone, no npm install, no build.
 */
function syncToPlugin() {
  const target = resolve("../plugin/extension");
  try {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync("dist", target, { recursive: true });
    console.log("Synced dist/ → packages/plugin/extension/");
  } catch (err) {
    console.warn("Could not sync extension into plugin:", err.message);
  }
}

const sharedConfig = {
  bundle: true,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

async function build() {
  mkdirSync("dist", { recursive: true });

  // Copy static assets
  cpSync("src/popup/index.html", "dist/popup.html");
  cpSync("src/offscreen.html", "dist/offscreen.html");
  cpSync("manifest.json", "dist/manifest.json");
  cpSync("src/icons", "dist/icons", { recursive: true });

  const contexts = await Promise.all([
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/background.ts"],
      outfile: "dist/background.js",
      format: "esm",
      platform: "browser",
    }),
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/offscreen.ts"],
      outfile: "dist/offscreen.js",
      format: "iife",
      platform: "browser",
    }),
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/content/index.ts"],
      outfile: "dist/content.js",
      format: "iife",
      platform: "browser",
    }),
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/popup/index.ts"],
      outfile: "dist/popup.js",
      format: "iife",
      platform: "browser",
    }),
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/page-shims.ts"],
      outfile: "dist/page-shims.js",
      format: "iife",
      platform: "browser",
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching for changes...");
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    syncToPlugin();
    console.log("Build complete.");
  }
}

build().catch(console.error);
