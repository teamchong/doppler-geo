import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "doppler-geo",
    compatibilityDate: "2026-10-01",
    entrypoint: "worker/index.js",
    assets: {
      runWorkerFirst: ["/api/*"],
    },
    ...(process.env.CF_DOMAIN ? { domains: [process.env.CF_DOMAIN] } : {}),
    env: {
      ASSETS: bindings.assets(),
      LIVE_TRACKER: bindings.durableObject({
        className: "LiveTrackerDO",
      }),
    },
  },
});
