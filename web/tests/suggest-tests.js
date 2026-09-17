/* Parity tests for the suggestion provider seam: `node web/tests/suggest-tests.js`.
 *
 * The fixtures under `tests/fixtures/propose/` are written by the Python
 * (`python scripts/make_propose_fixtures.py`) and read by both suites. A canned
 * request per provider proves this module builds the same body the Python
 * builds; a canned response per provider proves it parses that reply into the
 * same rows. That is the same contract the golden vectors hold the pipeline to.
 *
 * Nothing here touches the network: every call goes through an injected fetch.
 * No test framework and no dependencies, just Node 18+.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SupplytrackError, REVIEW_COLUMNS } from "../js/pipeline.js";
import * as S from "../js/suggest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");
const FIXTURES = path.join(SRC, "tests", "fixtures", "propose");
const PY_PROMPT = path.join(SRC, "supplytrack", "prompts", "proposal.json");
const WEB_PROMPT = path.join(SRC, "web", "prompts", "proposal.json");

// ---------------------------------------------------------------- harness

let passed = 0;
let failed = 0;
const failures = [];

function ok() {
  passed += 1;
}

function bad(name, detail) {
  failed += 1;
  failures.push({ name, detail });
}

function truncate(s, n = 600) {
  const t = String(s);
  return t.length <= n ? t : t.slice(0, n) + ` ... (${t.length} chars)`;
}

/** Key order is not part of the contract; content is. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function assertEqual(name, actual, expected) {
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a === e) return ok();
  return bad(name, `expected: ${truncate(e)}\n     actual: ${truncate(a)}`);
}

function assertDeep(name, actual, expected) {
  const a = JSON.stringify(canonical(actual));
  const e = JSON.stringify(canonical(expected));
  if (a === e) return ok();
  let i = 0;
  while (i < a.length && i < e.length && a[i] === e[i]) i += 1;
  return bad(
    name,
    `first difference at character ${i}\n` +
      `     expected: ${truncate(e.slice(Math.max(0, i - 80), i + 200))}\n` +
      `     actual:   ${truncate(a.slice(Math.max(0, i - 80), i + 200))}`
  );
}

function assertTrue(name, value, detail = "expected true") {
  return value ? ok() : bad(name, detail);
}

function assertThrows(name, fn, detail = "expected a throw") {
  try {
    fn();
  } catch {
    return ok();
  }
  return bad(name, detail);
}

async function assertRejects(name, promise, detail = "expected a rejection") {
  try {
    await promise;
  } catch {
    return ok();
  }
  return bad(name, detail);
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const QUEUE_ROWS = fixture("queue_rows.json");
const EXISTING_NAMES = fixture("existing_names.json");
const PROPOSALS = fixture("proposals.json");
const EXPECTED = fixture("expected_rows.json");
const PROMPT = JSON.parse(fs.readFileSync(WEB_PROMPT, "utf8"));

/** A fetch that answers from a canned payload and records what it was given. */
function fakeFetch(payload, { ok: isOk = true, status = 200, text = "" } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: isOk,
      status,
      json: async () => (typeof payload === "function" ? payload(calls.length) : payload),
      text: async () => text,
    };
  };
  impl.calls = calls;
  return impl;
}

// ----------------------------------------------------------- the prompt

function testPrompt() {
  assertEqual(
    "the two prompt copies are byte identical",
    sha256(WEB_PROMPT),
    sha256(PY_PROMPT)
  );
  assertTrue(
    "the prompt carries the fields the providers need",
    PROMPT.system && PROMPT.output_schema && PROMPT.batch_size === 25,
    "the prompt file is missing system, output_schema or batch_size"
  );
  const raw = fs.readFileSync(WEB_PROMPT, "utf8");
  assertTrue(
    "no em dashes anywhere in the prompt",
    // Written as code points so this file stays free of them too.
    ![0x2014, 0x2013].some((point) => raw.includes(String.fromCharCode(point))),
    "found an em or en dash in the prompt file"
  );
  assertTrue(
    "the prompt states the rules that are not negotiable",
    ["dozen", "ream", "Never invent a count", "null"].every((p) => PROMPT.system.includes(p)),
    "a pack-size rule went missing from the prompt"
  );
}

// ---------------------------------------------------------- the request

function testRequest() {
  const anthropic = S.buildRequest("anthropic", {
    model: "claude-sonnet-5",
    prompt: PROMPT,
    batch: QUEUE_ROWS,
    existingNames: EXISTING_NAMES,
    apiKey: "",
  });
  const aExpected = fixture("anthropic_request.json");
  assertEqual("the anthropic url matches the fixture", anthropic.url, aExpected.url);
  assertDeep("the anthropic request body matches the Python", anthropic.body, aExpected.body);

  const gemini = S.buildRequest("gemini", {
    model: "gemini-3.1-flash-lite",
    prompt: PROMPT,
    batch: QUEUE_ROWS,
    existingNames: EXISTING_NAMES,
    apiKey: "",
  });
  const gExpected = fixture("gemini_request.json");
  assertEqual("the gemini url matches the fixture", gemini.url, gExpected.url);
  assertDeep("the gemini request body matches the Python", gemini.body, gExpected.body);

  // The exact message string, not just the parsed object: Python's
  // json.dumps(indent=2) and JSON.stringify(x, null, 2) have to agree
  // character for character or one fixture cannot serve both ports.
  assertEqual(
    "the user message is the same string in both ports",
    anthropic.body.messages[0].content,
    aExpected.body.messages[0].content
  );

  const withKey = S.buildRequest("anthropic", {
    prompt: PROMPT,
    batch: QUEUE_ROWS,
    existingNames: EXISTING_NAMES,
    apiKey: "sk-secret-value",
  });
  assertEqual(
    "the anthropic key travels in the x-api-key header",
    withKey.headers["x-api-key"],
    "sk-secret-value"
  );
  assertTrue(
    "the key never reaches the request body",
    !JSON.stringify(withKey.body).includes("sk-secret-value"),
    "the key was serialised into the body"
  );
  assertEqual(
    "the browser opt-in header is sent",
    withKey.headers["anthropic-dangerous-direct-browser-access"],
    "true"
  );
  assertEqual(
    "the gemini key travels in the x-goog-api-key header",
    S.buildRequest("gemini", { prompt: PROMPT, batch: [], existingNames: [], apiKey: "k" })
      .headers["x-goog-api-key"],
    "k"
  );

  for (const vendor of ["anthropic", "gemini"]) {
    const request = S.buildRequest(vendor, {
      prompt: PROMPT,
      batch: QUEUE_ROWS,
      existingNames: EXISTING_NAMES,
      apiKey: "k",
    });
    const body = JSON.stringify(request.body);

    // The exact check: every key on every line sent, against the allow-list.
    // A scan for leaked strings can only catch the distinctive ones.
    const sentText =
      vendor === "anthropic"
        ? request.body.messages[0].content
        : request.body.contents[0].parts[0].text;
    const sent = JSON.parse(sentText);
    assertDeep(
      `the ${vendor} payload has only the two agreed sections`,
      Object.keys(sent).sort(),
      ["existing_canonical_names", "lines"]
    );
    const sentKeys = new Set(sent.lines.flatMap((line) => Object.keys(line)));
    assertDeep(
      `the ${vendor} payload sends no field outside the allow-list`,
      [...sentKeys].filter((k) => !S.SENT_FIELDS.includes(k)),
      []
    );
    assertTrue(
      `the ${vendor} body carries no address-shaped value`,
      !body.includes("@"),
      "an @ reached the request body"
    );
    const banned = REVIEW_COLUMNS.filter((c) => !S.SENT_FIELDS.includes(c));
    let leaked = "";
    for (const row of QUEUE_ROWS) {
      for (const column of banned) {
        const value = String(row[column] ?? "").trim();
        if (value.length > 20 && !String(row.raw_title ?? "").includes(value)) {
          if (body.includes(value)) leaked = `${column}: ${value}`;
        }
      }
    }
    assertEqual(`the ${vendor} body carries no queue column outside the allow-list`, leaked, "");
  }

  assertThrows("an unknown provider is refused", () =>
    S.buildRequest("openai", { prompt: PROMPT, batch: [], existingNames: [] })
  );

  assertDeep("a row with no pack code simply omits it", S.linePayload({
    key: "amz:x",
    source: "amazon",
    raw_title: "Pens",
  }), { key: "amz:x", source: "amazon", raw_title: "Pens" });
  assertEqual(
    "packs_in_year is sent as a number",
    S.linePayload({ key: "k", packs_in_year: "10" }).packs_in_year,
    10
  );
  assertTrue(
    "a packs_in_year that is not a number is left out",
    !("packs_in_year" in S.linePayload({ key: "k", packs_in_year: "many" })),
    "a non-numeric packs_in_year was sent"
  );
}

// --------------------------------------------------------- the response

function testResponse() {
  const anthropic = S.parseResponse("anthropic", fixture("anthropic_response.json"));
  const gemini = S.parseResponse("gemini", fixture("gemini_response.json"));
  assertDeep("the anthropic reply parses into the fixture proposals", anthropic, PROPOSALS);
  assertDeep("the gemini reply parses into the fixture proposals", gemini, PROPOSALS);
  assertDeep("both providers parse into the same proposals", anthropic, gemini);

  assertDeep(
    "a reply in a shape nobody expected yields nothing",
    S.parseResponse("anthropic", { content: [{ type: "text", text: "hello" }] }),
    []
  );
  assertDeep("an empty gemini reply yields nothing", S.parseResponse("gemini", {}), []);
  assertThrows("gemini prose instead of JSON is an error, not a guess", () =>
    S.parseResponse("gemini", { candidates: [{ content: { parts: [{ text: "sorry, no" }] } }] })
  );
}

// ------------------------------------------------------------- merging

function testMerge() {
  assertDeep(
    "the merged rows match the Python",
    S.mergeProposals(QUEUE_ROWS, PROPOSALS, EXPECTED.proposed_by),
    EXPECTED.rows
  );

  const invented = S.mergeProposals(
    QUEUE_ROWS,
    [{ key: "amz:this key was never in the batch", include: "y", units_per_pack: 99,
       canonical_name: "Invented Item", confidence: "high" }],
    "fake:model"
  );
  assertTrue(
    "a proposal for a key that was never sent is dropped",
    invented.every((r) => r.confidence === "none" && r.canonical_name !== "Invented Item"),
    "an invented row reached the output"
  );

  const skipped = S.mergeProposals(QUEUE_ROWS, [], "fake:model");
  assertTrue(
    "a row the model skipped comes back unchanged but marked",
    skipped.every(
      (row, i) =>
        row.confidence === "none" &&
        row.proposed_by === "fake:model" &&
        REVIEW_COLUMNS.every((c) => row[c] === String(QUEUE_ROWS[i][c] ?? ""))
    ),
    "a skipped row was altered"
  );

  for (const value of [0, -3, 2.5, "", null, undefined, "twelve", true, false]) {
    assertEqual(`a pack size of ${JSON.stringify(value)} is no answer`, S.coerceUnits(value), "");
  }
  assertEqual("a pack size of 12 survives as a string", S.coerceUnits("12"), "12");
  assertEqual("a pack size of 12.0 is 12", S.coerceUnits(12.0), "12");

  const kept = S.mergeProposals(
    [{ key: "k", raw_title: "Avery Inserts, 200 Inserts", units_per_pack: "200" }],
    [{ key: "k", units_per_pack: null, upp_reason: "cannot tell", confidence: "low" }],
    "fake:model"
  )[0];
  assertEqual("a null pack size keeps the regex suggestion", kept.units_per_pack, "200");
  assertEqual("an AI reason is prefixed", kept.upp_reason, "AI: cannot tell");

  assertEqual(
    "an unrecognised confidence word is treated as low",
    S.mergeProposals([{ key: "k" }], [{ key: "k", confidence: "certain" }], "f")[0].confidence,
    "low"
  );
  const ignored = S.mergeProposals(
    [{ key: "k", include: "y", unit_label: "EA" }],
    [{ key: "k", include: "maybe", unit_label: "BOX", confidence: "high" }],
    "f"
  )[0];
  assertEqual("an include outside y or n is ignored", ignored.include, "y");
  assertEqual("a unit label outside EA or RM is ignored", ignored.unit_label, "EA");

  assertDeep(
    "the proposed columns are the queue columns plus two",
    S.PROPOSE_COLUMNS,
    [...REVIEW_COLUMNS, "confidence", "proposed_by"]
  );
}

// ------------------------------------------------------------ batching

function testBatching() {
  const rows = Array.from({ length: 8 }, (_, n) => ({ key: String(n) }));
  assertDeep("batches of three", S.batches(rows, 3).map((b) => b.length), [3, 3, 2]);
  assertDeep("one batch when the size covers everything", S.batches(rows, 25).map((b) => b.length), [8]);
  assertDeep("no rows means no batches", S.batches([], 25), []);
  assertThrows("a batch size of zero is refused", () => S.batches(rows, 0));
}

// ------------------------------------------------------- gemini schema

function testGeminiSchema() {
  const schema = S.geminiSchema(PROMPT.output_schema);
  assertEqual("the gemini schema uses upper-case types", schema.type, "OBJECT");
  assertTrue(
    "additionalProperties is dropped for gemini",
    !("additionalProperties" in schema),
    "additionalProperties survived into the gemini schema"
  );
  assertDeep("a nullable integer becomes type plus nullable", schema.properties.units_per_pack, {
    type: "INTEGER",
    nullable: true,
    description: schema.properties.units_per_pack.description,
  });
  assertDeep("enums survive", schema.properties.include.enum, ["y", "n"]);
}

// ------------------------------------------------------- the api provider

async function testApiProvider() {
  const fetcher = fakeFetch(fixture("anthropic_response.json"));
  const provider = S.makeApiProvider({
    vendor: "anthropic",
    apiKey: "sk-secret-value",
    model: "claude-sonnet-5",
    fetchImpl: fetcher,
    prompt: PROMPT,
  });
  assertEqual("the provider names itself vendor:model", provider.name, "anthropic:claude-sonnet-5");

  const rows = await provider.propose(QUEUE_ROWS, EXISTING_NAMES);
  assertEqual("one batch, one call", fetcher.calls.length, 1);
  assertDeep("the api provider produces the Python's rows", rows,
    S.mergeProposals(QUEUE_ROWS, PROPOSALS, "anthropic:claude-sonnet-5"));
  assertEqual(
    "the key is sent as a header",
    fetcher.calls[0].options.headers["x-api-key"],
    "sk-secret-value"
  );
  assertTrue(
    "the key is never in the sent body",
    !String(fetcher.calls[0].options.body).includes("sk-secret-value"),
    "the key was serialised into the body"
  );

  const batched = fakeFetch(fixture("anthropic_response.json"));
  await S.makeApiProvider({
    vendor: "anthropic",
    apiKey: "k",
    fetchImpl: batched,
    prompt: PROMPT,
  }).propose(QUEUE_ROWS, EXISTING_NAMES, { batchSize: 3 });
  assertEqual("eight rows at three a batch is three calls", batched.calls.length, 3);

  const gemini = fakeFetch(fixture("gemini_response.json"));
  const geminiRows = await S.makeApiProvider({
    vendor: "gemini",
    apiKey: "k",
    fetchImpl: gemini,
    prompt: PROMPT,
  }).propose(QUEUE_ROWS, EXISTING_NAMES);
  assertDeep(
    "both providers produce the same rows from the same proposals",
    geminiRows.map((r) => ({ ...r, proposed_by: "" })),
    rows.map((r) => ({ ...r, proposed_by: "" }))
  );
  assertEqual(
    "gemini rows record which model produced them",
    geminiRows[0].proposed_by,
    "gemini:gemini-3.1-flash-lite"
  );

  const refused = fakeFetch(null, { ok: false, status: 401, text: "invalid x-api-key" });
  await assertRejects(
    "a refused request becomes a plain error",
    S.makeApiProvider({ vendor: "anthropic", apiKey: "k", fetchImpl: refused, prompt: PROMPT })
      .propose(QUEUE_ROWS, EXISTING_NAMES)
  );

  assertThrows("no key means no provider", () =>
    S.makeApiProvider({ vendor: "anthropic", apiKey: "", fetchImpl: fetcher, prompt: PROMPT })
  );
  assertThrows("an unknown vendor means no provider", () =>
    S.makeApiProvider({ vendor: "openai", apiKey: "k", fetchImpl: fetcher, prompt: PROMPT })
  );

  // The prompt is fetched, once, when it was not injected.
  let fetched = 0;
  const promptFetch = async (url, options) => {
    if (!options) {
      fetched += 1;
      return { ok: true, status: 200, json: async () => PROMPT };
    }
    return { ok: true, status: 200, json: async () => fixture("anthropic_response.json") };
  };
  const lazy = S.makeApiProvider({ vendor: "anthropic", apiKey: "k", fetchImpl: promptFetch });
  await lazy.propose(QUEUE_ROWS.slice(0, 2), []);
  await lazy.propose(QUEUE_ROWS.slice(2, 4), []);
  assertEqual("the prompt is loaded once per provider", fetched, 1);
}

// ---------------------------------------------------- the regex provider

async function testRegexProvider() {
  const blank = {
    key: "amz:sticky notes 12 pack",
    source: "amazon",
    raw_title: "Sticky Notes, Yellow, 12 Pack",
    amazon_category: "Office Product",
    packs_in_year: "4",
    queue_reason: "unknown key",
    include: "",
    include_reason: "",
    units_per_pack: "",
    upp_candidates: "",
    upp_reason: "",
    canonical_name: "",
    canonical_reason: "",
    unit_label: "",
    note: "",
  };
  const [row] = regexRows([blank]);
  assertEqual("the regex provider proposes include from the category", row.include, "y");
  assertEqual("the regex provider reads a pack of twelve", row.units_per_pack, "12");
  assertEqual("the regex provider names the row from its title", row.canonical_name, blank.raw_title);
  assertEqual("the regex provider says what produced the row", row.proposed_by, "regex");
  assertEqual("the regex provider claims no model confidence", row.confidence, "");

  const paper = regexRows([{ ...blank, key: "k2", raw_title: "Copy Paper, 10 Reams per Carton" }])[0];
  assertEqual("paper is labelled by the ream", paper.unit_label, "RM");
  assertEqual("a carton of ten reams is ten", paper.units_per_pack, "10");

  const preferred = regexRows([
    { ...blank, key: "pbs:X", source: "preferred", raw_title: "FILE FOLDER", pack_desc: "BX100",
      amazon_category: "" },
  ])[0];
  assertEqual("a Preferred pack code decodes directly", preferred.units_per_pack, "100");
  assertEqual("a Preferred line is included", preferred.include, "y");

  const answered = regexRows([
    { ...blank, include: "n", units_per_pack: "7", canonical_name: "Someone's Name",
      unit_label: "RM" },
  ])[0];
  assertEqual("an answer already on the row is left alone (include)", answered.include, "n");
  assertEqual("an answer already on the row is left alone (units)", answered.units_per_pack, "7");
  assertEqual(
    "an answer already on the row is left alone (name)",
    answered.canonical_name,
    "Someone's Name"
  );

  const merged = regexRows([
    { ...blank, key: "k3", raw_title: "Hammermill Copy Paper" },
  ], ["Hammermill Copy Paper"])[0];
  assertEqual("a close existing name is reused", merged.canonical_name, "Hammermill Copy Paper");

  const awaited = await S.regexProvider.propose([blank], []);
  assertDeep("propose returns the same rows as proposeSync", awaited, regexRows([blank]));
  assertDeep(
    "the regex provider returns every proposed column",
    Object.keys(awaited[0]).sort(),
    [...S.PROPOSE_COLUMNS].sort()
  );
}

function regexRows(rows, names = []) {
  return S.regexProvider.proposeSync(rows, names);
}

// -------------------------------------------------------- auto-decide

function testAutoAccept() {
  const base = {
    key: "amz:x", source: "amazon", raw_title: "Pens", amazon_category: "Office Product",
    include: "y", units_per_pack: "12", canonical_name: "Pens, Blue", unit_label: "EA",
  };

  const complete = S.autoAccept([{ ...base }]);
  assertEqual("a complete row is ready", complete.ready.length, 1);
  assertEqual("a complete row is not open", complete.open.length, 0);
  assertDeep("a ready row is handed back unchanged", complete.ready[0], base);

  const noInclude = S.autoAccept([{ ...base, include: "" }]);
  assertEqual("a row missing include is open, not ready", noInclude.open.length, 1);
  assertEqual("a row missing include is not ready", noInclude.ready.length, 0);

  const twoCandidates = S.autoAccept([
    { ...base, units_per_pack: "", upp_candidates: "12 (12/Pack)|10 (Case of 10)" },
  ]);
  assertEqual(
    "two pack candidates with no single answer stay open",
    twoCandidates.open.length,
    1
  );

  const noName = S.autoAccept([{ ...base, canonical_name: "" }]);
  assertEqual("a row with no name is open, not ready", noName.open.length, 1);

  const preferred = S.autoAccept([
    { key: "pbs:BX100", source: "preferred", raw_title: "FILE FOLDER",
      include: "y", units_per_pack: "100", canonical_name: "File Folder", unit_label: "EA" },
  ]);
  assertEqual("a decoded Preferred pack code is ready", preferred.ready.length, 1);
  assertEqual("a decoded Preferred pack code has nothing open", preferred.open.length, 0);

  assertDeep("no rows means nothing ready or open", S.autoAccept([]), { ready: [], open: [] });
  assertDeep("a missing list is tolerated", S.autoAccept(undefined), { ready: [], open: [] });
}

// ------------------------------------------------ what the page needs

/* These three are the logic the review panel in app.js would otherwise carry itself.
 * They live here so they can be tested with no DOM, which is the same reason the rest of
 * this module has none. */

function testPageHelpers() {
  const queue = [
    { key: "a", queue_reason: "unknown key", source: "amazon", raw_title: "Pens" },
    { key: "b", queue_reason: "pack size unconfirmed", source: "amazon", raw_title: "Paper" },
    { key: "c", queue_reason: "pack size missing", source: "preferred", raw_title: "Folders" },
    { key: "d", queue_reason: "", source: "amazon", raw_title: "Tape" },
  ];
  assertDeep(
    "only the rows that stop the build are blocking",
    S.blockingRows(queue).map((r) => r.key),
    ["a", "c"]
  );
  assertDeep("no rows means no blocking rows", S.blockingRows([]), []);
  assertDeep("a missing list is tolerated", S.blockingRows(undefined), []);

  // pack_desc: the page has it, the queue file does not.
  const lines = [
    { key: "c", source: "preferred", pack_desc: "BX100" },
    { key: "c", source: "preferred", pack_desc: "BX100" },
    { key: "a", source: "amazon", pack_desc: "" },
  ];
  const attached = S.attachPackDesc(queue, lines);
  assertEqual("the Preferred pack code is attached", attached[2].pack_desc, "BX100");
  assertTrue(
    "a row with no pack code in the lines gets none",
    !("pack_desc" in attached[0]) || attached[0].pack_desc === "",
    "a pack code appeared from nowhere"
  );
  assertTrue(
    "the queue rows themselves are not changed",
    !("pack_desc" in queue[2]),
    "attachPackDesc mutated its input"
  );
  const kept = S.attachPackDesc([{ key: "c", pack_desc: "CT10" }], lines);
  assertEqual("a pack code already on the row is kept", kept[0].pack_desc, "CT10");
  assertEqual(
    "no lines means the rows come back unchanged",
    S.attachPackDesc(queue, []).length,
    queue.length
  );

  // And the attached code reaches the request, which is the whole point of doing it.
  const body = JSON.stringify(
    S.buildRequest("anthropic", {
      prompt: PROMPT,
      batch: attached,
      existingNames: [],
      apiKey: "k",
    }).body
  );
  assertTrue(
    "an attached pack code is sent to the provider",
    body.includes("BX100"),
    "the attached pack code did not reach the request"
  );

  // The preflight numbers shown before anybody presses the button.
  const estimate = S.estimateRequests({
    rows: QUEUE_ROWS,
    existingNames: EXISTING_NAMES,
    prompt: PROMPT,
    vendor: "anthropic",
    model: "claude-sonnet-5",
    batchSize: 3,
  });
  assertEqual("the estimate counts the rows", estimate.rows, QUEUE_ROWS.length);
  assertEqual("eight rows at three a batch is three requests", estimate.batches, 3);
  assertTrue(
    "the estimate reports a plausible byte count",
    estimate.bytes > 1000 && estimate.bytes < 200000,
    `bytes was ${estimate.bytes}`
  );
  assertEqual(
    "tokens are estimated from the bytes",
    estimate.approxInputTokens,
    Math.round(estimate.bytes / 4)
  );
  assertDeep("an empty queue estimates nothing", S.estimateRequests({
    rows: [], existingNames: [], prompt: PROMPT, vendor: "gemini",
  }), { rows: 0, batches: 0, bytes: 0, approxInputTokens: 0 });

  // Fewer, larger requests send fewer copies of the prompt, so this must be true.
  const oneBatch = S.estimateRequests({
    rows: QUEUE_ROWS, existingNames: EXISTING_NAMES, prompt: PROMPT, batchSize: 25,
  });
  assertTrue(
    "one big request is smaller than three small ones",
    oneBatch.bytes < estimate.bytes,
    `one batch ${oneBatch.bytes}, three batches ${estimate.bytes}`
  );
}

// ------------------------------------------------------------------ main

async function run() {
  testPrompt();
  testRequest();
  testResponse();
  testMerge();
  testBatching();
  testGeminiSchema();
  await testApiProvider();
  await testRegexProvider();
  testAutoAccept();
  testPageHelpers();

  if (failures.length) {
    console.log("");
    for (const f of failures) console.log(`FAIL ${f.name}\n     ${f.detail}`);
  }
  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.log(`FAIL the suite itself threw: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
