// Bundles the frontend into dist/: app.js plus the lazily imported jsqr.js and ristretto.js.
import { build } from "esbuild";
import { resolveConfig } from "./config.mjs";

let config;
try {
  config = resolveConfig(process.env);
} catch (err) {
  console.error(`build setting ${err.message}`);
  process.exit(1);
}

const common = { bundle: true, minify: true, format: "esm", target: ["chrome120", "firefox120", "safari17"] };

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main.ts"],
    outfile: "dist/app.js",
    external: ["/jsqr.js", "/ristretto.js"],
    define: { BUILD_CONFIG: JSON.stringify(config) },
  }),
  build({ ...common, entryPoints: ["node_modules/jsqr/dist/jsQR.js"], outfile: "dist/jsqr.js" }),
  build({ ...common, entryPoints: ["src/crypto/ristretto.ts"], outfile: "dist/ristretto.js" }),
]);
