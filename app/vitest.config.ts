import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// Unit and component tests only. Anything that needs the native window, a Rust
// process, or real IPC belongs in `bun run e2e`, which drives the real binary.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "~": path.resolve(srcDir) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});