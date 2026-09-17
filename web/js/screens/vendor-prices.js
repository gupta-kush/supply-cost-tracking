/* The one place that decides what a vendor price is worth.
 *
 * Both screens show the same four vendors and both mark the cheapest one, and they
 * were drifting: the leaderboard filled a single pill and the price card lit a
 * single rule, so a tie silently named a winner that did not exist. Two prices a
 * tenth of a cent apart are ordinary in the real export (`last paid per each:
 * 0.0112`), which is also why the pill and the field both print four decimals.
 *
 * Nothing here touches the DOM or state. It is arithmetic the two screens share.
 */

export const VENDORS = ["Office Depot", "Preferred", "Amazon", "Staples"];

/** How a cell with no price reads: plain words, never a validator code. */
export const PILL_WORDS = {
  not_available: "not available",
  discontinued: "discontinued",
  unpriced: "not priced",
};

/** A price as a number, or null when it is blank, a status or not a number. */
export function toNumber(value) {
  const text = String(value ?? "").trim().replace("$", "").split(",").join("");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * The cheapest vendors across one item's price rows.
 *
 * Returns **every** vendor sitting at the minimum, not the first one in vendor
 * order. A tie is a real answer: four vendors at the same price means nobody is
 * cheaper, and filling one of them says the opposite. The caller decides how many
 * prices it wants before it marks anything, because the two screens differ there:
 * the leaderboard marks the cheapest of whatever is priced, and the price card
 * waits for two so the comparison means something while she is still typing.
 *
 * @param {Map<string, {unit_price?: string, status?: string}>} byVendor
 * @returns {{best: Set<string>, priced: number, value: number|null}}
 */
export function cheapestVendors(byVendor) {
  const priced = [];
  for (const vendor of VENDORS) {
    const row = byVendor.get(vendor);
    if (!row || String(row.status || "") !== "priced") continue;
    const value = toNumber(row.unit_price);
    if (value !== null) priced.push([vendor, value]);
  }
  if (!priced.length) return { best: new Set(), priced: 0, value: null };

  const lowest = Math.min(...priced.map(([, value]) => value));
  const best = new Set(priced.filter(([, value]) => value === lowest).map(([v]) => v));
  return { best, priced: priced.length, value: lowest };
}
