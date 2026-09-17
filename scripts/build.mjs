import { build } from "vite";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
await build({
  configFile: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        settings: resolve("settings.html"),
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
  define: { "process.env.NODE_ENV": '"production"' },
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
