/* The suggestion provider seam for the review step.
 *
 * Two providers sit behind one interface. `regexProvider` is the one that
 * always works: it is the deterministic pipeline, wrapped, with no key, no
 * network and no waiting. `makeApiProvider` asks a model, and exists because
 * the regex cannot read "5 Dozen" as 60, cannot know that a carton of paper is
 * counted in reams, and cannot tell that two listings a year apart are the same
 * pen. That is the whole of what a model adds here.
 *
 * Both return the same thing: the queue rows back, with the suggestion columns
 * filled in and two columns added, `confidence` and `proposed_by`. Nothing here
 * writes to the item master; a person still reads the rows and applies them.
 *
 * The request bodies, the prompt and the merge rules are the same as the Python
 * `supplytrack/propose.py`, and `web/tests/suggest-tests.js` proves it against
 * the same fixtures the Python tests use.
 *
 * No DOM access in this file, on purpose: it has to run under plain `node` for
 * those tests. The page wiring lives in `app.js`.
 */

import {
  SupplytrackError,
  BLOCKING_REASONS,
  REVIEW_COLUMNS,
  casefold,
  decodePreferredPack,
  sequenceRatio,
  suggestInclude,
  uppCandidates,
} from "./pipeline.js";

/** The queue columns plus the two this step adds. */
export const PROPOSE_COLUMNS = [...REVIEW_COLUMNS, "confidence", "proposed_by"];

/** The allow-list: nothing outside this is ever put in a request. */
export const SENT_FIELDS = [
  "key",
  "source",
  "raw_title",
  "amazon_category",
  "pack_desc",
  "packs_in_year",
  "upp_candidates",
];

export const VENDORS = ["anthropic", "gemini"];
export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5",
  gemini: "gemini-3.1-flash-lite",
};
export const CHEAP_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-3.1-flash-lite",
};

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
export const TOOL_NAME = "record_proposals";
export const MAX_TOKENS = 8000;

/** Where the page finds the prompt, relative to this module. */
export const PROMPT_URL = new URL("../prompts/proposal.json", import.meta.url);

/** Mirrors the same constant in pipeline.js, which does not export it. */
const CANONICAL_MATCH = 0.85;

const VALID_INCLUDE = new Set(["y", "n"]);
const VALID_LABELS = new Set(["EA", "RM"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const REASON_PREFIX = "AI: ";

function checkVendor(vendor) {
  const folded = casefold(String(vendor ?? "").trim());
  if (!VENDORS.includes(folded)) {
    throw new SupplytrackError(
      `Unknown provider "${vendor}". Use one of: ${VENDORS.join(", ")}.`
    );
  }
  return folded;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

// ------------------------------------------------------------ what gets sent

/** One queue row reduced to the fields a provider is allowed to see. */
export function linePayload(row) {
  const out = {};
  for (const name of SENT_FIELDS) {
    const value = text((row || {})[name]);
    if (!value) continue;
    if (name === "packs_in_year") {
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      out[name] = Math.trunc(number);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** The user message content: the batch, plus the names already in use. */
export function buildPayload(batch, existingNames) {
  return {
    existing_canonical_names: (existingNames || []).map((n) => String(n)),
    lines: (batch || []).map(linePayload),
  };
}

/**
 * The payload as the exact JSON string both ports put in the message.
 *
 * Two spaces of indent with no ASCII escaping is what Python's
 * `json.dumps(x, indent=2, ensure_ascii=False)` produces, character for
 * character. That is what lets one request fixture prove both ports build the
 * same body.
 */
export function payloadText(payload) {
  return JSON.stringify(payload, null, 2);
}

/** Split the queue into batches of at most `size` rows. */
export function batches(rows, size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) {
    throw new SupplytrackError(`Batch size must be a positive number, not ${size}.`);
  }
  const out = [];
  for (let i = 0; i < (rows || []).length; i += Math.trunc(n)) {
    out.push(rows.slice(i, i + Math.trunc(n)));
  }
  return out;
}

// ------------------------------------------------- picking rows to send

/** Just the rows that stop the build: unknown key, pack size missing. */
export function blockingRows(rows) {
  return (rows || []).filter((row) =>
    BLOCKING_REASONS.has(String((row || {}).queue_reason ?? "").trim())
  );
}

/**
 * Split provider-answered queue rows into what applyQueue can take right now
 * and what still needs a person. webapp-v2-spec.md section 7: a row is ready
 * when it has an include answer, a single canonical pack size, and a name.
 * Everything else - two candidates and no single answer, no name, include
 * still blank - stays open, which is the page's "worth a look" list.
 *
 * @param {object[]} rows
 * @returns {{ready: object[], open: object[]}}
 */
export function autoAccept(rows) {
  const ready = [];
  const open = [];
  for (const row of rows || []) {
    const include = casefold(text((row || {}).include));
    const hasInclude = include === "y" || include === "n";
    const hasUnits = coerceUnits((row || {}).units_per_pack) !== "";
    const hasName = Boolean(text((row || {}).canonical_name));
    (hasInclude && hasUnits && hasName ? ready : open).push(row);
  }
  return { ready, open };
}

/**
 * Copy `pack_desc` onto queue rows from the order lines they came from.
 *
 * A Preferred pack code says the pack size outright, so it is the single most
 * useful thing a model can be told about one of those rows. The review queue
 * file has no column for it, which is why the command line cannot send it; the
 * page holds the ingested lines in memory and can. Rows are copied, not
 * mutated, and a row that already carries one keeps it.
 */
export function attachPackDesc(rows, lines) {
  const byKey = new Map();
  for (const line of lines || []) {
    const key = String((line || {}).key ?? "");
    const desc = text((line || {}).pack_desc);
    if (key && desc && !byKey.has(key)) byKey.set(key, desc);
  }
  if (!byKey.size) return (rows || []).map((row) => ({ ...row }));
  return (rows || []).map((row) => {
    const copy = { ...row };
    if (!text(copy.pack_desc)) {
      const desc = byKey.get(String(copy.key ?? ""));
      if (desc) copy.pack_desc = desc;
    }
    return copy;
  });
}

/**
 * What a run would send, before anything is sent: batches, bytes and a rough
 * token count.
 *
 * No money figure. A price per token would have to be hard coded here, and a
 * stale price shown next to a button is worse than no price: the person can
 * read the request count and the size, which do not go out of date.
 *
 * @returns {{rows: number, batches: number, bytes: number, approxInputTokens: number}}
 */
export function estimateRequests({ rows, existingNames, prompt, vendor, model, batchSize } = {}) {
  const v = checkVendor(vendor || "anthropic");
  const size = Number(batchSize || (prompt && prompt.batch_size) || 25);
  const groups = batches(rows || [], size);
  let bytes = 0;
  for (const batch of groups) {
    const request = buildRequest(v, {
      model,
      prompt,
      batch,
      existingNames: existingNames || [],
      apiKey: "",
    });
    bytes += new TextEncoder().encode(JSON.stringify(request.body)).length;
  }
  return {
    rows: (rows || []).length,
    batches: groups.length,
    bytes,
    // Four bytes to a token is the usual rule of thumb. It is an order of
    // magnitude, not a bill.
    approxInputTokens: Math.round(bytes / 4),
  };
}

// ------------------------------------------------------------------ prompt

let cachedPrompt = null;

/**
 * Load `web/prompts/proposal.json`, which is byte identical to the copy the
 * Python package ships. Fetched once and kept; tests inject it instead.
 *
 * @param {{fetchImpl?: Function, url?: string|URL, force?: boolean}} [options]
 * @returns {Promise<object>}
 */
export async function loadPrompt({ fetchImpl, url, force = false } = {}) {
  if (cachedPrompt && !force) return cachedPrompt;
  const fetcher = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!fetcher) {
    throw new SupplytrackError("No fetch available to load the proposal prompt.");
  }
  const target = url || PROMPT_URL;
  const response = await fetcher(String(target));
  if (!response || response.ok === false) {
    throw new SupplytrackError(
      `Could not load the proposal prompt from ${target} (${response && response.status}).`
    );
  }
  const doc = await response.json();
  for (const name of ["system", "output_schema", "batch_size"]) {
    if (!(name in doc)) {
      throw new SupplytrackError(`The proposal prompt is missing the "${name}" field.`);
    }
  }
  cachedPrompt = doc;
  return doc;
}

// --------------------------------------------------------------- providers

/**
 * Translate the prompt's JSON schema into what Gemini accepts: upper-case type
 * names, no `additionalProperties`, and nullability as a flag not a union.
 */
export function geminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  const out = {};
  const rawType = schema.type;
  const types = typeof rawType === "string" ? [rawType] : Array.isArray(rawType) ? rawType : [];
  const nullable = types.includes("null");
  const concrete = types.filter((t) => t !== "null");
  if (concrete.length) out.type = String(concrete[0]).toUpperCase();
  if (nullable) out.nullable = true;
  for (const name of ["description", "enum"]) {
    if (name in schema) out[name] = schema[name];
  }
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = geminiSchema(v);
  }
  if (schema.items) out.items = geminiSchema(schema.items);
  if (schema.required) out.required = [...schema.required];
  return out;
}

function anthropicTool(prompt) {
  return {
    name: TOOL_NAME,
    description: "Record one proposal for every purchase line in this batch.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        proposals: {
          type: "array",
          description: "One entry per line, in the order they were given.",
          items: prompt.output_schema,
        },
      },
      required: ["proposals"],
      additionalProperties: false,
    },
  };
}

/**
 * Build one outgoing call. The body is the same object the Python builds; the
 * headers are not, because only a browser needs the direct-access opt-in.
 *
 * `anthropic-dangerous-direct-browser-access: true` is what makes Anthropic
 * answer a cross-origin request at all. It is named that way because shipping
 * a key inside a public page hands it to every visitor. It is acceptable here
 * and only here: the key is the person's own, they paste it in themselves, it
 * lives in a closure variable for the length of the visit, it is never stored
 * and never logged, and the page is reloaded to forget it. A key for anybody
 * else, or a key that has to survive a reload, belongs behind a server.
 *
 * @returns {{url: string, method: string, headers: object, body: object}}
 */
export function buildRequest(vendor, { model, prompt, batch, existingNames, apiKey } = {}) {
  const v = checkVendor(vendor);
  const chosen = String(model || DEFAULT_MODELS[v]);
  const content = payloadText(buildPayload(batch, existingNames));

  if (v === "anthropic") {
    return {
      url: ANTHROPIC_URL,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        "x-api-key": String(apiKey ?? ""),
      },
      body: {
        model: chosen,
        max_tokens: MAX_TOKENS,
        system: prompt.system,
        messages: [{ role: "user", content }],
        tools: [anthropicTool(prompt)],
        tool_choice: { type: "tool", name: TOOL_NAME },
      },
    };
  }

  return {
    url: GEMINI_URL.replace("{model}", chosen),
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": String(apiKey ?? ""),
    },
    body: {
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: "user", parts: [{ text: content }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          description: "One entry per line, in the order they were given.",
          items: geminiSchema(prompt.output_schema),
        },
      },
    },
  };
}

/** Pull the list of proposals out of whatever the provider replied with. */
export function parseResponse(vendor, payload) {
  const v = checkVendor(vendor);
  if (v === "anthropic") {
    for (const block of (payload || {}).content || []) {
      if (block && block.type === "tool_use" && block.name === TOOL_NAME) {
        const proposals = (block.input || {}).proposals;
        if (Array.isArray(proposals)) {
          return proposals.filter((p) => p && typeof p === "object");
        }
      }
    }
    return [];
  }

  for (const candidate of (payload || {}).candidates || []) {
    const parts = ((candidate || {}).content || {}).parts || [];
    const joined = parts
      .filter((p) => p && typeof p === "object")
      .map((p) => String(p.text ?? ""))
      .join("");
    if (!joined.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(joined);
    } catch (err) {
      throw new SupplytrackError(`Gemini returned text that is not JSON: ${err.message}`);
    }
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      parsed = parsed.proposals || [];
    }
    if (Array.isArray(parsed)) return parsed.filter((p) => p && typeof p === "object");
  }
  return [];
}

// ----------------------------------------------------------------- merging

/** A pack size as a positive whole number in string form, or "" when it is not one. */
export function coerceUnits(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0 || number !== Math.trunc(number)) return "";
  return String(Math.trunc(number));
}

function reasonText(value) {
  const cleaned = text(value);
  return cleaned ? `${REASON_PREFIX}${cleaned}` : "";
}

/**
 * Fold a model's answers into the queue rows it was asked about.
 *
 * A proposal for a key that was not in the batch is dropped, because a model
 * inventing a row is exactly what this pipeline exists to prevent. A pack size
 * that is not a positive whole number counts as no answer, and the regex
 * suggestion already on the row stands. A row the model said nothing about
 * comes back untouched with a confidence of "none", so it reads as unanswered
 * rather than as silently blank.
 */
export function mergeProposals(batch, proposals, proposedBy) {
  const allowed = new Set((batch || []).map((row) => String((row || {}).key ?? "")));
  const byKey = new Map();
  for (const proposal of proposals || []) {
    const key = text((proposal || {}).key);
    if (key && allowed.has(key) && !byKey.has(key)) byKey.set(key, proposal);
  }

  return (batch || []).map((row) => {
    const merged = {};
    for (const column of REVIEW_COLUMNS) merged[column] = String(row[column] ?? "");
    merged.proposed_by = String(proposedBy ?? "");

    const proposal = byKey.get(String(row.key ?? ""));
    if (!proposal) {
      merged.confidence = "none";
      return merged;
    }

    const include = casefold(text(proposal.include));
    if (VALID_INCLUDE.has(include)) merged.include = include;
    const includeReason = reasonText(proposal.include_reason);
    if (includeReason) merged.include_reason = includeReason;

    const units = coerceUnits(proposal.units_per_pack);
    if (units) merged.units_per_pack = units;
    const uppReason = reasonText(proposal.upp_reason);
    if (uppReason) merged.upp_reason = uppReason;

    const label = text(proposal.unit_label).toUpperCase();
    if (VALID_LABELS.has(label)) merged.unit_label = label;

    const canonical = text(proposal.canonical_name);
    if (canonical) merged.canonical_name = canonical;
    const canonicalReason = reasonText(proposal.canonical_reason);
    if (canonicalReason) merged.canonical_reason = canonicalReason;

    const confidence = casefold(text(proposal.confidence));
    merged.confidence = VALID_CONFIDENCE.has(confidence) ? confidence : "low";
    return merged;
  });
}

// --------------------------------------------------------- regex provider

function regexUnitLabel(title) {
  return /\breams?\b/i.test(String(title ?? "")) ? "RM" : "EA";
}

function regexCanonical(title, knownNames) {
  let bestName = "";
  let bestRatio = 0.0;
  const folded = casefold(title);
  for (const name of knownNames || []) {
    const ratio = sequenceRatio(folded, casefold(name));
    if (ratio > bestRatio) {
      bestName = name;
      bestRatio = ratio;
    }
  }
  return bestName && bestRatio >= CANONICAL_MATCH ? bestName : "";
}

/**
 * The deterministic provider: the pipeline's own suggestion helpers, nothing
 * more. It fills blanks and never overwrites an answer already on the row, so
 * running it over a queue a person has started work on cannot undo that work.
 * Always available, no key, no network, and synchronous, though `propose`
 * returns a promise like the API provider so the page can await either one.
 */
export const regexProvider = {
  vendor: "regex",
  model: "",
  name: "regex",
  proposeSync(rows, existingNames = []) {
    const names = [...(existingNames || [])];
    return (rows || []).map((row) => {
      const merged = {};
      for (const column of REVIEW_COLUMNS) merged[column] = String(row[column] ?? "");
      merged.confidence = "";
      merged.proposed_by = "regex";

      if (!text(merged.include)) {
        const [include, includeReason] = suggestInclude(merged.amazon_category, merged.source);
        if (include) {
          merged.include = include;
          merged.include_reason = includeReason;
        }
      }

      if (!text(merged.units_per_pack)) {
        const packDesc = text(row.pack_desc);
        const decoded = casefold(merged.source) === "preferred" ? decodePreferredPack(packDesc) : null;
        if (decoded !== null && decoded !== undefined) {
          merged.units_per_pack = String(decoded);
          merged.upp_reason = `Preferred pack code ${packDesc} means ${decoded} per purchase unit`;
        } else {
          const hits = uppCandidates(merged.raw_title);
          const values = new Set(hits.map(([value]) => value));
          merged.upp_candidates =
            merged.upp_candidates ||
            hits.map(([value, phrase]) => `${value} (${phrase})`).join("|");
          if (values.size === 1) {
            merged.units_per_pack = String(hits[0][0]);
            merged.upp_reason = `the title says "${hits[0][1]}"`;
          }
        }
      }

      if (!text(merged.unit_label)) merged.unit_label = regexUnitLabel(merged.raw_title);

      if (!text(merged.canonical_name)) {
        const match = regexCanonical(merged.raw_title, names);
        merged.canonical_name = match || merged.raw_title;
        merged.canonical_reason = match
          ? `close to the existing item "${match}"`
          : "no close match to an existing item, so the title becomes the name";
      }
      if (merged.canonical_name && !names.includes(merged.canonical_name)) {
        names.push(merged.canonical_name);
      }
      return merged;
    });
  },
  async propose(rows, existingNames = []) {
    return regexProvider.proposeSync(rows, existingNames);
  },
};

// ------------------------------------------------------------ api provider

async function sendRequest(fetcher, request) {
  let response;
  try {
    response = await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
  } catch (err) {
    // Whatever went wrong on the wire, the message is ours to write: never
    // echo the request, which carries the key in a header.
    throw new SupplytrackError(`Could not reach the provider: ${err.message}`);
  }
  if (response.ok === false) {
    let detail = "";
    try {
      detail = String(await response.text()).slice(0, 400);
    } catch {
      detail = "";
    }
    throw new SupplytrackError(
      `The provider refused the request (${response.status}). ${detail}`.trim()
    );
  }
  return response.json();
}

/**
 * A provider that asks a model. The key is a closure variable: it is never
 * stored, never put in a log line, and gone when the page is reloaded.
 *
 * @param {{vendor: string, apiKey: string, model?: string, fetchImpl?: Function,
 *          prompt?: object, promptUrl?: string|URL}} options
 * @returns {{vendor: string, model: string, name: string,
 *            propose: (rows: object[], existingNames?: string[], opts?: object) => Promise<object[]>}}
 */
export function makeApiProvider({
  vendor,
  apiKey,
  model,
  fetchImpl,
  prompt,
  promptUrl,
} = {}) {
  const v = checkVendor(vendor);
  const key = String(apiKey ?? "");
  if (!key.trim()) {
    throw new SupplytrackError(
      `No ${v} API key. Paste one into the advanced panel; it is kept in memory only.`
    );
  }
  const chosen = String(model || DEFAULT_MODELS[v]);
  const fetcher = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!fetcher) throw new SupplytrackError("No fetch available to call the provider.");
  let loaded = prompt || null;

  return {
    vendor: v,
    model: chosen,
    name: `${v}:${chosen}`,
    async propose(rows, existingNames = [], { batchSize } = {}) {
      if (!loaded) loaded = await loadPrompt({ fetchImpl: fetcher, url: promptUrl });
      const size = Number(batchSize || loaded.batch_size || 25);
      const out = [];
      for (const batch of batches(rows || [], size)) {
        const request = buildRequest(v, {
          model: chosen,
          prompt: loaded,
          batch,
          existingNames,
          apiKey: key,
        });
        const payload = await sendRequest(fetcher, request);
        out.push(...mergeProposals(batch, parseResponse(v, payload), `${v}:${chosen}`));
      }
      return out;
    },
  };
}
