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

