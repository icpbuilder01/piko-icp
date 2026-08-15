import { useCallback, useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { getCasinoActor } from "./lib/actors";
import { login, logout, getStoredIdentity } from "./lib/auth";
import { frontendUrl } from "./lib/canister-env";
import { formatPiko, shortPrincipal } from "./lib/format";
import { Dice } from "./components/Dice";
import { Wallet } from "./components/Wallet";
import type { Stats, RecentBet, LeaderboardEntry } from "./bindings/casino/casino";
import "./App.css";

const POLL_MS = 5000;

function formatCycles(raw: bigint): string {
  const t = Number(raw) / 1e12;
  return `${t.toFixed(2)}T`;
}

function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentBets, setRecentBets] = useState<RecentBet[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  useEffect(() => {
    getStoredIdentity().then((id) => setIdentity(id));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const casino = getCasinoActor();
      const [s, bets, lb] = await Promise.all([casino.getStats(), casino.getRecentBets(), casino.getLeaderboard()]);
      setStats(s);
      setRecentBets(bets.slice().reverse());
      setLeaderboard(lb);
    } catch (err) {
      console.error("Failed to refresh casino stats", err);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling on-chain state, not derived
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleLogin() {
    const id = await login();
    setIdentity(id);
  }

  async function handleLogout() {
    await logout();
    setIdentity(null);
  }

  return (
    <main className="page">
      <header className="header">
        <div className="brand">
          <span className="section-icon dice-icon" style={{ fontSize: "1.4rem" }}>
            &#127922;
          </span>
          <div className="brand-text">
            <span className="brand-name">PIKO Dice</span>
            <span className="brand-ticker">
              {stats ? (
                <>
                  <span className="pulse-dot" /> {stats.betsPlaced.toString()} bets so far, live
                </>
              ) : (
                "Provably fair · fully on-chain"
              )}
            </span>
          </div>
        </div>
        <div className="wallet-box">
          {identity ? (
            <>
              <span className="principal-pill">{shortPrincipal(identity.getPrincipal().toText())}</span>
              <button className="button secondary" onClick={handleLogout}>
                Log out
              </button>
            </>
          ) : (
            <button className="button" onClick={handleLogin}>
              Log in with Internet Identity
            </button>
          )}
        </div>
      </header>

      <div className="disclaimer disclaimer-strong">
        <strong>This is a betting game, not an investment.</strong> Bets are PIKO-only. Every losing
        roll's stake is burned into the bankroll, non-refundable, the same way PIKO's mining fee is.
        There's no PIKO market yet (no DEX listing), so winnings are still just PIKO -- only play with
        what you're fully fine losing.
      </div>

      <section className="hero">
        <div className="tag-row">
          <span className="tag">Provably fair</span>
          <span className="tag">PIKO only</span>
          <span className="tag spark">100% on-chain</span>
        </div>
        <h1>Roll the dice. &#127922; Win instantly.</h1>
        <p>
          A companion game to{" "}
          <a href={frontendUrl} target="_blank" rel="noopener noreferrer">
            PIKO mining
          </a>{" "}
          -- somewhere for PIKO to actually be used, not just mined and held. Same non-affiliation note
          as the rest of the project: an independent build, not affiliated with any other dice or mining
          site.
        </p>
      </section>

      {identity && <Wallet identity={identity} />}

      <Dice identity={identity} />

      <section className="block story-block">
        <h2>
          <span className="section-icon">⚙️</span>How it works
        </h2>
        <ul className="tech-list">
          <li>
            Pick a target between 2 and 98. Rolling <strong>under</strong> your target wins; the lower
            the target, the higher the payout multiplier -- standard "roll under" odds, the same shape
            used by most provably-fair dice sites.
          </li>
          <li>
            <strong>1% house edge, fixed in the code, never admin-adjustable.</strong> Payout = your
            stake &times; 99 / target. Win chance = target%. Expected return over many rolls: 99%.
          </li>
          <li>
            Your stake is pulled from your own balance (you approve it first, like mining's ICP fee)
            <em> before</em> the result is drawn from the Internet Computer's own on-chain randomness
            (<code>raw_rand</code>). There's no point where the outcome is known and either side can
            still back out.
          </li>
          <li>
            Every bet is sized against the game's <em>real, live</em> bankroll -- if a payout would be
            too large for what the bankroll can currently cover, the bet is rejected outright rather than
            accepted and risked.
          </li>
          <li>
            This canister funds its own cycles the same self-funding pattern as PIKO's own mining
            coordinator -- no off-chain top-ups needed to keep it running.
          </li>
          <li>No backend, no database, nothing off-chain -- same as the rest of PIKO.</li>
        </ul>
      </section>

      <section className="block">
        <h2 className="spark">
          <span className="section-icon">💰</span>Bankroll &amp; stats
        </h2>
        {stats ? (
          <div className="stat-grid">
            <div className="stat-tile">
              <div className="stat-label">Bets placed</div>
              <div className="stat-value">{stats.betsPlaced.toString()}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Bets won</div>
              <div className="stat-value">{stats.betsWon.toString()}</div>
            </div>
            <div className="stat-tile stat-tile-wide">
              <div className="stat-label token-label">
                <img src="/piko-logo.svg" alt="" className="token-icon" />
                PIKO bankroll
              </div>
              <div className="stat-value">{formatPiko(stats.pikoBankroll)}</div>
            </div>
            <div className="stat-tile stat-tile-wide">
              <div className="stat-label">Cycles</div>
              <div className="stat-value stat-value-small">{formatCycles(stats.cyclesBalance)}</div>
            </div>
          </div>
        ) : (
          <div className="empty-state">Loading table stats...</div>
        )}
      </section>

      <section className="block">
        <h2>
          <span className="section-icon">🏆</span>Top players
        </h2>
        {leaderboard.length > 0 ? (
          <table className="blocks">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>PIKO wagered</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((entry, i) => (
                <tr key={entry.player.toText()}>
                  <td className={i < 3 ? `rank-${i + 1}` : ""}>{i + 1}</td>
                  <td className="mono">{shortPrincipal(entry.player.toText())}</td>
                  <td>{formatPiko(entry.wageredPiko)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No one's rolled yet -- be the first.</div>
        )}
      </section>

      <section className="block">
        <div className="miner-panel-head">
          <h2 className="spark">
            <span className="section-icon">🎲</span>Recent rolls
          </h2>
          {recentBets.length > 0 && (
            <span className="live-pill">
              <span className="live-dot" /> live feed
            </span>
          )}
        </div>
        {recentBets.length > 0 ? (
          <table className="blocks">
            <thead>
              <tr>
                <th>Player</th>
                <th>Target</th>
                <th>Roll</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {recentBets.map((b, i) => (
                <tr key={i}>
                  <td className="mono">{shortPrincipal(b.player.toText())}</td>
                  <td>{b.target.toString()}</td>
                  <td>{b.roll.toString()}</td>
                  <td className={b.won ? "good" : ""}>
                    {b.won ? `+${formatPiko(b.payoutAmount)} PIKO` : "lost"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No rolls yet.</div>
        )}
      </section>

      <footer className="footer">
        <p>
          PIKO Dice is open-source and entirely hosted on the Internet Computer -- no servers, no
          database. Same non-affiliation note as the rest of PIKO: an independent, original build.
        </p>
        <p className="footer-links">
          <a href={frontendUrl} target="_blank" rel="noopener noreferrer">
            &larr; Back to PIKO mining
          </a>{" "}
          &nbsp;&middot;&nbsp;{" "}
          <a href={`${frontendUrl}dashboard.html`} target="_blank" rel="noopener noreferrer">
            Chain dashboard
          </a>
        </p>
      </footer>
    </main>
  );
}

export default App;
