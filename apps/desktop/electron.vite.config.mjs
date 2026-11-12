import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const pathsProject = path.resolve(projectRoot, "tsconfig.paths.json");
const devPort = Number(process.env.PI_APP_DEV_PORT ?? "5173");
export default defineConfig(({ command }) => {
  if (command === "build" && !process.stdout.isTTY) {
    const stdout = process.stdout;
    for (const method of ["clearLine", "cursorTo", "moveCursor"]) {
      if (typeof stdout[method] !== "function") {
        stdout[method] = () => stdout;
      }
    }
  }

  const cleanOutputs = command === "build";

  return {
    main: {
      plugins: [tsconfigPaths({ projects: [pathsProject] })],
      build: {
        outDir: "out/main",
        externalizeDeps: { exclude: ["@earendil-works/chord", "@pi-gui/extension-ui"] },
        emptyOutDir: cleanOutputs,
        rollupOptions: {
          input: {
            main: path.resolve(projectRoot, "electron/main.ts"),
            "codex-limits-worker": path.resolve(
              projectRoot,
              "electron/usage/codex-limits-worker.ts",
            ),
            "runtime-worker": path.resolve(projectRoot, "electron/runtime-worker.ts"),
          },
        },
      },
    },
    preload: {
      plugins: [tsconfigPaths({ projects: [pathsProject] })],
      build: {
        outDir: "out/preload",
        emptyOutDir: cleanOutputs,
        isolatedEntries: true,
        externalizeDeps: false,
        rollupOptions: {
          input: {
            preload: path.resolve(projectRoot, "electron/preload.ts"),
            "remote-broker-preload": path.resolve(
              projectRoot,
              "electron/remote/remote-broker-preload.ts",
            ),
          },
        },
      },
    },
    renderer: {
      root: projectRoot,
      base: "./",
      plugins: [react(), tailwindcss(), tsconfigPaths({ projects: [pathsProject] })],
      server: {
        port: devPort,
        strictPort: true,
      },
      build: {
        outDir: "out/renderer",
        emptyOutDir: true,
        rollupOptions: {
          input: {
            index: path.resolve(projectRoot, "index.html"),
            "remote-broker": path.resolve(projectRoot, "remote-broker.html"),
          },
        },
      },
    },
  };
});
