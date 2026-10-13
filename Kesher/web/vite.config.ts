import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from '@vitejs/plugin-basic-ssl';
import { legacyCss } from "./legacy-css";

export default defineConfig({
  plugins: [react(), basicSsl(), legacyCss()],
  // Auch alte iPads (iOS 12 / Safari 12) sollen Kesher öffnen können
  build: {
    target: ["es2015", "safari12"],
    cssTarget: ["safari12"]
  },
  server: {
    host: "0.0.0.0",
    port: 5176,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true
      }
    }
  }
});
