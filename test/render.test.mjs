import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult } from "../scripts/lib/render.mjs";

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
