function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatConfidence(confidence) {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return "unknown";
  }
  return confidence.toFixed(2);
}

function formatActivity(activity) {
  if (!activity) return [];
  const lines = [];
  const parts = [];
  if (typeof activity.toolUseCount === "number") {
    parts.push(`tool calls: ${activity.toolUseCount}`);
  }
  if (typeof activity.taskDispatchCount === "number" && activity.taskDispatchCount > 0) {
    parts.push(`task dispatches: ${activity.taskDispatchCount}`);
  }
  if (typeof activity.totalTokensIn === "number" && activity.totalTokensIn > 0) {
    parts.push(`tokens in: ${activity.totalTokensIn}`);
  }
  if (typeof activity.totalTokensOut === "number" && activity.totalTokensOut > 0) {
    parts.push(`tokens out: ${activity.totalTokensOut}`);
  }
  if (typeof activity.costUsd === "number") {
    parts.push(`cost: $${activity.costUsd.toFixed(4)}`);
  }
  if (typeof activity.durationMs === "number") {
    parts.push(`duration: ${(activity.durationMs / 1000).toFixed(1)}s`);
  }
  if (parts.length) {
    lines.push(`Activity: ${parts.join(" | ")}`);
  }
  return lines;
}

function formatToolUseSummary(activity) {
  if (!activity?.toolUses?.length) return [];
  const counts = new Map();
  for (const use of activity.toolUses) {
    counts.set(use.name, (counts.get(use.name) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ["Tool usage:", ...ordered.map(([name, count]) => `- ${name}: ${count}`)];
}

export function renderSetupReport(report) {
  const lines = [
    "# Claude Review Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    `- claude: ${report.claude.detail}`,
    `- auth: ${report.auth.detail}`,
    `- runtime: ${report.runtime.detail}`,
    `- subscription auth detected: ${report.subscription ? "yes (--max-budget-usd and --betas are suppressed; use --timeout-ms for a wall-clock cap)" : "no"}`,
    `- default quality profile: ${report.defaults.model} / ${report.defaults.effort}`,
    `- agentic mode: enabled by default (safe-mode fence active)`
  ];

  if (report.nextSteps.length) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderReviewResult(snapshot, result, job = null) {
  if (snapshot.reviewKind === "elite-review" || snapshot.reviewKind === "deep-review" || snapshot.reviewKind === "security-review") {
    return renderRichReviewResult(snapshot, result, job);
  }

  const findings = [...(Array.isArray(result.parsed.findings) ? result.parsed.findings : [])].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Claude ${snapshot.reviewLabel}`,
    "",
    `Target: ${snapshot.targetLabel}`,
    `Model: ${snapshot.model}`,
    `Effort: ${snapshot.effort}`,
    `Profile: ${snapshot.profile}`,
    `Mode: ${snapshot.agentic ? "agentic" : "structured-only"}`,
    `Context mode: ${snapshot.contextMode}`,
    `Verdict: ${result.parsed.verdict}`
  ];

  if (job) {
    lines.push(`Job: ${job.id}`);
  }

  lines.push(...formatActivity(result.activity));

  if (!snapshot.quiet && snapshot.notes?.length) {
    lines.push("", "Notes:");
    for (const note of snapshot.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("", result.parsed.summary, "");

  if (findings.length === 0) {
    lines.push("Findings: none.");
  } else {
    lines.push("Findings:");
    findings.forEach((finding, index) => {
      lines.push(
        `${index + 1}. [${finding.severity}] ${finding.title} (${finding.file}${formatLineRange(finding)})`
      );
      lines.push(finding.body);
      if (finding.recommendation) {
        lines.push(`Recommendation: ${finding.recommendation}`);
      }
      lines.push("");
    });
  }

  if (result.parsed.next_steps?.length) {
    lines.push("Next steps:");
    for (const step of result.parsed.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  const toolSummary = formatToolUseSummary(result.activity);
  if (!snapshot.quiet && toolSummary.length) {
    lines.push("", ...toolSummary);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderRichReviewResult(snapshot, result, job = null) {
  const findings = [...(Array.isArray(result.parsed.findings) ? result.parsed.findings : [])].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Claude ${snapshot.reviewLabel}`,
    "",
    `Target: ${snapshot.targetLabel}`,
    `Model: ${snapshot.model}`,
    `Effort: ${snapshot.effort}`,
    `Profile: ${snapshot.profile}`,
    `Mode: ${snapshot.agentic ? "agentic" : "structured-only"}`,
    `Context mode: ${snapshot.contextMode}`,
    `Verdict: ${result.parsed.verdict}`,
    `Ship Recommendation: ${result.parsed.ship_recommendation}`
  ];

  if (job) {
    lines.push(`Job: ${job.id}`);
  }

  lines.push(...formatActivity(result.activity));

  if (!snapshot.quiet && snapshot.notes?.length) {
    lines.push("", "Notes:");
    for (const note of snapshot.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("", "Executive Summary:", result.parsed.executive_summary, "");

  if (result.parsed.systemic_risks?.length) {
    lines.push("Systemic Risks:");
    for (const risk of result.parsed.systemic_risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  if (findings.length === 0) {
    lines.push("Findings: none.");
  } else {
    lines.push("Findings:");
    findings.forEach((finding, index) => {
      lines.push(
        `${index + 1}. [${finding.severity}] ${finding.title} (${finding.file}${formatLineRange(finding)})`
      );
      lines.push(`Risk Category: ${finding.risk_category}`);
      lines.push(`Confidence: ${formatConfidence(finding.confidence)}`);
      if (finding.exploitability) {
        lines.push(`Exploitability: ${finding.exploitability}`);
      }
      lines.push(`Failure Scenario: ${finding.failure_scenario}`);
      lines.push(`Why Vulnerable: ${finding.why_vulnerable}`);
      lines.push(`Impact: ${finding.impact}`);
      lines.push(finding.body);
      lines.push(`Recommendation: ${finding.recommendation}`);
      lines.push(`Test Gap: ${finding.test_gap}`);
      if (Array.isArray(finding.evidence) && finding.evidence.length) {
        lines.push("Evidence:");
        for (const ev of finding.evidence) {
          const source = ev.source ? ` [${ev.source}]` : "";
          lines.push(`- ${ev.tool}${source}: ${ev.query} -> ${ev.confirmed}`);
        }
      }
      lines.push("");
    });
  }

  if (result.parsed.verified_claims?.length) {
    lines.push("Verified Claims:");
    for (const claim of result.parsed.verified_claims) {
      lines.push(`- ${claim.claim}`);
      lines.push(`  Verification: ${claim.verification}`);
    }
    lines.push("");
  }

  if (result.parsed.blind_spots?.length) {
    lines.push("Blind Spots:");
    for (const blindSpot of result.parsed.blind_spots) {
      lines.push(`- ${blindSpot}`);
    }
    lines.push("");
  }

  if (result.parsed.exploration_log?.length) {
    lines.push("Exploration Log:");
    for (const step of result.parsed.exploration_log) {
      const outcome = step.outcome ? ` -> ${step.outcome}` : "";
      lines.push(`- step ${step.step} (${step.tool}): ${step.rationale}${outcome}`);
    }
    lines.push("");
  }

  if (result.parsed.next_steps?.length) {
    lines.push("Next steps:");
    for (const step of result.parsed.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  const toolSummary = formatToolUseSummary(result.activity);
  if (!snapshot.quiet && toolSummary.length) {
    lines.push("", ...toolSummary);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStatusReport(jobs, cwd) {
  const lines = [
    "# Claude Review Status",
    "",
    `Workspace: ${cwd}`
  ];

  if (jobs.length === 0) {
    lines.push("", "No review jobs found.");
    return `${lines.join("\n")}\n`;
  }

  for (const job of jobs) {
    lines.push("", `- ${job.id} | ${job.status} | ${job.kind} | ${job.title}`);
    if (job.model) {
      lines.push(`  Model: ${job.model} / ${job.effort}`);
    }
    if (job.summary) {
      lines.push(`  Summary: ${job.summary}`);
    }
    if (job.logTail?.length) {
      lines.push("  Progress:");
      for (const line of job.logTail) {
        lines.push(`  ${line}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderCancelReport(job, cancelled) {
  const status = cancelled ? "cancelled" : job.status === "stalled" ? "stalled" : "unable to cancel";
  return `# Claude Review Cancel\n\nJob: ${job.id}\nStatus: ${status}\n`;
}
