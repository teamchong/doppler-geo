import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "doppler-geo",
		compatibilityDate: "2026-10-01",
		entrypoint: "worker/index.js",
		assets: {
			runWorkerFirst: [
				"/api/*",
			],
		},
		domains: [
			"doppler.teamchong.net",
		],
		env: {
			ASSETS: bindings.assets(),
		},
	},
});
