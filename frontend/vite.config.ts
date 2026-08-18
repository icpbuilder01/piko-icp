import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { icpBindgen } from "@icp-sdk/bindgen/plugins/vite";
import { execSync } from "child_process";

export default defineConfig(({ command }) => {
  const plugins = [
    react(),
    icpBindgen({
      didFile: "../mother/mother.did",
      outDir: "./src/bindings/mother",
    }),
    icpBindgen({
      didFile: "../ledger/ledger.did",
      outDir: "./src/bindings/ledger",
    }),
    icpBindgen({
      // Hand-written subset of the real mainnet ICP ledger's interface --
      // it's not a canister this project builds/deploys, see idl/icp_ledger.did.
      didFile: "./idl/icp_ledger.did",
      outDir: "./src/bindings/icp_ledger",
    }),
  ];

  // Two static pages in one canister: the main site (index.html) and the
  // read-only monitoring dashboard (dashboard.html) -- Rollup needs every
  // HTML entry listed explicitly, unlike vite's dev server which serves any
  // .html file by path with no config. PIKO Dice is a deliberately separate
  // site/canister (see dice-frontend/), not a third page here.
  const build = {
    rollupOptions: {
      input: {
        main: "index.html",
        dashboard: "dashboard.html",
      },
    },
  };

  // If we're only building this is enough
  if (command !== "serve") {
    return { plugins, build };
  }

  // Local dev server: look up the local network's root key and the
  // canister ids for both canisters the frontend talks to directly.
  const environment = process.env.ICP_ENVIRONMENT || "local";
  const CANISTER_NAMES = ["mother", "ledger"];

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

  return {
    plugins,
    server,
  };
});
