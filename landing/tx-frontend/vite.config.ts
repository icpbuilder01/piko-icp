import { defineConfig } from "vite";
import { icpBindgen } from "@icp-sdk/bindgen/plugins/vite";
import { execSync } from "child_process";

export default defineConfig(({ command }) => {
  // This page is served from ../public/tx/ within the `landing` canister
  // (not its own canister, unlike dice-frontend/blackjack-frontend -- see
  // README.md), so its asset URLs need the /tx/ prefix or they'd resolve
  // against landing's root instead.
  const base = "/tx/";

  const plugins = [
    icpBindgen({
      // The official ICRC-1 index-ng canister -- see ../../index/. Used
      // read-only here: get_blocks() is what this page actually looks
      // transactions up with. Points at a gitignored local copy
      // (./index.did, made by the pre{dev,build} npm script) rather than
      // ../../index/index-ng.did directly, because @icp-sdk/bindgen derives
      // its generated TypeScript interface name straight from the .did
      // filename with no sanitization -- the real file's hyphenated name
      // ("index-ng") produces an invalid `interface 'index-ngInterface'`
      // identifier and fails the build. The vendored original stays
      // untouched (its filename is part of what canister.yaml's own
      // provenance comment verifies).
      didFile: "./index.did",
      outDir: "./src/bindings/index",
    }),
  ];

  // If we're only building this is enough. `base` only applies here, not
  // to the dev server below -- during `npm run dev` this project is served
  // standalone at its own root, not proxied under /tx/.
  if (command !== "serve") {
    return { base, plugins };
  }

  // Local dev server: look up the local network's root key and this
  // page's one canister dependency's id, same pattern as the other
  // frontends in this workspace (see e.g. ../../dice-frontend/vite.config.ts).
  const environment = process.env.ICP_ENVIRONMENT || "local";
  const CANISTER_NAMES = ["index"];

  const networkStatus = JSON.parse(
    execSync(`icp network status -e ${environment} --json`, { encoding: "utf-8" })
  );
  const rootKey: string = networkStatus.root_key;
  const proxyTarget: string = networkStatus.api_url;

  const idPairs = CANISTER_NAMES.map((name) => {
    try {
      const canisterId = execSync(`icp canister status ${name} -e ${environment} -i`, {
        encoding: "utf-8",
      }).trim();
      return `PUBLIC_CANISTER_ID:${name}=${canisterId}`;
    } catch {
      console.error(`
       Canister "${name}" not found in environment "${environment}"

       Before running the dev server, deploy it:

         icp deploy ${name} -e ${environment}
      `);
      process.exit(1);
    }
  });

  const server = {
    headers: {
      "Set-Cookie": `ic_env=${encodeURIComponent(
        `${idPairs.join("&")}&ic_root_key=${rootKey}`
      )}; SameSite=Lax;`,
    },
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  };

  return { plugins, server };
});
