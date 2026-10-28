export default defineNuxtConfig({
  ssr: false, // Tauri serves generated static files
  modules: ["@nuxt/ui"],
  css: ["~/assets/css/main.css"],
  colorMode: { preference: "dark" },
  // Bundle every icon code names; app never fetches from Iconify API.
  icon: {
    clientBundle: { scan: { globInclude: ["app/**/*.{vue,ts}"] } },
    provider: "none",
  },
  ignore: ["**/src-tauri/**"],
  vite: {
    build: {
      // Fig specs (aws, gcloud, az up to ~4 MB) load lazily from local files per command.
      chunkSizeWarningLimit: 5000,
      // Build-speed note, not an output problem.
      rolldownOptions: { checks: { bundlerTimings: false } },
    },
  },
  compatibilityDate: "2026-10-01",
});
