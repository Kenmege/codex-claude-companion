import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fc from "fast-check";

import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";
import { renderStatusReport, renderJobStatusReport, renderStoredJobResult, renderCancelReport } from "../plugins/codex/scripts/lib/render.mjs";
import * as state from "../plugins/codex/scripts/lib/state.mjs";

const config = { valueOptions: ["prompt"], booleanOptions: ["wait"], aliasMap: { p: "prompt", w: "wait" } };
// Bias toward delimiter/control/Unicode boundaries while retaining arbitrary strings.
const text = fc.oneof(fc.string({ maxLength: 80 }), fc.constantFrom("", "=", "a=b=c", "--", "--wait", "-p", "\\|", "\r", "\n", "\r\n", "\u0000", "💡e\u0301", "../x", "C:\\x"));

test("fuzz: argv parsing accepts arbitrary string arrays or the missing-value Error", () => {
  fc.assert(fc.property(fc.array(text, { maxLength: 24 }), argv => {
    let parsed;
    try { parsed = parseArgs(argv, config); }
    catch (error) {
      assert.equal(error.constructor, Error);
      assert.match(error.message, /^Missing value for (?:--prompt|-p)$/);
      return;
    }
    assert.ok(Array.isArray(parsed.positionals));
    assert.equal(typeof parsed.options, "object");
  }), { numRuns: 150 });
});

test("fuzz: known flags round-trip inline and separate values, aliases and terminators", () => {
  fc.assert(fc.property(text, fc.boolean(), fc.array(text, { maxLength: 8 }), (value, wait, rest) => {
    for (const argv of [
      [`--prompt=${value}`, `--wait=${wait}`, "--", ...rest],
      ["-p", value, ...(wait ? ["-w"] : ["--wait=false"]), "--", ...rest]
    ]) {
      const parsed = parseArgs(argv, config);
      assert.equal(parsed.options.prompt, value);
      assert.equal(parsed.options.wait, wait);
      assert.deepEqual(parsed.positionals, rest);
    }
  }), { numRuns: 150 });
});

test("fuzz: separate option values are data even when they resemble flags", () => {
  fc.assert(fc.property(fc.constantFrom("--wait", "--", "-w", "--prompt=x"), value => {
    const parsed = parseArgs(["--prompt", value], config);
    assert.deepEqual(parsed, { options: { prompt: value }, positionals: [] });
    assert.deepEqual(parseArgs(["--", value], config), { options: {}, positionals: [value] });
  }), { numRuns: 25 });
});

function statusReport(job) {
  return renderStatusReport({ sessionRuntime: { label: "test" }, config: {}, running: [job], recent: [] });
}

test("fuzz: Markdown table cells preserve row and column boundaries", () => {
  fc.assert(fc.property(text, value => {
    const output = statusReport({ id: "job-safe", status: "running", summary: value, phase: value, kindLabel: value, elapsed: value, threadId: value });
    const rows = output.split("\n").filter(line => line.startsWith("|"));
    assert.equal(rows.length, 3);
    // A Markdown delimiter is a pipe preceded by an even number of backslashes.
    const row = rows[2];
    assert.doesNotMatch(row, /[\r\n\u2028\u2029]/);
    let delimiters = 0;
    let slashes = 0;
    for (const character of row) {
      if (character === "|" && slashes % 2 === 0) delimiters++;
      slashes = character === "\\" ? slashes + 1 : 0;
    }
    assert.equal(delimiters, 9, row);
  }), { numRuns: 150 });
});

test("fuzz: job renderers accept arbitrary summary text and optional job fields", () => {
  const job = fc.record({
    id: fc.constant("job-render"), status: fc.constantFrom("queued", "running", "completed", "failed", "cancelled"),
    summary: fc.jsonValue(), title: text, phase: text, threadId: text, elapsed: text, duration: text,
    progressPreview: fc.array(text, { maxLength: 5 })
  });
  fc.assert(fc.property(job, value => {
    for (const output of [statusReport(value), renderJobStatusReport(value), renderStoredJobResult(value, {}), renderCancelReport(value)]) {
      assert.equal(typeof output, "string");
      assert.ok(output.endsWith("\n"));
    }
  }), { numRuns: 100 });
});

// node:test executes these top-level tests sequentially in their own process.
// Always restore the host setting, including when fast-check shrinks a failure.
function inWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "plugin-data");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  try {
    const jobs = state.resolveJobsDir(workspace);
    assert.ok(jobs.startsWith(`${process.env.CLAUDE_PLUGIN_DATA}${path.sep}`));
    return run(workspace, jobs);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("fuzz: arbitrary job ids are rejected or every artifact stays inside jobs", () => {
  inWorkspace((workspace, jobs) => {
    const ids = fc.oneof(text, fc.constantFrom("..", "../escape", "..\\escape", "/tmp/escape", "C:\\escape", "\\\\host\\share", "a\u0000b", "a".repeat(129)),
      fc.array(fc.constantFrom(..."abcXYZ019_-"), { minLength: 1, maxLength: 128 }).map(chars => chars.join("")));
    fc.assert(fc.property(ids, id => {
      // Independent specification of the public ID grammar, also checking rejection.
      const allowed = id.length >= 1 && id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
      for (const resolve of [state.resolveJobFile, state.resolveJobLogFile]) {
        if (!allowed) {
          assert.throws(() => resolve(workspace, id), /Invalid job id/);
          continue;
        }
        const file = resolve(workspace, id);
        for (const artifact of [file, state.terminalMarkerFile(file)]) {
          assert.equal(path.dirname(artifact), jobs);
          // Containment uses the host grammar (native separators); the file name must also be a
          // single segment under both grammars, so it cannot escape on either platform.
          const relative = path.relative(jobs, artifact);
          assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
          for (const grammar of [path.posix, path.win32]) {
            assert.equal(grammar.basename(relative), relative);
          }
        }
      }
    }), { numRuns: 60 });
    fc.assert(fc.property(fc.constantFrom("job", "task", "review", "A_1"), prefix => {
      const id = state.generateJobId(prefix);
      assert.equal(path.dirname(state.resolveJobFile(workspace, id)), jobs);
      assert.equal(path.dirname(state.resolveJobLogFile(workspace, id)), jobs);
    }), { numRuns: 20 });
  });
});

test("fuzz: job operation sequences preserve terminal outcomes, retention and running jobs", () => {
  const terminal = ["completed", "failed", "cancelled"];
  const operation = fc.record({
    kind: fc.constantFrom("create", "update", "publish", "prune"),
    slot: fc.integer({ min: 0, max: 10 }),
    status: fc.constantFrom("running", ...terminal), summary: text
  });
  fc.assert(fc.property(fc.integer({ min: 51, max: 54 }), fc.array(operation, { minLength: 12, maxLength: 24 }), (count, operations) => {
    inWorkspace((workspace, jobsDir) => {
      const model = new Map();
      const snapshots = new Map();
      let tick = 0;
      const stamp = () => new Date(Date.UTC(2020, 0, 1, 0, 0, tick++)).toISOString();
      function pruneModel() {
        const finished = [...model.values()].filter(job => terminal.includes(job.status))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        for (const job of finished.slice(50)) {
          model.delete(job.id);
          snapshots.delete(job.id);
          for (const suffix of [".json", ".terminal.json", ".log"]) {
            assert.equal(fs.existsSync(path.join(jobsDir, `${job.id}${suffix}`)), false);
          }
        }
      }
      function check() {
        const listed = state.listJobs(workspace);
        assert.deepEqual(listed.map(job => job.id).sort(), [...model.keys()].sort());
        for (const job of listed) {
          const expected = model.get(job.id);
          for (const key of ["status", "summary", "updatedAt"]) assert.equal(job[key], expected[key]);
          const file = path.join(jobsDir, `${job.id}.json`);
          assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).id, job.id);
          if (snapshots.has(job.id)) {
            assert.deepEqual(state.readJobFile(file), snapshots.get(job.id));
            assert.deepEqual(JSON.parse(fs.readFileSync(state.terminalMarkerFile(file), "utf8")), snapshots.get(job.id));
          }
        }
      }
      // Every generated sequence crosses the retention boundary; running jobs
      // are deliberately older than every finished job and must still survive.
      for (let index = 0; index < count + 3; index++) {
        const id = index < 3 ? `running-${index}` : `job-${index - 3}`;
        const job = { id, status: index < 3 ? "running" : terminal[index % 3], summary: `initial ${index}`, updatedAt: stamp() };
        state.writeJobFile(workspace, id, job);
        fs.writeFileSync(path.join(jobsDir, `${id}.log`), "log");
        model.set(id, job);
        if (index >= 3) snapshots.set(id, job);
      }
      state.saveState(workspace, {});
      pruneModel();
      check();
      for (const op of operations) {
        const id = op.slot < 3 ? `running-${op.slot}` : `job-${op.slot - 3}`;
        const status = op.kind === "publish" ? terminal[op.slot % 3] : op.kind === "create" ? "queued" : op.status;
        const patch = { id, status, summary: op.summary, updatedAt: stamp() };
        const before = model.get(id);
        if (op.kind === "prune") {
          state.saveState(workspace, {});
        } else {
          let published;
          if (op.kind === "create") state.upsertJob(workspace, patch);
          else if (op.kind === "update") state.writeJobFile(workspace, id, { ...before, ...patch });
          else published = state.publishTerminalJob(workspace, id, patch);
          if (published) assert.equal(published.won, !before || !terminal.includes(before.status));
          if (!before || !terminal.includes(before.status)) {
            model.set(id, { ...before, ...patch });
            if (terminal.includes(status)) {
              const actual = state.readJobFile(path.join(jobsDir, `${id}.json`));
              for (const key of ["status", "summary", "updatedAt"]) assert.equal(actual[key], patch[key]);
              snapshots.set(id, actual);
            }
          }
        }
        if (op.kind === "prune" || op.kind === "create") pruneModel();
        check();
      }
      state.saveState(workspace, {});
      pruneModel();
      check();
      assert.ok([...model.values()].filter(job => terminal.includes(job.status)).length <= 50);
    });
  }), { numRuns: 3 });
});
