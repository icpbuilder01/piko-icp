import { useEffect, useRef, useState } from "react";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { rootKey } from "../lib/canister-env";

// PikoPixel's canister (~/pikoplace) -- a separate project, so a fixed
// mainnet id rather than something from canister-env. Only read here.
const PLACE_CANISTER_ID = "cpihg-xqaaa-aaaac-bf4ba-cai";
const PIKOPIXEL_URL = "https://cglm2-byaaa-aaaac-bf4aq-cai.icp0.io/";

// Same 18 colors as PikoPixel's canvas (pikoplace/place-frontend/src/lib/
// palette.ts): ad images are 64x32 indices into it.
const PALETTE = [
  "#ffffff", "#d4d7d9", "#898d90", "#000000",
  "#be0039", "#ff4500", "#ffa800", "#ffd635",
  "#00a368", "#7eed56", "#009eaa", "#2450a4",
  "#3690ea", "#51e9f4", "#811e9f", "#b44ac0",
  "#ff99aa", "#6d482f",
];
const IMAGE_WIDTH = 64;
const IMAGE_HEIGHT = 32;

const POLL_MS = 60_000;
const ROTATE_MS = 8_000;

interface Ad {
  text: string;
  link: [] | [string];
  suspicious: boolean;
  image: [] | [Uint8Array | number[]];
}

// Hand-written subset of place.did: only getActiveAds, and only the Ad
// fields the banner shows (Candid lets a reader ignore the rest).
const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Ad = IDL.Record({
    text: IDL.Text,
    link: IDL.Opt(IDL.Text),
    suspicious: IDL.Bool,
    image: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  return IDL.Service({ getActiveAds: IDL.Func([], [IDL.Vec(Ad)], ["query"]) });
};

function getPlaceActor() {
  const agent = HttpAgent.createSync({ host: "https://icp-api.io", rootKey });
  return Actor.createActor<{ getActiveAds: () => Promise<Ad[]> }>(idlFactory, {
    agent,
    canisterId: PLACE_CANISTER_ID,
  });
}

function AdImage({ image }: { image: Uint8Array | number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    for (let i = 0; i < IMAGE_WIDTH * IMAGE_HEIGHT; i++) {
      ctx.fillStyle = PALETTE[image[i]] ?? PALETTE[0];
      ctx.fillRect(i % IMAGE_WIDTH, Math.floor(i / IMAGE_WIDTH), 1, 1);
    }
  }, [image]);
  return <canvas ref={ref} className="board-image" width={IMAGE_WIDTH} height={IMAGE_HEIGHT} />;
}

// Sponsored slots rented on PikoPixel by burning PIKO. Nobody reviews
// them, hence the label. Errors just mean no banner -- mining never
// depends on this.
export function SponsoredBanner() {
  const [ads, setAds] = useState<Ad[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const actor = getPlaceActor();
    const load = () =>
      actor
        .getActiveAds()
        .then(setAds)
        .catch(() => setAds([]));
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (ads.length < 2) return;
    const id = setInterval(() => setIndex((i) => i + 1), ROTATE_MS);
    return () => clearInterval(id);
  }, [ads.length]);

  if (ads.length === 0) return null;
  const ad = ads[index % ads.length];
  const link = ad.link[0];
  return (
    <aside className="board-strip" aria-label="Community board">
      <span className="board-strip-label">
        Sponsored · not verified by PIKO · do your own research ·{" "}
        <a href={PIKOPIXEL_URL} target="_blank" rel="noopener noreferrer">
          rent this slot on PikoPixel
        </a>
      </span>
      {ad.suspicious && (
        <span className="board-warning">⚠ Reported as suspicious by several players -- be extra careful</span>
      )}
      {ad.image[0] && <AdImage image={ad.image[0]} />}
      <span className="board-strip-text">{ad.text}</span>
      {link && (
        <a className="board-strip-link" href={link} target="_blank" rel="noopener noreferrer nofollow">
          {link}
        </a>
      )}
    </aside>
  );
}
