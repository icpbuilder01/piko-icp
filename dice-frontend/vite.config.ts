import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { icpBindgen } from "@icp-sdk/bindgen/plugins/vite";
import { execSync } from "child_process";

export default defineConfig(({ command }) => {
  const plugins = [
    react(),
    icpBindgen({
      // The on-chain dice game -- see ../dice/src/main.mo.
      didFile: "../dice/dice.did",
      outDir: "./src/bindings/dice",
    }),
    icpBindgen({
      // PIKO's own ledger -- this site only ever bets PIKO (see
      // Dice.tsx/Wallet.tsx), so unlike the mining site's frontend/, there's
      // no need for the real ICP ledger's interface here at all.
      didFile: "../ledger/ledger.did",
      outDir: "./src/bindings/ledger",
    }),
  ];

  // If we're only building this is enough
  if (command !== "serve") {
    return { plugins };
  }

  // Local dev server: look up the local network's root key and the
  // canister ids this frontend talks to directly, plus the sibling
  // `frontend` canister's id (only used to link back to the mining site).
  const environment = process.env.ICP_ENVIRONMENT || "local";
  const CANISTER_NAMES = ["dice", "ledger", "frontend"];

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
