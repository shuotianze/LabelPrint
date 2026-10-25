import { defineConfig } from "vite";

// Tauri 需要固定端口，且不能在编译时弹出清屏
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // Tauri 的 WebView2 / Android WebView 都基于 Chromium 105+
    target: "chrome105",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
