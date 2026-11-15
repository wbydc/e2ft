// Bundles the frontend into dist/: app.js plus the lazily imported jsqr.js and ristretto.js.
import { build } from "esbuild";

const common = { bundle: true, minify: true, format: "esm", target: ["chrome120", "firefox120", "safari17"] };

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main.ts"],
    outfile: "dist/app.js",
    external: ["/jsqr.js", "/ristretto.js"],
  }),
  build({ ...common, entryPoints: ["node_modules/jsqr/dist/jsQR.js"], outfile: "dist/jsqr.js" }),
  build({ ...common, entryPoints: ["src/crypto/ristretto.ts"], outfile: "dist/ristretto.js" }),
]);
