import { useEffect, useState } from "react";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { rootKey } from "../lib/canister-env";

// PikoPixel's canister (~/pikoplace) -- a separate project, so a fixed
// mainnet id rather than something from canister-env. Only read here.
const PLACE_CANISTER_ID = "cpihg-xqaaa-aaaac-bf4ba-cai";
const PIKOPIXEL_URL = "https://cglm2-byaaa-aaaac-bf4aq-cai.icp0.io/";

const POLL_MS = 60_000;
const ROTATE_MS = 8_000;

interface Ad {
  text: string;
  link: [] | [string];
  suspicious: boolean;
}

// Hand-written subset of place.did: only getActiveAds, and only the Ad
// fields the banner shows (Candid lets a reader ignore the rest).
const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Ad = IDL.Record({ text: IDL.Text, link: IDL.Opt(IDL.Text), suspicious: IDL.Bool });
  return IDL.Service({ getActiveAds: IDL.Func([], [IDL.Vec(Ad)], ["query"]) });
};

function getPlaceActor() {
  const agent = HttpAgent.createSync({ host: "https://icp-api.io", rootKey });
  return Actor.createActor<{ getActiveAds: () => Promise<Ad[]> }>(idlFactory, {
    agent,
    canisterId: PLACE_CANISTER_ID,
  });
}

// Sponsored text slots rented on PikoPixel by burning PIKO. Nobody reviews
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
    <aside className="sponsored-banner" aria-label="Sponsored">
      <span className="sponsored-label">
        Sponsored · not verified by PIKO · do your own research ·{" "}
        <a href={PIKOPIXEL_URL} target="_blank" rel="noopener noreferrer">
          rent this slot on PikoPixel
        </a>
      </span>
      {ad.suspicious && (
        <span className="sponsored-warning">⚠ Reported as suspicious by several players -- be extra careful</span>
      )}
      <span className="sponsored-text">{ad.text}</span>
      {link && (
        <a className="sponsored-link" href={link} target="_blank" rel="noopener noreferrer nofollow">
          {link}
        </a>
      )}
    </aside>
  );
}
