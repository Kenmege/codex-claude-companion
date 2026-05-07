import test from "node:test";
import assert from "node:assert/strict";

import { runCommandCapture } from "../scripts/lib/process.mjs";

test("runCommandCapture escalates timeout to SIGKILL when SIGTERM is ignored", { skip: process.platform === "win32" }, async () => {
  const result = await runCommandCapture(
    "sh",
    ["-c", "trap '' TERM; while :; do sleep 1; done"],
    { timeout: 50, terminationGraceMs: 50 }
  );

  assert.equal(result.error?.code, "ETIMEDOUT_KILL");
});
