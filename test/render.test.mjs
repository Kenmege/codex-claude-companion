import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderSetupReport } from "../scripts/lib/render.mjs";

test("renderReviewResult renders elite review reports with rich sections", () => {
  const output = renderReviewResult(
    {
      reviewKind: "elite-review",
      reviewLabel: "Elite Review",
      targetLabel: "working tree diff",
      model: "claude-opus-4-6",
      effort: "high",
      profile: "quality",
      contextMode: "full",
      notes: ["Focused on architecture and rollback safety."]
    },
    {
      parsed: {
        verdict: "REQUEST_CHANGES",
        ship_recommendation: "NO_SHIP",
        executive_summary: "The change is promising but still exposes recovery and compatibility risks.",
        systemic_risks: ["The rollout path has no clear rollback contract."],
        findings: [
          {
            severity: "high",
            confidence: 0.91,
            risk_category: "rollback",
            title: "Rollback path is undefined",
            body: "The migration adds a forward-only state transition without a paired reversal path.",
            failure_scenario: "A failed deploy leaves mixed state across nodes.",
            why_vulnerable: "The code writes the new state eagerly and does not preserve an old-state restore point.",
            impact: "Operators may need manual repair during a production rollback.",
            file: "src/migrate.js",
            line_start: 42,
            line_end: 57,
            recommendation: "Stage writes behind a reversible migration record and explicit rollback handler.",
            test_gap: "There is no integration test covering rollback after a partial write."
          }
        ],
        blind_spots: ["The review input does not include deployment orchestration code."],
        next_steps: ["Add rollback coverage before shipping."]
      }
    },
    {
      id: "elite-123"
    }
  );

  assert.match(output, /# Claude Elite Review/);
  assert.match(output, /Ship Recommendation: NO_SHIP/);
  assert.match(output, /Systemic Risks:/);
  assert.match(output, /Risk Category: rollback/);
  assert.match(output, /Confidence: 0\.91/);
  assert.match(output, /Blind Spots:/);
});

test("renderReviewResult includes agentic evidence, verified claims, and exploration log", () => {
  const output = renderReviewResult(
    {
      reviewKind: "deep-review",
      reviewLabel: "Deep Review",
      targetLabel: "branch diff against origin/main",
      model: "opus",
      effort: "max",
      profile: "quality",
      contextMode: "summarized",
      agentic: true,
      notes: ["Running in agentic mode with read-only tools."]
    },
    {
      parsed: {
        verdict: "REQUEST_CHANGES",
        ship_recommendation: "NO_SHIP",
        executive_summary: "Authz check is bypassable; rollback contract missing.",
        systemic_risks: ["No coherent rollback story for the new migration table."],
        findings: [
          {
            severity: "critical",
            confidence: 0.94,
            risk_category: "OWASP A01:2021 Broken Access Control",
            title: "Tenant scope dropped on bulk endpoint",
            body: "The bulk update path forgets to apply the tenant filter.",
            failure_scenario: "Cross-tenant data overwrite via the bulk update API.",
            why_vulnerable: "tenantId param is sourced from the request body instead of the verified session.",
            impact: "Cross-tenant data corruption; reportable incident.",
            exploitability: "post-auth-remote",
            file: "src/api/bulk.ts",
            line_start: 88,
            line_end: 102,
            recommendation: "Bind tenantId from the authenticated session and reject divergent body values.",
            test_gap: "No test asserts cross-tenant rejection on the bulk endpoint.",
            evidence: [
              {
                tool: "Grep",
                query: "tenantId",
                confirmed: "Body-sourced tenantId observed at src/api/bulk.ts:88",
                source: "parent"
              },
              {
                tool: "Read",
                query: "src/middleware/tenant.ts",
                confirmed: "Tenant middleware is not mounted on /bulk routes",
                source: "subagent:authz-trace"
              }
            ]
          }
        ],
        verified_claims: [
          {
            claim: "Tenant middleware is mounted on /v1 routes",
            verification: "Confirmed via Read of src/server.ts:42-48"
          }
        ],
        blind_spots: ["Could not verify behavior under partial DB outage; load harness not in repo."],
        exploration_log: [
          {
            step: 1,
            tool: "Grep",
            rationale: "Locate authz invocations across changed files",
            outcome: "Found two call sites; one in changed bulk endpoint"
          }
        ],
        next_steps: ["Add cross-tenant rejection test to the bulk endpoint suite."]
      },
      activity: {
        toolUseCount: 7,
        toolUses: [
          { name: "Grep", input: {} },
          { name: "Read", input: {} },
          { name: "Grep", input: {} },
          { name: "Bash", input: {} },
          { name: "Task", input: {} },
          { name: "Read", input: {} },
          { name: "Read", input: {} }
        ],
        totalTokensIn: 12000,
        totalTokensOut: 3400,
        costUsd: 1.2345,
        durationMs: 60000
      }
    },
    {
      id: "deep-456"
    }
  );

  assert.match(output, /# Claude Deep Review/);
  assert.match(output, /Mode: agentic/);
  assert.match(output, /Activity: tool calls: 7/);
  assert.match(output, /Exploitability: post-auth-remote/);
  assert.match(output, /Evidence:/);
  assert.match(output, /Grep \[parent\]: tenantId -> Body-sourced tenantId/);
  assert.match(output, /Read \[subagent:authz-trace\]:/);
  assert.match(output, /Verified Claims:/);
  assert.match(output, /Exploration Log:/);
  assert.match(output, /Tool usage:/);
});

test("renderReviewResult surfaces M2 evidence cross-check warnings and aggregate", () => {
  const output = renderReviewResult(
    {
      reviewKind: "elite-review",
      reviewLabel: "Elite Review",
      targetLabel: "working tree diff",
      model: "opus",
      effort: "max",
      profile: "quality",
      contextMode: "full"
    },
    {
      parsed: {
        verdict: "REQUEST_CHANGES",
        ship_recommendation: "NO_SHIP",
        executive_summary: "Two findings; one cites an unobserved tool.",
        systemic_risks: [],
        findings: [
          {
            severity: "high",
            confidence: 0.9,
            risk_category: "correctness",
            title: "Real finding",
            body: "Backed by Read.",
            failure_scenario: "Race.",
            why_vulnerable: "No lock.",
            impact: "Loss.",
            exploitability: "Local.",
            file: "src/a.js",
            line_start: 10,
            line_end: 12,
            recommendation: "Lock.",
            test_gap: "no test",
            evidence: [{ tool: "Read", query: "src/a.js", confirmed: "race seen" }]
          },
          {
            severity: "medium",
            confidence: 0.6,
            risk_category: "supply-chain",
            title: "Suspect finding",
            body: "Cites a tool that was not invoked.",
            failure_scenario: "Hypothesis only.",
            why_vulnerable: "Maybe.",
            impact: "Maybe.",
            exploitability: "Maybe.",
            file: "src/b.js",
            line_start: null,
            line_end: null,
            recommendation: "Investigate.",
            test_gap: "n/a",
            evidence: [{ tool: "Phantom", query: "x", confirmed: "made up" }]
          }
        ],
        verified_claims: [],
        blind_spots: [],
        exploration_log: [],
        next_steps: []
      },
      activity: {
        toolUseCount: 1,
        toolUses: [{ name: "Read", input: { file_path: "src/a.js" } }]
      },
      evidenceVerification: {
        findingCount: 2,
        findingsWithUnverifiedEvidence: 1,
        perFinding: [
          { index: 0, total: 1, verified: 1, unverified: 0, unverifiedTools: [] },
          { index: 1, total: 1, verified: 0, unverified: 1, unverifiedTools: ["Phantom"] }
        ]
      }
    }
  );
  assert.match(output, /⚠ Evidence cross-check:.*0\/1 cited tools observed.*1 unverified.*Phantom/);
  assert.match(output, /Evidence cross-check: 1\/2 findings have all citations observed/);
  assert.match(output, /1 finding\(s\) cite tools not observed/);
});

test("renderReviewResult attaches evidence cross-check to the right finding after severity sort", () => {
  // Regression test for the Copilot finding on PR #11: renderRichReviewResult
  // sorts findings by severity, but the verification array is indexed by the
  // original parsed.findings order. Without an identity-keyed lookup, the
  // ⚠ warning attaches to the wrong finding (or misses).
  // Setup: parsed.findings is [LOW (verified), HIGH (unverified)]. After sort,
  // HIGH renders first — so the ⚠ must appear under HIGH, not LOW.
  const output = renderReviewResult(
    {
      reviewKind: "elite-review",
      reviewLabel: "Elite Review",
      targetLabel: "working tree diff",
      model: "opus",
      effort: "max",
      profile: "quality",
      contextMode: "full"
    },
    {
      parsed: {
        verdict: "REQUEST_CHANGES",
        ship_recommendation: "NO_SHIP",
        executive_summary: "Sort-order regression check.",
        systemic_risks: [],
        findings: [
          {
            severity: "low",
            confidence: 0.5,
            risk_category: "style",
            title: "LOW finding (verified)",
            body: "Cited tool was actually invoked.",
            failure_scenario: "n/a",
            why_vulnerable: "n/a",
            impact: "n/a",
            exploitability: "n/a",
            file: "src/low.js",
            line_start: null,
            line_end: null,
            recommendation: "n/a",
            test_gap: "n/a",
            evidence: [{ tool: "Read", query: "src/low.js", confirmed: "ok" }]
          },
          {
            severity: "high",
            confidence: 0.9,
            risk_category: "correctness",
            title: "HIGH finding (UNVERIFIED)",
            body: "Cited tool was NOT in the stream.",
            failure_scenario: "n/a",
            why_vulnerable: "n/a",
            impact: "n/a",
            exploitability: "n/a",
            file: "src/high.js",
            line_start: null,
            line_end: null,
            recommendation: "n/a",
            test_gap: "n/a",
            evidence: [{ tool: "Phantom", query: "x", confirmed: "made up" }]
          }
        ],
        verified_claims: [],
        blind_spots: [],
        exploration_log: [],
        next_steps: []
      },
      activity: { toolUseCount: 1, toolUses: [{ name: "Read", input: {} }] },
      evidenceVerification: {
        findingCount: 2,
        findingsWithUnverifiedEvidence: 1,
        perFinding: [
          { index: 0, total: 1, verified: 1, unverified: 0, unverifiedTools: [] },
          { index: 1, total: 1, verified: 0, unverified: 1, unverifiedTools: ["Phantom"] }
        ]
      }
    }
  );
  // After severity sort HIGH comes first: per-finding warning must appear
  // UNDER HIGH and BEFORE the LOW block.
  const highIdx = output.indexOf("HIGH finding (UNVERIFIED)");
  const lowIdx = output.indexOf("LOW finding (verified)");
  // Match only the per-finding warning shape `⚠ Evidence cross-check: N/M
  // cited tools observed`, not the aggregate footer's prose reference to
  // `⚠ Evidence cross-check lines above`.
  const perFindingRe = /⚠ Evidence cross-check: \d+\/\d+ cited tools observed/g;
  const matches = [...output.matchAll(perFindingRe)];
  const warnIdx = matches[0]?.index ?? -1;
  assert.ok(highIdx !== -1 && lowIdx !== -1 && warnIdx !== -1, "all sections must render");
  assert.ok(highIdx < warnIdx, "warning must appear after the HIGH header");
  assert.ok(warnIdx < lowIdx, "warning must appear before the LOW header (i.e., attached to HIGH, not LOW)");
  assert.equal(matches.length, 1, "expected exactly one per-finding cross-check warning");
});

test("renderSetupReport surfaces subscription-auth detection and safe-mode banner", () => {
  const subscriptionOutput = renderSetupReport({
    ready: true,
    claude: { detail: "claude opus alias available" },
    auth: { detail: "user@example.com via claude-max" },
    runtime: { detail: "non-interactive print verified using project,local" },
    subscription: true,
    defaults: { model: "opus", effort: "xhigh", autoLongContextBytes: 250000 },
    nextSteps: []
  });
  assert.match(subscriptionOutput, /subscription auth detected: yes/);
  assert.match(subscriptionOutput, /safe-mode fence active/);

  const apiKeyOutput = renderSetupReport({
    ready: true,
    claude: { detail: "claude opus alias available" },
    auth: { detail: "user via api-key" },
    runtime: { detail: "ok" },
    subscription: false,
    defaults: { model: "opus", effort: "xhigh", autoLongContextBytes: 250000 },
    nextSteps: []
  });
  assert.match(apiKeyOutput, /subscription auth detected: no/);
});
