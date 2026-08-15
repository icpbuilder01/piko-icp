import { useCallback, useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getLedgerActor, getIcpLedgerActor } from "../lib/actors";
import { formatPiko, formatIcp, parseAmount, shortPrincipal } from "../lib/format";

interface WalletProps {
  identity: Identity;
}

type Token = "PIKO" | "ICP";

export function Wallet({ identity }: WalletProps) {
  const principalText = identity.getPrincipal().toText();
  const [pikoBalance, setPikoBalance] = useState<bigint | null>(null);
  const [icpBalance, setIcpBalance] = useState<bigint | null>(null);
  const [token, setToken] = useState<Token>("PIKO");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const owner = identity.getPrincipal();
      const [piko, icp] = await Promise.all([
        getLedgerActor().icrc1_balance_of({ owner }),
        getIcpLedgerActor().icrc1_balance_of({ owner }),
      ]);
      setPikoBalance(piko as unknown as bigint);
      setIcpBalance(icp as unknown as bigint);
    } catch (err) {
      console.error("Failed to refresh wallet balances", err);
    }
  }, [identity]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ledger canisters, not derived state
    refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleCopy() {
    await navigator.clipboard.writeText(principalText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const amount = parseAmount(sendAmount);
    if (amount === null || amount <= 0n) {
      setSendStatus("Enter a valid amount.");
      return;
    }
    let toPrincipal: Principal;
    try {
      toPrincipal = Principal.fromText(sendTo.trim());
    } catch {
      setSendStatus("Enter a valid principal.");
      return;
    }

    setSending(true);
    setSendStatus(null);
    try {
      const actor = token === "PIKO" ? getLedgerActor(identity) : getIcpLedgerActor(identity);
      const result = (await actor.icrc1_transfer({
        to: { owner: toPrincipal },
        amount,
      })) as { Ok: bigint } | { Err: Record<string, unknown> };
      if ("Ok" in result) {
        setSendStatus(`Sent ${token === "PIKO" ? formatPiko(amount) : formatIcp(amount)} ${token}.`);
        setSendTo("");
        setSendAmount("");
        refresh();
      } else {
        setSendStatus(`Failed: ${JSON.stringify(result.Err)}`);
      }
    } catch (err) {
      console.error("Send failed", err);
      setSendStatus("Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="block wallet-panel">
      <h2>
        Wallet <span className="section-icon">🪙</span>
      </h2>
      <div className="wallet-balances">
        <div className="wallet-balance-tile">
          <div className="stat-label token-label">
            <img src="/piko-logo.svg" alt="" className="token-icon" />
            PIKO
          </div>
          <div className="stat-value">{pikoBalance !== null ? formatPiko(pikoBalance) : "..."}</div>
        </div>
        <div className="wallet-balance-tile">
          <div className="stat-label token-label">
            <img src="/icp-logo.svg" alt="" className="token-icon" />
            ICP
          </div>
          <div className="stat-value">{icpBalance !== null ? formatIcp(icpBalance) : "..."}</div>
        </div>
      </div>

      <div className="wallet-receive">
        <div className="stat-label">Your address (receives both PIKO and ICP)</div>
        <div className="wallet-address-row">
          <code className="wallet-address">{principalText}</code>
          <button type="button" className="button secondary small" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <form className="wallet-send" onSubmit={handleSend}>
        <div className="token-toggle" role="tablist" aria-label="Token">
          <button
            type="button"
            role="tab"
            aria-selected={token === "PIKO"}
            className={`token-toggle-btn ${token === "PIKO" ? "active" : ""}`}
            onClick={() => setToken("PIKO")}
          >
            <img src="/piko-logo.svg" alt="" className="token-icon" />
            Send PIKO
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={token === "ICP"}
            className={`token-toggle-btn ${token === "ICP" ? "active" : ""}`}
            onClick={() => setToken("ICP")}
          >
            <img src="/icp-logo.svg" alt="" className="token-icon" />
            Send ICP
          </button>
        </div>
        <input
          className="input"
          placeholder="Recipient principal"
          value={sendTo}
          onChange={(e) => setSendTo(e.target.value)}
        />
        <div className="wallet-send-row">
          <input
            className="input"
            placeholder={`Amount (${token})`}
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
            inputMode="decimal"
          />
          <button type="submit" className="button" disabled={sending}>
            {sending ? "Sending..." : `Send ${token}`}
          </button>
        </div>
        {sendStatus && <p className="wallet-status">{sendStatus}</p>}
        <p className="wallet-hint">
          Principal: {shortPrincipal(principalText)} -- transfers use the standard
          ICRC-1 ledger fee (0.0001 {token}).
        </p>
      </form>
    </section>
  );
}
