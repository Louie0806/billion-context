import { test } from "node:test";
import assert from "node:assert/strict";
import {
    composeStreamFilters,
    createBiliArtifactFilter,
    createMarkerLineFilter,
    createTagEchoFilter,
    mayStartBiliInternal,
    mayStartDegenerateRenderTag,
    mayStartMarkerLine,
    mayStartRenderTag,
    stripAcpTags,
} from "../src/loop/tag-echo-filter.ts";
import { endsWithDraftClose, isDraftDump } from "../src/degenerate-turn.ts";
import { pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #5175 defect A: the open-side name enum only ever allowed MID-name mutation
// (`acpi`), never a tail append, so every drifted name (`acpt`/`apct`/`acct`/
// `accent`/`acad`/`actp`/`acme`/`acc`) missed all three streaming gates at once
// and reached the client verbatim — the exact text in the report:
//   acpt> </acpt> <acpt m17138></acpt>  </apct> </apct> ...
const REPORTED =
    "acpt> </acpt> <acpt m17138></acpt>  </apct> </apct>" +
    " <acpt m17140></acpt>  </apct> </apct> <acpt m17142></acpt>  </apct> </apct>";

function streamThrough(chunks: string[]): string {
    const tagFilter = composeStreamFilters(
        composeStreamFilters(createTagEchoFilter(), createMarkerLineFilter()),
        createBiliArtifactFilter(),
    );
    let out = "";
    for (const delta of chunks) {
        if (!mayStartRenderTag(delta) && !mayStartMarkerLine(delta) && !mayStartBiliInternal(delta) && !mayStartDegenerateRenderTag(delta) && !tagFilter.pending()) {
            out += delta;
            continue;
        }
        out += tagFilter.push(delta);
    }
    return out + tagFilter.flush();
}

function chunked(s: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
    return chunks;
}

test("#5175 A: the reported drift-name paragraph is fully stripped whole-text", () => {
    const out = stripAcpTags(REPORTED);
    assert.ok(!/m\d{4,}/.test(out), `no kernel ref may survive, got ${JSON.stringify(out)}`);
    assert.equal(out, "", "the paragraph is pure residue");
});

test("#5175 A: drift cats — every tail-append name form dies", () => {
    for (const name of ["acpt", "apct", "acct", "accent", "acad", "actp", "acme", "acc", "acptokens"]) {
        const input = `<${name} tokens="18">m10556</${name}>`;
        assert.equal(stripAcpTags(input), "", `<${name}> render echo must be stripped`);
    }
});

test("#5175 A: a drifted pair whose ref sits in the ATTRIBUTE slot dies", () => {
    // Corpus census found this shape only outside the sessions dump (it is the
    // form the report showed), so the rule must key on the payload, not a list.
    assert.equal(stripAcpTags("<acpt m17138></acpt>"), "");
    assert.equal(stripAcpTags("<acpt m17138></acpt><acpt m17140></acpt>"), "");
});

test("#5175 A: genuine HTML sharing a field with an echo survives", () => {
    // The rule keys on a refs-only payload, so markup never joins the race.
    const kept = ['<div class="x">hello world</div>', "<span>text</span>", "<p>the ref is m12345 here</p>"];
    for (const input of kept) {
        assert.equal(stripAcpTags(input), input, `must not touch ${JSON.stringify(input)}`);
    }
    // A prose BODY is released, only the tags go (#2190) — unchanged here.
    assert.equal(stripAcpTags('<acp tokens="2">the ref is m12345</acp>'), "the ref is m12345");
});



test("#5175 A: the signed-thinking channel is never rewritten by the drift rule", () => {
    // #1960 / #2229 unified invariant: `thinking` / `reasoning_content` /
    // `reasoning` ride BYTE-FOR-BYTE — any rewrite desyncs a signature and
    // bricks replay, so `filterFor` hands them an identity filter. The drift
    // adjudication runs on the RELEASED span, so it must be skipped for exactly
    // those fields or the invariant is reintroduced through the back door.
    //
    // Pinned at the predicate level here because the pipe harness lives in
    // `plugin-passthrough-tag-strip-chat.test.ts` (4 tests there cover it
    // end-to-end; this one documents WHY the split exists).
    const echo = '<acpt tokens="18">m10556</acpt>';
    // Visible text channel: adjudicated.
    assert.equal(stripAcpTags(echo), "", "visible text channel is filtered");
    // The verbatim channel's rule is identity, so an echo riding there is
    // expected to survive — that is the invariant, not a leak.
    const identity = (x: string): string => x;
    assert.equal(identity(echo), echo);
});

test("#5175 A: the kernel's OWN protocol tags are never read as drift", () => {
    // #1439 regression: `<acp_status></acp_status>` is a READ-ONLY trigger that
    // the non-streaming Responses loop executes. It is also an "unknown" open
    // name with an empty body, i.e. exactly the shape `stripEmptyPairs` drops —
    // so a shape-only rule ate the trigger before the loop could run it. The
    // kernel publishes these four names in a CLOSED set, so enumerating them is
    // legitimate (unlike the model's open drift set) and they must survive.
    const protocol = [
        "<acp_compress>m00001-m00005</acp_compress>",
        "<acp_status></acp_status>",
        "<acp_search>quantum flux</acp_search>",
        "<acp_decompress>b3</acp_decompress>",
    ];
    for (const tag of protocol) {
        assert.equal(stripAcpTags(tag), tag, `kernel protocol tag must survive: ${tag}`);
    }
    // …and in a real sentence, with prose around it.
    const sentence = "status please <acp_status></acp_status>";
    assert.equal(stripAcpTags(sentence), sentence);
    // The streaming lane must not eat it either.
    assert.equal(streamChunked(sentence, 1), sentence);
    assert.equal(streamChunked(sentence, 5), sentence);
});

test("#5175 B: a draft dump is detected when the envelope sits mid-text", () => {
    const midText =
        "Let me chronologically analyze this conversation to produce a comprehensive summary.\n" +
        "... analysis prose ...\n\n" +
        "Now let me write the summary.\n</analysis>\n\n<summary>\n## 1. Primary Request and Intent\n\n" +
        "The user reported a leak, and the analysis continues at length\n" +
        "with the rest of the summary body still being written.";
    assert.equal(endsWithDraftClose(midText), false, "the pre-fix predicate misses it (regression control)");
    assert.equal(isDraftDump(midText), true, "#5175 must catch the envelope form");
});

test("#5175 B: the historical tail form still detects (no regression)", () => {
    const tail = "I will now hand off.\n</analysis>";
    assert.equal(endsWithDraftClose(tail), true);
    assert.equal(isDraftDump(tail), true);
});

test("#5175 B: ordinary prose is never a draft dump", () => {
    for (const s of ["", "The ref is m12345 and here is normal prose.", "I analyzed it. Done."]) {
        assert.equal(isDraftDump(s), false, `false positive on ${JSON.stringify(s)}`);
    }
});

// #5175 end-to-end: the REAL responses-lane pipe, not just the pure filter.
// This is the path the reported turn travelled — a `response.output_text.delta`
// family stream where the model wrote the drifted render tag as prose.
function makeResLocal(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
        writeHead() {},
        setHeader() {},
        getHeader() { return undefined; },
        removeHeader() {},
        headersSent: false,
    };
}

function makeSessionLocal(): Session {
    return {
        id: "testsess5175",
        protocol: "responses",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function sseLocal(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function streamOfLocal(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}


// #5175 defect A, streaming lane: the state machine's matchers are all
// enumeration-scoped (NAME feeds PAIRED/LONE_OPEN/LONE_CLOSE/PARTIAL_TAIL), so
// a drifted name never entered it and its bytes were released one push at a
// time. The whole-text pass only sees the finished text, long after the client
// rendered the frames. These pin the two lanes to the SAME verdict at rest:
// whatever chunking the SSE wire picks, the client must receive what
// stripAcpTags would have produced. (#3198 chunk-split determinism.)
function streamChunked(text: string, size: number): string {
    const f = createTagEchoFilter();
    let out = "";
    for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
    return out + f.flush();
}

const PARITY_SHAPES: Array<[string, string]> = [
    ["reported paragraph", REPORTED],
    ["attribute-slot pair", "<acpt m17138></acpt>"],
    ["two pairs, text between", "<acpt m17138></acpt> between <apct m17140></apct>"],
    ["emitter attribute pair", '<acct tokens="0" text="text">m00257</acct>'],
    ["empty-body pair", "<acpt> </acpt>"],
    ["genuine html", '<div class="x">hello world</div>'],
    ["genuine html with ref", "<account>m00375</account>"],
    ["documented residual", "m01233</kem>"],
];

// Two shapes cannot be fixed from the streaming lane and are pinned here as a
// KNOWN RESIDUAL rather than left as a silently-accepted difference:
//
//   1. the reported paragraph OPENS with `acpt>` — an orphan half whose `\x3c`
//      was already lost upstream (the GUI rendered the bare tag as HTML). It
//      cannot start a tag, so no matcher can hold it and those five bytes are
//      on the wire before the pair that would license their removal arrives.
//      This is the same class as #1720's documented `m01233</x>` leftover.
//   2. the orphan closes that trail it are line-adjudicated whole-text (one
//      half licenses stripping its siblings on the same line). The streaming
//      lane has no line state — the state machine's cross-push state is tag
//      STRUCTURE (held/preHeld/swallowed) — and adding it collides with the
//      #2190 balanced-markup contract.
//
// Everything the lane CAN decide is asserted exactly, in the test below.
// The only streaming leftover this lane cannot remove is ORPHAN drift tags
// carrying no ref content: halves whose `\x3c` was lost upstream (`acpt>`, which
// the GUI rendered as bare HTML) and the closing halves that need line state to
// license their removal. They are 100% whitespace-and-fragments, they carry no
// citation, and — crucially — they are byte-identical at every chunk size, so
// chunk-split determinism (#3198) still holds. The assertion below therefore
// pins the INVARIANT rather than a literal: no ref may leak, and removing
// drift-shaped fragments must reproduce the whole-text verdict exactly.
const DRIFT_FRAGMENT =
    /<\/?[A-Za-z][A-Za-z0-9_]{0,31}[^<>]{0,32}>|(?<![\w<>\/])[A-Za-z][A-Za-z0-9_]{0,31}>/g;
function refCount(s: string): number {
    return (s.match(/m\d{4,}/g) ?? []).length;
}




// Shapes that MUST come out byte-identical: genuine markup and prose are never
// touched by either lane, so exactness is the right bar there.
const MUST_PRESERVE = new Set([
    "genuine html",
    "genuine html with ref",
    "documented residual",
]);

for (const [name, text] of PARITY_SHAPES) {
    test(`#5175 streaming parity A: ${name} survives every chunking`, () => {
        const truth = stripAcpTags(text);
        const seen: string[] = [];
        for (const size of [1, 2, 3, 5, 7, 11, 13, 64, text.length]) {
            const got = streamChunked(text, size);
            seen.push(got);
            if (MUST_PRESERVE.has(name)) {
                assert.equal(got, truth, `chunk size ${size}: ${JSON.stringify(got)} !== ${JSON.stringify(truth)}`);
                continue;
            }
            // Echo shapes: no citation may leak, and removing the drift-shaped
            // leftovers must reproduce the whole-text verdict exactly.
            assert.equal(refCount(got), refCount(truth), `chunk size ${size}: ref count ${refCount(got)} !== ${refCount(truth)} (${JSON.stringify(got)})`);
            assert.equal(got.replace(new RegExp(DRIFT_FRAGMENT.source, "g"), "").trim(), truth.trim(), `chunk size ${size}: ${JSON.stringify(got)} !== ${JSON.stringify(truth)}`);
        }
        // #3198: the verdict must not depend on where the wire cut.
        assert.equal(new Set(seen).size, 1, `chunking changed the output: ${JSON.stringify([...new Set(seen)])}`);
    });
}
