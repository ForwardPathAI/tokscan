import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOKSCAN_DIR } from "./paths.ts";
import type { Call } from "./types.ts";

const PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
type Prices = Record<string, Record<string, any>>;

export async function loadPrices(refresh = false): Promise<Prices> {
  mkdirSync(TOKSCAN_DIR, { recursive: true });
  const file = path.join(TOKSCAN_DIR, "prices.json");
  const stale = !existsSync(file) || Date.now() - statSync(file).mtimeMs > 86_400_000;
  if (refresh || stale) {
    try {
      const r = await fetch(PRICES_URL, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(file, await r.text());
    } catch (e) {
      if (!existsSync(file)) {
        console.error(`warn: no price list (${(e as Error).message}); costs left blank`);
        return {};
      }
    }
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

export function findPrice(prices: Prices, model: string): Record<string, any> | null {
  if (!model) return null;
  const m = ALIASES[model] ?? model;
  let base = m.split("/").pop()!.replace(/^~/, "");
  if (base.startsWith("claude-")) base = base.replace(/\./g, "-"); // opencode: claude-sonnet-5.5
  const cands = [m, base, base.replace(/-\d{8}$/, ""), base.replace(/\[.*\]$/, "")];
  for (const c of cands) if (prices[c]?.input_cost_per_token != null) return prices[c]!;
  for (const [k, v] of Object.entries(prices)) {
    if (k.endsWith("/" + base) && v?.input_cost_per_token != null) return v;
  }
  return null;
}

/** Price one call at API list rates. Returns null if the model is unknown. */
export function priceCall(c: Call, prices: Prices): number | null {
  if (c.cost != null) return c.cost;
  const p = findPrice(prices, c.model);
  if (!p) return null;

  // Long-context tier ("..._above_272k_tokens"): use the highest one this prompt crosses.
  const prompt = c.input + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h;
  let tier = 0;
  for (const k of Object.keys(p)) {
    const m = k.match(/^input_cost_per_token_above_(\d+)k_tokens$/);
    if (m && prompt > Number(m[1]) * 1000 && Number(m[1]) > tier) tier = Number(m[1]);
  }
  const sfx = tier ? `_above_${tier}k_tokens` : "";
  const rate = (name: string): number | undefined => (sfx && p[name + sfx] != null ? p[name + sfx] : p[name]);

  const inp = rate("input_cost_per_token") ?? 0;
  const out = rate("output_cost_per_token") ?? 0;
  const cr = rate("cache_read_input_token_cost") ?? inp * 0.1;
  const cw = rate("cache_creation_input_token_cost") ?? inp * 1.25;
  const cw1h = p.cache_creation_input_token_cost_above_1hr ?? inp * 2;
  return c.input * inp + c.output * out + c.cacheRead * cr + c.cacheWrite5m * cw + c.cacheWrite1h * cw1h;
}
