import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

// Dev port set away from 5173 (sentropic / top-ai-ideas dev UI) and 5174
// (sentropic's playwright dev UI). Override with PORT=... when running
// `npm run dev` if you need a different one.
const DEV_PORT = Number(process.env.PORT ?? "5180");

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  preview: {
    port: DEV_PORT,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
  },
});
