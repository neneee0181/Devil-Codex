import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  root: "src/mobile",
  build: {
    outDir: "../../dist-mobile",
    emptyOutDir: true,
  },
});
