/* format.js - money, counts, plurals, display names and provenance, shared by every screen.
 *
 * Pure and DOM-free on purpose: every function here computes something a person reads on
 * screen, so each one is unit tested in tests/format-tests.js. No screen writes its own
 * version of any of this - webapp-v2-spec.md section 7b puts `provenance` and the
 * display-name rule here for exactly that reason: two screens would otherwise drift.
 */

const MIN_DISPLAY_NAME = 24;
const MAX_DISPLAY_NAME = 40;
const ELLIPSIS = "…";

/** A whole number with thousands separators: 1238 -> "1,238". */
export function int(n) {
  const value = Number(n) || 0;
  return Math.round(value).toLocaleString("en-US");
}

/**
 * A dollar figure. Whole dollars for the headline money line ("$3,092"); pass
 * `cents: true` for a workbook-matching total, which needs the same two
 * decimal places `report.js` writes ($#,##0.00); pass `unit: true` for a
 * per-each price, at least two decimals and up to four so two prices that
 * only differ past the cent (0.0997 vs 0.095) do not render identically
 * while the accent fill marks one of them cheaper.
 */
export function money(n, { cents = false, unit = false } = {}) {
  const value = Number(n) || 0;
  if (unit) {
    const sign = value < 0 ? "-" : "";
    const [intPart, fracPart] = Math.abs(value)
      .toFixed(4)
      // Keep at least two decimal digits; trim only the trailing zeros past them.
      .replace(/(\.\d{2}\d*?)0+$/, "$1")
      .split(".");
    return `${sign}$${Number(intPart).toLocaleString("en-US")}.${fracPart}`;
  }
  const rounded = cents ? value : Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded).toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
  return `${sign}$${digits}`;
}

/** "1 line" / "2 lines". Every count a screen shows goes through here. */
export function plural(n, word) {
  const count = Number(n) || 0;
  return `${int(count)} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The canonical name cut down to a scannable display name.
 *
 * webapp-v2-spec.md section 5, pinned by the phase-0 ruling (section 7b): never
 * cut before 24 characters; from there, run on to the next comma or opening
 * parenthesis; if that would run past 40, hard cut at 40 with an ellipsis
 * instead. A name that never reaches either boundary is returned whole.
 */
export function truncateCanonical(name) {
  const s = String(name || "").trim();
  if (s.length <= MIN_DISPLAY_NAME) return s;
  const idx = s.slice(MIN_DISPLAY_NAME).search(/[,(]/);
  if (idx !== -1) {
    const cut = MIN_DISPLAY_NAME + idx;
    if (cut <= MAX_DISPLAY_NAME) return s.slice(0, cut).trim();
  }
  if (s.length <= MAX_DISPLAY_NAME) return s;
  return `${s.slice(0, MAX_DISPLAY_NAME).trim()}${ELLIPSIS}`;
}

/**
 * The name a leaderboard, price or done row shows. A model-written
 * `display_name` (section 5, up to 40 characters) wins when present; a blank
 * one falls back to the deterministic truncation, which is what every row has
 * before the model ever runs.
 */
export function displayName(row) {
  const fromModel = String((row && row.display_name) || "").trim();
  if (fromModel) return fromModel;
  return truncateCanonical(row && row.canonical_name);
}

const MAX_DISTINCT_NAME = 60;

/** How much of the start of every string in the group is identical. */
function commonPrefixLength(strings) {
  if (!strings.length) return 0;
  let len = strings[0].length;
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < len && i < s.length && s[i] === strings[0][i]) i += 1;
    len = i;
  }
  return len;
}

/**
 * Display names for a set of rows (the Top N leaderboard, in practice), made
 * distinct when truncation collapses two or more to the same text - three
 * real 2025 rows ("Qeeenar ... 1 Inch(Blue,Initial Here)", "...(Green,Sign &
 * Date)", "...(Yellow,Please Sign Here)") all read "Qeeenar 1250 Pcs Sign and
 * Date Flags He..." otherwise, because the part that differs sits past the
 * 40-character cut. Every row in a colliding group is extended with its own
 * tail - the part of `canonical_name` past what the whole group has in
 * common - in parentheses, the whole name capped at 60 characters. A row
 * that collides with nothing is untouched.
 */
export function distinctDisplayNames(rows) {
  const list = rows || [];
  const base = list.map((row) => displayName(row));
  const groups = new Map();
  base.forEach((name, i) => {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(i);
  });

  const result = base.slice();
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const fullNames = indices.map((i) => String((list[i] && list[i].canonical_name) || "").trim());
    const prefixLen = commonPrefixLength(fullNames);
    indices.forEach((i, n) => {
      const name = base[i].replace(new RegExp(`${ELLIPSIS}$`), "").trim();
      const tail = fullNames[n]
        .slice(prefixLen)
        .replace(/^[,;:\-\s(]+/, "")
        .replace(/\)+$/, "")
        .trim();
      if (!tail) return;
      const suffix = ` (${tail})`;
      const room = Math.max(10, MAX_DISTINCT_NAME - suffix.length);
      const shortened = name.length <= room ? name : name.slice(0, room).trim();
      let extended = `${shortened}${suffix}`;
      if (extended.length > MAX_DISTINCT_NAME) {
        extended = `${extended.slice(0, MAX_DISTINCT_NAME - 1)}${ELLIPSIS}`;
      }
      result[i] = extended;
    });
  }
  return result;
}

/**
 * The one-sentence provenance line for a ranked row's pack size.
 * webapp-v2-spec.md section 2.2: "1,250 per pack, from the title" /
 * "36 per pack, confirmed" / "1 per pack, proposed by the model". `upp_source`
 * is `title` (read directly off the title, carried from history), `proposed`
 * (this run's regex or model answer) or `master` (a person confirmed it); a
 * merged item can carry more than one, joined with "|", and the first is used.
 */
export function provenance(row) {
  const source = String((row && row.upp_source) || "").split("|")[0].trim().toLowerCase();
  const phrase =
    source === "master" ? "confirmed" :
    source === "title" ? "from the title" :
    source === "proposed" ? "proposed by the model" :
    "";
  const raw = String((row && row.units_per_pack) || "").trim();
  const numeric = raw !== "" && Number.isFinite(Number(raw));
  const lead = numeric ? `${int(raw)} per pack` : "pack size varies";
  return phrase ? `${lead}, ${phrase}` : lead;
}

/** A priced value as a number, or null when it is blank or not a number. */
function cleanPrice(value) {
  let text = String(value ?? "").trim();
  if (!text) return null;
  if (text.startsWith("$")) text = text.slice(1).trim();
  text = text.split(",").join("");
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * The Results/Done money line. webapp-v2-spec.md section 4: over the Top N
 * items priced at Amazon and at least one other vendor, the sum of
 * (Amazon price minus the cheapest priced vendor) times eaches.
 *
 * @param {object[]} ranked
 * @param {object[]} priceRows
 * @param {number} top
 * @returns {{amount: number, itemsCounted: number, basisSentence: string}}
 */
export function moneyLine(ranked, priceRows, top) {
  const byName = new Map();
  for (const row of priceRows || []) {
    if (String(row.status || "").trim() !== "priced") continue;
    const price = cleanPrice(row.unit_price);
    if (price === null) continue;
    const name = row.canonical_name;
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name).set(row.vendor, price);
  }

  let total = 0;
  let itemsCounted = 0;
  for (const item of ranked || []) {
    const rank = Number(item.rank);
    if (!Number.isFinite(rank) || rank > Number(top)) continue;
    const prices = byName.get(item.canonical_name);
    if (!prices || !prices.has("Amazon") || prices.size < 2) continue;
    const amazonPrice = prices.get("Amazon");
    const cheapest = Math.min(...prices.values());
    const eaches = Number(item.eaches) || 0;
    total += (amazonPrice - cheapest) * eaches;
    itemsCounted += 1;
  }

  const amount = Math.round(total);
  const basisSentence =
    amount > 0
      ? "on the table this year. Buying each item at its cheapest vendor instead of Amazon, " +
        `over the ${plural(itemsCounted, "item")} priced at both, at today's list prices.`
      : "Amazon was already cheapest on every item priced.";
  return { amount, itemsCounted, basisSentence };
}
