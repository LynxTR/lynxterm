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
  compatibilityDate: "2026-10-01",
});
