import test from "node:test";
import assert from "node:assert/strict";

import {
  processTreeOwnsJob,
  terminateProcessTree,
  terminateTrackedJobProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

function fakePs(command) {
  return (binary, args, options) => {
    assert.equal(binary, "ps");
    assert.equal(options.timeout > 0, true);
    return { status: 0, stdout: `${command}\n`, stderr: "", error: null };
  };
}

const WORKER_COMMAND =
  "/usr/bin/node /repo/plugins/codex/scripts/codex-companion.mjs task-worker --cwd /repo --job-id task-abc123";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("processTreeOwnsJob confirms the recorded worker still owns the pid", () => {
  assert.equal(
    processTreeOwnsJob(4321, "task-abc123", {
      platform: "linux",
      inspectProcess: fakePs(WORKER_COMMAND)
    }),
    true
  );
});

test("processTreeOwnsJob tolerates a quoted (Windows) script path", () => {
  const quoted =
    '"C:\\Program Files\\codex companion dir\\codex-companion.mjs" task-worker --cwd C:\\repo --job-id task-abc123';
  assert.equal(
    processTreeOwnsJob(4321, "task-abc123", {
      platform: "win32",
      inspectProcess: () => ({ status: 0, stdout: `${quoted}\n`, stderr: "", error: null })
    }),
    true
  );
});

test("processTreeOwnsJob rejects a reused pid running an unrelated process", () => {
  assert.equal(
    processTreeOwnsJob(4321, "task-abc123", {
      platform: "linux",
      inspectProcess: fakePs("/usr/bin/less /var/log/system.log")
    }),
    false
  );
  assert.equal(
    processTreeOwnsJob(4321, "task-abc123", {
      platform: "linux",
      inspectProcess: fakePs(WORKER_COMMAND.replace("task-abc123", "task-different"))
    }),
    false
  );
});

test("terminateTrackedJobProcessTree only signals a verified job worker", () => {
  const terminated = [];
  const terminate = (pid) => {
    terminated.push(pid);
    return { attempted: true, delivered: true, method: "process-group" };
  };

  const owned = terminateTrackedJobProcessTree(
    { id: "task-abc123", pid: 4321 },
    { platform: "linux", inspectProcess: fakePs(WORKER_COMMAND), terminate }
  );
  assert.deepEqual(terminated, [4321]);
  assert.equal(owned.delivered, true);

  const reused = terminateTrackedJobProcessTree(
    { id: "task-abc123", pid: 4321 },
    { platform: "linux", inspectProcess: fakePs("/bin/bash -lc deploy"), terminate }
  );
  assert.deepEqual(terminated, [4321]);
  assert.equal(reused.attempted, false);
  assert.equal(reused.method, null);
});

test("terminateTrackedJobProcessTree skips a job with no recorded pid", () => {
  const outcome = terminateTrackedJobProcessTree(
    { id: "task-abc123", pid: null },
    {
      platform: "linux",
      inspectProcess() {
        throw new Error("process inspection must not run without a pid");
      },
      terminate() {
        throw new Error("terminate must not run without a pid");
      }
    }
  );
  assert.equal(outcome.attempted, false);
});
