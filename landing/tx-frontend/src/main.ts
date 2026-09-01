import { createActor } from "./bindings/index/index";
import { indexCanisterId, rootKey } from "./lib/canister-env";

// Read-only, no login: this page never signs a call, it only ever issues
// anonymous query calls against the `index` canister (see ../../../index/),
// same "no login, no approval, nothing at stake here" posture as the rest
// of `landing` (see WHITEPAPER.md &sect;7).
const index = createActor(indexCanisterId, { agentOptions: { rootKey } });

const root = document.getElementById("root")!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Renders one `Value` (see index-ng.did: `variant { Blob; Text; Nat; Nat64;
// Int; Array; Map }`) recursively, matching the .value-map/.value-array
// styling in index.html. `Map` is `vec record { text; Value }` -- an
// unnamed 2-field record, which the generated bindings decode as a plain
// [text, Value] tuple per entry.
function renderValue(v: { __kind__: string; [key: string]: unknown }): Node {
  switch (v.__kind__) {
    case "Blob":
      return document.createTextNode(hex(v.Blob as Uint8Array));
    case "Text":
      return document.createTextNode(v.Text as string);
    case "Nat":
    case "Nat64":
    case "Int":
      return document.createTextNode(String(v[v.__kind__]));
    case "Array": {
      const items = v.Array as { __kind__: string; [key: string]: unknown }[];
      if (items.length === 0) return document.createTextNode("(empty)");
      return el(
        "ul",
        { className: "value-array" },
        items.map((item) => el("li", {}, [renderValue(item)])),
      );
    }
    case "Map": {
      const entries = v.Map as [string, { __kind__: string; [key: string]: unknown }][];
      const table = el("table", { className: "value-map" });
      const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
      for (const [key, value] of sorted) {
        table.append(
          el("tr", {}, [
            el("td", { className: "key" }, [key]),
            el("td", {}, [renderValue(value)]),
          ]),
        );
      }
      return table;
    }
    default:
      return document.createTextNode(`(unrecognized value kind: ${v.__kind__})`);
  }
}

function parseIndex(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

async function lookup(i: bigint) {
  resultEl.replaceChildren(el("p", { className: "muted" }, ["Loading…"]));
  const url = new URL(window.location.href);
  url.searchParams.set("i", i.toString());
  window.history.replaceState(null, "", url);

  try {
    const response = await index.get_blocks({ start: i, length: 1n });
    const chainLength = response.chain_length;
    if (response.blocks.length === 0) {
      resultEl.replaceChildren(
        el("p", { className: "error" }, [
          `Block #${i} not found -- the chain currently has ${chainLength} block(s), indices 0..${
            chainLength > 0n ? chainLength - 1n : 0n
          }.`,
        ]),
      );
      return;
    }
    resultEl.replaceChildren(
      el("h1", {}, [`Block #${i}`]),
      renderValue(response.blocks[0]),
      el("div", { className: "nav-row" }, [
        el(
          "button",
          {
            disabled: i <= 0n,
            onclick: () => lookup(i - 1n),
          },
          ["← Previous"],
        ),
        el(
          "button",
          {
            disabled: i + 1n >= chainLength,
            onclick: () => lookup(i + 1n),
          },
          ["Next →"],
        ),
      ]),
    );
  } catch (e) {
    resultEl.replaceChildren(
      el("p", { className: "error" }, [
        `Lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      ]),
    );
  }
}

const input = el("input", {
  type: "text",
  placeholder: "Block index, e.g. 0",
  inputMode: "numeric",
});
const button = el("button", { type: "button" }, ["Look up"]);
const resultEl = el("div", { className: "result" });

function submit() {
  const i = parseIndex(input.value);
  if (i === null) {
    resultEl.replaceChildren(
      el("p", { className: "error" }, ["Enter a non-negative whole number."]),
    );
    return;
  }
  void lookup(i);
}

button.addEventListener("click", submit);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submit();
});

root.append(
  el("h1", {}, ["PIKO Transaction Lookup"]),
  el("p", { className: "muted" }, [
    "Look up any PIKO ledger block by index, read directly from the on-chain ",
    el("span", { className: "mono" }, ["index"]),
    " canister -- no login, nothing cached.",
  ]),
  el("div", { className: "lookup-row" }, [input, button]),
  resultEl,
);

const initial = parseIndex(new URL(window.location.href).searchParams.get("i") ?? "");
if (initial !== null) {
  input.value = initial.toString();
  void lookup(initial);
} else {
  void lookup(0n);
}
