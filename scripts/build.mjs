import { build } from "vite";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("public/manifest.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
if (
  manifest.version !== version ||
  lock.version !== version ||
  lock.packages[""].version !== version
) {
  throw new Error(
    "请同步 package.json、package-lock.json 和 public/manifest.json 的版本号后再构建。",
  );
}
await build({
  configFile: false,
  define: { __LOCALMARK_VERSION__: JSON.stringify(version) },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        settings: resolve("settings.html"),
        sidepanel: resolve("sidepanel.html"),
        dashboard: resolve("dashboard.html"),
        background: resolve("src/background.ts"),
        toolbar: resolve("src/toolbar.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
});
const notices = await Promise.all(
  ["react", "react-dom", "scheduler", "zod"].map(
    async (name) =>
      `${name}\n${"=".repeat(60)}\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}\n`,
  ),
);
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n"), "utf8");
await build({
  configFile: false,
  publicDir: false,
  define: {
    "process.env.NODE_ENV": '"production"',
    __LOCALMARK_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve("src/content.tsx"),
      name: "LocalWebClipper",
      formats: ["iife"],
      fileName: () => "content.js",
    },
  },
});
await build({
  configFile: false,
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve("src/video-native.ts"),
      name: "LocalMarkNativeSubtitles",
      formats: ["iife"],
      fileName: () => "video-native.js",
    },
  },
});
