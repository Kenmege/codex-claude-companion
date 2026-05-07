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
      model: "claude-opus-4-7",
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

test("renderSetupReport surfaces subscription-auth detection and safe-mode banner", () => {
  const subscriptionOutput = renderSetupReport({
    ready: true,
    claude: { detail: "claude 4.7 available" },
    auth: { detail: "user@example.com via claude-max" },
    runtime: { detail: "non-interactive print verified using project,local" },
    subscription: true,
    defaults: { model: "claude-opus-4-7", effort: "high", autoLongContextBytes: 250000 },
    nextSteps: []
  });
  assert.match(subscriptionOutput, /subscription auth detected: yes/);
  assert.match(subscriptionOutput, /safe-mode fence active/);

  const apiKeyOutput = renderSetupReport({
    ready: true,
    claude: { detail: "claude 4.7 available" },
    auth: { detail: "user via api-key" },
    runtime: { detail: "ok" },
    subscription: false,
    defaults: { model: "claude-opus-4-7", effort: "high", autoLongContextBytes: 250000 },
    nextSteps: []
  });
  assert.match(apiKeyOutput, /subscription auth detected: no/);
});
