import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    rules: {
      // Terminal code matches escape sequences on purpose.
      "no-control-regex": "off",
    },
  },
});
