import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset paths so the packaged app loads assets over file://
  // (absolute "/assets" resolves to filesystem root in a built Electron app).
  base: "./",
  plugins: [react()],
  root: "src/renderer",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
});
