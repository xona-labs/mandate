/**
 * File-backed store: one directory per mandate holding the mandate itself,
 * its running state, and the append-only receipt log.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMandate, type Mandate } from "../mandate/schema.js";
import type { Receipt } from "../receipts/index.js";

export interface LedgerEntry {
  at: string;
  kind: "trade" | "research";
  usd: number;
}

export interface MandateState {
  /** Lifetime trade notional under this mandate. */
  tradedUsd: number;
  /** Lifetime research spend. */
  researchUsd: number;
  /** Recent spend, used for the rolling 24h caps. */
  ledger: LedgerEntry[];
  /** Per-rule progress. */
  rules: Record<string, { lastRunAt?: string; fills: number }>;
}

export function emptyState(): MandateState {
  return { tradedUsd: 0, researchUsd: 0, ledger: [], rules: {} };
}

export interface Store {
  loadMandate(): Mandate;
  saveMandate(mandate: Mandate): void;
  loadState(): MandateState;
  saveState(state: MandateState): void;
  appendReceipt(receipt: Receipt): void;
  loadReceipts(): Receipt[];
}

/** Default home for mandates: $MANDATE_HOME or ~/.mandate */
export function mandateHome(): string {
  return process.env.MANDATE_HOME ?? join(homedir(), ".mandate");
}

const MANDATE_FILE = "mandate.json";
const STATE_FILE = "state.json";
const RECEIPTS_FILE = "receipts.jsonl";
/** Ledger entries older than this no longer matter for any rolling cap. */
const LEDGER_KEEP_MS = 48 * 60 * 60 * 1000;

export class FileStore implements Store {
  constructor(private readonly dir: string) {}

  exists(): boolean {
    return existsSync(join(this.dir, MANDATE_FILE));
  }

  loadMandate(): Mandate {
    const file = join(this.dir, MANDATE_FILE);
    if (!existsSync(file)) throw new Error(`mandate: no mandate at ${this.dir}`);
    return parseMandate(JSON.parse(readFileSync(file, "utf8")));
  }

  saveMandate(mandate: Mandate): void {
    this.writeJson(MANDATE_FILE, mandate);
  }

  loadState(): MandateState {
    const file = join(this.dir, STATE_FILE);
    if (!existsSync(file)) return emptyState();
    return { ...emptyState(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<MandateState>) };
  }

  saveState(state: MandateState): void {
    const cutoff = Date.now() - LEDGER_KEEP_MS;
    const ledger = state.ledger.filter((e) => Date.parse(e.at) >= cutoff);
    this.writeJson(STATE_FILE, { ...state, ledger });
  }

  appendReceipt(receipt: Receipt): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, RECEIPTS_FILE), JSON.stringify(receipt) + "\n");
  }

  loadReceipts(): Receipt[] {
    const file = join(this.dir, RECEIPTS_FILE);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Receipt);
  }

  /** Write via rename so a crash never leaves a half-written file. */
  private writeJson(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  }
}

/** In-memory store for tests and embedding hosts that persist elsewhere. */
export class MemoryStore implements Store {
  private state: MandateState = emptyState();
  readonly receipts: Receipt[] = [];

  constructor(private mandate: Mandate) {}

  loadMandate(): Mandate {
    return this.mandate;
  }
  saveMandate(mandate: Mandate): void {
    this.mandate = mandate;
  }
  loadState(): MandateState {
    return structuredClone(this.state);
  }
  saveState(state: MandateState): void {
    this.state = structuredClone(state);
  }
  appendReceipt(receipt: Receipt): void {
    this.receipts.push(receipt);
  }
  loadReceipts(): Receipt[] {
    return [...this.receipts];
  }
}
