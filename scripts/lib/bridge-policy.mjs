import fs from "node:fs";
import path from "node:path";

import {
  AGENTIC_ALLOWED_TOOLS,
  AGENTIC_DISALLOWED_TOOLS,
  AGENTIC_TOOLS,
  buildWebFetchAllowlist
} from "./claude.mjs";

const READONLY_PERMISSION_ARGS = Object.freeze([
  "--setting-sources=",
  "--tools", ...AGENTIC_TOOLS,
  "--allowedTools", ...AGENTIC_ALLOWED_TOOLS, ...buildWebFetchAllowlist(),
  "--disallowedTools", ...AGENTIC_DISALLOWED_TOOLS,
  "--permission-mode", "default",
  "--strict-mcp-config"
]);

const STANDARD_PERMISSION_ARGS = Object.freeze(["--permission-mode", "default"]);
const AUTONOMOUS_PERMISSION_ARGS = Object.freeze(["--permission-mode", "bypassPermissions"]);

export const BRIDGE_TRUST_PROFILES = Object.freeze({
  "review-readonly": Object.freeze({
    permissionMode: "default",
    autonomous: false,
    requiresSandbox: false,
    writeAccess: false,
    claudeArgs: READONLY_PERMISSION_ARGS
  }),
  standard: Object.freeze({
    permissionMode: "default",
    autonomous: false,
    requiresSandbox: false,
    writeAccess: true,
    claudeArgs: STANDARD_PERMISSION_ARGS
  }),
  "trusted-autonomous": Object.freeze({
    permissionMode: "bypassPermissions",
    autonomous: true,
    requiresSandbox: false,
    writeAccess: true,
    claudeArgs: AUTONOMOUS_PERMISSION_ARGS
  }),
  "sandbox-autonomous": Object.freeze({
    permissionMode: "bypassPermissions",
    autonomous: true,
    requiresSandbox: true,
    writeAccess: true,
    claudeArgs: AUTONOMOUS_PERMISSION_ARGS
  })
});

export const BRIDGE_AGENT_PRESETS = Object.freeze({
  implementer: Object.freeze({
    agent: "implementer",
    defaultProfile: "standard",
    description: "Implements a bounded change and runs the repository-native validation gate."
  }),
  debugger: Object.freeze({
    agent: "debugger",
    defaultProfile: "standard",
    description: "Reproduces, diagnoses, and fixes a concrete failure."
  }),
  reviewer: Object.freeze({
    agent: "reviewer",
    defaultProfile: "review-readonly",
    description: "Performs a shell-free, read-only correctness review."
  }),
  "security-reviewer": Object.freeze({
    agent: "security-reviewer",
    defaultProfile: "review-readonly",
    description: "Performs a shell-free, read-only security review."
  }),
  researcher: Object.freeze({
    agent: "researcher",
    defaultProfile: "review-readonly",
    description: "Investigates local and approved external evidence without workspace edits."
  }),
  "elite-reviewer": Object.freeze({
    agent: "elite-reviewer",
    defaultProfile: "review-readonly",
    description: "Performs the strongest shell-free, read-only adversarial review preset."
  })
});

const READONLY_REQUESTABLE_TOOLS = new Set([
  ...AGENTIC_ALLOWED_TOOLS,
  ...buildWebFetchAllowlist()
]);

function canonicalDirectory(profile, label, workspacePath) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    throw new Error(`Bridge trust profile "${profile}" requires an explicit absolute ${label}.`);
  }
  try {
    const canonicalPath = fs.realpathSync(workspacePath);
    if (!fs.statSync(canonicalPath).isDirectory()) throw new Error("not a directory");
    return canonicalPath;
  } catch {
    throw new Error(`Bridge trust profile "${profile}" requires ${label} to be an existing directory.`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateSandboxAttestation(profile, options) {
  const attestation = options.sandboxAttestation;
  if (profile !== "sandbox-autonomous") {
    if (attestation !== undefined && attestation !== null) {
      throw new Error(`Bridge trust profile "${profile}" forbids sandbox attestation.`);
    }
    return null;
  }
  throw new Error(
    `Bridge trust profile "${profile}" is unavailable: executor-owned provenance verification is not implemented.`
  );
}

function validateRequestedTools(profile, requestedTools) {
  if (requestedTools === undefined) return;
  if (!Array.isArray(requestedTools) || requestedTools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    throw new Error("requestedTools must be an array of non-empty tool names.");
  }
  if (profile !== "review-readonly") return;
  const unsupported = requestedTools.find((tool) => !READONLY_REQUESTABLE_TOOLS.has(tool.trim()));
  if (unsupported) {
    throw new Error(`Bridge trust profile "review-readonly" cannot request tool "${unsupported}" outside its explicit allowlist.`);
  }
}

export function resolveBridgePolicy(options = {}) {
  const profileName = options.profile;
  const profile = BRIDGE_TRUST_PROFILES[profileName];
  if (!profile) {
    throw new Error(
      `Unknown bridge trust profile "${String(profileName)}". Allowed profiles: ${Object.keys(BRIDGE_TRUST_PROFILES).join(", ")}.`
    );
  }

  if (Object.hasOwn(options, "sandboxed")) {
    throw new Error("sandboxed booleans are not accepted; provide an executor-produced sandboxAttestation.");
  }

  if (typeof options.workspacePath !== "string" || !path.isAbsolute(options.workspacePath)) {
    throw new Error(`Bridge trust profile "${profileName}" requires an explicit absolute workspacePath.`);
  }
  const requestedWorkspacePath = options.workspacePath;
  const canonicalWorkspacePath = canonicalDirectory(profileName, "workspacePath", requestedWorkspacePath);
  const canonicalPermittedRoot = options.permittedRoot === undefined
    ? null
    : canonicalDirectory(profileName, "permittedRoot", options.permittedRoot);
  if (canonicalPermittedRoot && !isWithin(canonicalPermittedRoot, canonicalWorkspacePath)) {
    throw new Error(`Canonical workspace is outside permittedRoot for bridge trust profile "${profileName}".`);
  }
  validateRequestedTools(profileName, options.requestedTools);

  if (options.permissionMode !== undefined && options.permissionMode !== profile.permissionMode) {
    throw new Error(
      `Bridge trust profile "${profileName}" requires permissionMode "${profile.permissionMode}", not "${options.permissionMode}".`
    );
  }

  const sandboxAttestation = validateSandboxAttestation(profileName, options);

  return deepFreeze({
    profile: profileName,
    permissionMode: profile.permissionMode,
    autonomous: profile.autonomous,
    requiresSandbox: profile.requiresSandbox,
    writeAccess: profile.writeAccess,
    requestedWorkspacePath,
    canonicalWorkspacePath,
    workspacePath: canonicalWorkspacePath,
    permittedRoot: canonicalPermittedRoot,
    sandboxAttestation,
    claudeArgs: [...profile.claudeArgs]
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
