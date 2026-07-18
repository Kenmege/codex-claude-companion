import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBridgeRequestContract } from "../scripts/lib/bridge-contracts.mjs";
import { buildBridgeRequest } from "../scripts/lib/bridge-request.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-request-"));
  const workspace = path.join(root, "repo");
  fs.mkdirSync(workspace);
  return { root, workspace };
}

function baseOptions(overrides = {}) {
  const { root, workspace } = fixture();
  return {
    agent: "implementer",
    model: "user-supplied-model-selector",
    effort: "max",
    profile: "trusted-autonomous",
    executor: "tmux",
    workspace: "current",
    workspacePath: workspace,
    permittedRoot: root,
    timeout: 900,
    codexThreadId: "thread-1",
    codexTurnId: null,
    cwd: workspace,
    repoRoot: workspace,
    branch: null,
    head: null,
    resolvedRuntimeVersion: "runtime-fixture",
    promptFile: "prompt.md",
    acceptance: ["tests pass"],
    ...overrides
  };
}

test("builds an immutable schema-valid named-agent request", () => {
  const { root, workspace } = fixture();
  const request = buildBridgeRequest({
    agent: "implementer",
    model: "opus",
    effort: "high",
    profile: "standard",
    executor: "tmux",
    workspace: "current",
    workspacePath: workspace,
    permittedRoot: root,
    timeout: 900,
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    cwd: workspace,
    repoRoot: workspace,
    branch: "feature/request-builder",
    head: "a".repeat(40),
    resolvedRuntimeVersion: "runtime-fixture",
    promptFile: "prompt.md",
    acceptance: ["tests pass"]
  });

  assert.doesNotThrow(() => validateBridgeRequestContract(request));
  assert.match(request.jobId, /^ccb_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(request.execution.tmuxSession, /^ccb-[A-Za-z0-9_-]+$/);
  assert.equal(request.worker.agent, "implementer");
  assert.deepEqual(request.execution.effectiveClaudePermissionArgs, ["--setting-sources=", "--permission-mode", "default"]);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.worker));
  assert.ok(Object.isFrozen(request.execution.effectiveClaudePermissionArgs));
});

test("composes active agent selection with exactly one custom-agent definition source", () => {
  const inline = buildBridgeRequest(baseOptions({
    agents: JSON.stringify({ specialist: { description: "bounded specialist" } })
  }));
  assert.equal(inline.worker.agent, "implementer");
  assert.deepEqual(inline.worker.inlineAgents, { specialist: { description: "bounded specialist" } });

  const fileOptions = baseOptions();
  const agentsFile = path.join(fileOptions.permittedRoot, "agents.json");
  fs.writeFileSync(agentsFile, "this file is deliberately not parsed");
  const fromFile = buildBridgeRequest({ ...fileOptions, agentsFile });
  assert.equal(fromFile.worker.agent, "implementer");
  assert.equal(fromFile.worker.inlineAgents, null);
  assert.equal(fromFile.worker.customAgentsFile, fs.realpathSync(agentsFile));

  assert.throws(
    () => buildBridgeRequest(baseOptions({ agents: { extra: {} }, agentsFile })),
    (error) => error.name === "BridgeRequestError"
      && error.code === "agent_selection_conflict"
      && error.field === "agents"
  );
  const defaultAgent = buildBridgeRequest(baseOptions({ agent: undefined }));
  assert.equal(defaultAgent.worker.agent, null);
  assert.equal(defaultAgent.worker.inlineAgents, null);
  assert.equal(defaultAgent.worker.customAgentsFile, null);
});

test("canonicalizes supported configuration paths without loading their contents", () => {
  const options = baseOptions({ executor: "native-background", workspace: "worktree" });
  const pluginDir = path.join(options.permittedRoot, "plugin");
  const addDir = path.join(options.permittedRoot, "shared");
  const mcpFile = path.join(options.permittedRoot, "mcp.json");
  fs.mkdirSync(pluginDir);
  fs.mkdirSync(addDir);
  fs.writeFileSync(mcpFile, "secret=not-json-and-must-not-be-read");
  const pluginLink = path.join(options.permittedRoot, "plugin-link");
  fs.symlinkSync(pluginDir, pluginLink);

  const request = buildBridgeRequest({
    ...options,
    pluginDirs: [pluginLink],
    mcpConfigs: [mcpFile],
    addDirs: addDir,
    settingSources: "user,project,user"
  });

  assert.equal(request.worker.model, "user-supplied-model-selector");
  assert.deepEqual(request.worker.pluginDirs, [fs.realpathSync(pluginDir)]);
  assert.deepEqual(request.worker.mcpConfigPaths, [fs.realpathSync(mcpFile)]);
  assert.deepEqual(request.worker.addDirs, [fs.realpathSync(addDir)]);
  assert.deepEqual(request.worker.settingSources, ["user", "project"]);
  assert.equal(request.execution.executor, "native-background");
  assert.equal(request.execution.tmuxSession, null);
  assert.equal(request.execution.workspaceMode, "worktree");
  assert.deepEqual(request.execution.effectiveClaudePermissionArgs, ["--setting-sources=user,project", "--permission-mode", "bypassPermissions"]);
  assert.doesNotThrow(() => validateBridgeRequestContract(request));
});

test("rejects canonical symlink escapes for the workspace and auxiliary paths", () => {
  const options = baseOptions();
  const outside = fixture().workspace;
  const escapedWorkspace = path.join(options.permittedRoot, "escaped-workspace");
  fs.symlinkSync(outside, escapedWorkspace);
  assert.throws(
    () => buildBridgeRequest({ ...options, workspacePath: escapedWorkspace }),
    (error) => error.code === "path_outside_permitted_root" && error.field === "workspacePath"
  );

  const escapedPlugin = path.join(options.permittedRoot, "escaped-plugin");
  fs.symlinkSync(outside, escapedPlugin);
  assert.throws(
    () => buildBridgeRequest({ ...options, pluginDirs: [escapedPlugin] }),
    (error) => error.code === "path_outside_permitted_root" && error.field === "pluginDirs[0]"
  );
});

test("uses stable error codes for unsafe or contradictory CLI-shaped options", () => {
  const checks = [
    {
      options: { agents: { specialist: { apiKey: "must-not-persist" } }, agent: undefined },
      code: "secret_value_forbidden",
      field: "agents"
    },
    {
      options: { mcpConfigs: [' {"mcpServers":{"x":{"env":{"TOKEN":"secret"}}}}'] },
      code: "inline_mcp_config_forbidden",
      field: "mcpConfigs"
    },
    { options: { settingSources: ["project", "remote"] }, code: "invalid_setting_source", field: "settingSources" },
    { options: { timeout: 0 }, code: "invalid_timeout", field: "timeout" },
    { options: { executor: "shell" }, code: "invalid_executor", field: "executor" },
    { options: { workspace: "somewhere" }, code: "invalid_workspace_mode", field: "workspace" },
    { options: { pluginDirs: ["relative/plugin"] }, code: "path_not_absolute", field: "pluginDirs[0]" },
    { options: { profile: "unshackled" }, code: "policy_invalid", field: "profile" }
  ];

  for (const check of checks) {
    assert.throws(
      () => buildBridgeRequest(baseOptions(check.options)),
      (error) => error.name === "BridgeRequestError"
        && error.code === check.code
        && error.field === check.field,
      `${check.code}:${check.field}`
    );
  }

  const options = baseOptions();
  const agentsFile = path.join(options.permittedRoot, "agents.json");
  fs.writeFileSync(agentsFile, "{}");
  assert.throws(
    () => buildBridgeRequest({ ...options, agent: undefined, agentsFile, customAgentsFile: agentsFile }),
    (error) => error.code === "agent_selection_conflict" && error.field === "agentsFile"
  );
});

test("preserves the review-readonly policy's exact effective permission arguments", () => {
  const request = buildBridgeRequest(baseOptions({ profile: "review-readonly" }));
  assert.equal(request.execution.effectiveClaudePermissionArgs[0], "--setting-sources=");
  const permissionModeIndex = request.execution.effectiveClaudePermissionArgs.indexOf("--permission-mode");
  assert.equal(request.execution.effectiveClaudePermissionArgs[permissionModeIndex + 1], "default");
  assert.equal(request.execution.effectiveClaudePermissionArgs.at(-1), "--strict-mcp-config");
  assert.doesNotThrow(() => validateBridgeRequestContract(request));
});
