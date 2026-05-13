import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("pull request workflow cancels superseded matrix runs", () => {
  const source = read(".github/workflows/pull-request-ci.yml");
  assert.match(source, /concurrency:/);
  assert.match(source, /group: pr-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(source, /cancel-in-progress: true/);
});

test("package files list excludes bump-version from the shipped tarball surface", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.ok(packageJson.files.includes("scripts/claude-review-companion.mjs"));
  assert.ok(packageJson.files.includes("scripts/bin/"));
  assert.ok(packageJson.files.includes("scripts/lib/"));
  assert.ok(!packageJson.files.includes("scripts/"));
});

test("package.json shape supports public npm publish", () => {
  const packageJson = JSON.parse(read("package.json"));

  assert.notEqual(packageJson.private, true);
  assert.notEqual(packageJson.private, "true");
  assert.equal(packageJson.name, "codex-plugin-cc");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+/);
  assert.ok(Array.isArray(packageJson.files));
  assert.ok(packageJson.files.length > 0);
  assert.equal(typeof packageJson.repository?.url, "string");
  assert.match(packageJson.repository.url, /Kenmege\/codex-plugin-cc/);
});

test("npmjs release configuration is public and token-safe", () => {
  const packageJson = JSON.parse(read("package.json"));
  const workflow = read(".github/workflows/release.yml");

  assert.equal(packageJson.name, "codex-plugin-cc");
  assert.match(
    packageJson.repository.url,
    /^(git\+)?https:\/\/github\.com\/Kenmege\/codex-plugin-cc\.git$/
  );
  assert.deepEqual(packageJson.publishConfig, {
    registry: "https://registry.npmjs.org",
    access: "public"
  });
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /packages: write/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(workflow, /NPMJS_PUBLISH_ENABLED/);
  assert.doesNotMatch(workflow, /npm pkg set private=false/);
  assert.match(workflow, /id: publish-package/);
  assert.match(workflow, /npm view "codex-plugin-cc@\$\{VERSION\}" version/);
  assert.match(workflow, /Package codex-plugin-cc@\$\{VERSION\} already exists; skipping npm publish/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /gh release view "v\$\{VERSION\}"/);
  assert.match(workflow, /gh release edit "v\$\{VERSION\}"/);
  assert.match(workflow, /gh release create "v\$\{VERSION\}"/);
  assert.match(workflow, /--latest/);
  assert.match(workflow, /--prerelease/);
  assert.doesNotMatch(workflow, /--access restricted/);
  assert.doesNotMatch(workflow, /npm\.pkg\.github\.com/);
});

test("release workflow fails closed when tag and package version differ", () => {
  const workflow = read(".github/workflows/release.yml");
  const contributing = read("CONTRIBUTING.md");

  assert.match(workflow, /Verify tag matches package version/);
  assert.match(workflow, /id: tag-version-gate/);
  assert.match(workflow, /node -p "require\('\.\/package\.json'\)\.version" > \.release-package-version/);
  assert.match(workflow, /read -r PACKAGE_VERSION < \.release-package-version/);
  assert.match(workflow, /TAG_VERSION="\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(workflow, /Release tag v\$\{TAG_VERSION\} does not match package\.json version \$\{PACKAGE_VERSION\}/);
  assert.match(workflow, /printf 'version=%s\\n' "\$PACKAGE_VERSION" >> "\$GITHUB_OUTPUT"/);
  assert.match(contributing, /tag and package version differ/);
  assert.match(contributing, /1\.0\.3-rc\.1/);
});

test("public-facing docs do not contain private local machine paths", () => {
  for (const relativePath of [
    "README.md",
    "commands/review.md",
    "commands/adversarial-review.md",
    "commands/elite-review.md",
    "commands/deep-review.md",
    "commands/security-review.md",
    "commands/doctor.md",
    "commands/setup.md",
    "commands/status.md",
    "commands/result.md",
    "commands/cancel.md"
  ]) {
    assert.doesNotMatch(read(relativePath), /\/Users\/kenmege/, relativePath);
  }
});

test("public trust metadata is attribution-safe and precise", () => {
  const notice = read("NOTICE");
  const plugin = JSON.parse(read(".codex-plugin/plugin.json"));
  const claudeMarketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const readme = read("README.md");
  const security = read("SECURITY.md");
  const releaseNotes = [
    "README.md",
    "CHANGELOG.md",
    "RELEASE_NOTES_v1.0.2.md",
    "RELEASE_NOTES_v1.0.3.md",
    "RELEASE_NOTES_v1.0.9.md"
  ].map(read).join("\n");

  assert.match(notice, /Copyright 2026 Kennedy Umege/);
  assert.match(notice, /Copyright 2026 OpenAI/);
  assert.deepEqual(plugin.interface.capabilities, ["Interactive", "Read"]);
  assert.equal(claudeMarketplace.owner.name, "Kennedy Umege");
  assert.doesNotMatch(claudeMarketplace.owner.name, /OpenAI/);
  assert.match(readme, /Windows is not a supported v1 platform/);
  assert.doesNotMatch(readme, /macOS, Linux, and Windows are supported/);
  assert.match(security, /github\.com\/Kenmege\/codex-plugin-cc\/security\/advisories\/new/);
  assert.doesNotMatch(releaseNotes, /GPT-5\.5|gpt-5\.5/);
});

test("internal prompt artifacts are not tracked for public release", () => {
  const trackedPromptFiles = execFileSync("git", ["ls-files", "docs/*_PROMPT.md"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  assert.equal(trackedPromptFiles, "");
  assert.match(read(".gitignore"), /^docs\/\*_PROMPT\.md$/m);
});

test("release hygiene grep scope preserves reviewer WebFetch allowlist domains", () => {
  const contributing = read("CONTRIBUTING.md");
  const claude = read("scripts/lib/claude.mjs");
  assert.match(claude, /https:\/\/registry\.npmjs\.org\/\*/);
  assert.match(contributing, /scripts\/lib\/claude\.mjs/);
  assert.match(contributing, /WebFetch allowlist/);
});

test("Copilot code review instructions are present for GitHub review agents", () => {
  const source = read(".github/copilot-instructions.md");
  assert.match(source, /Copilot Code Review Instructions/);
  assert.match(source, /security-sensitive CLI plugin/);
  assert.match(source, /JSON schemas and `validateStructuredReviewOutput` stay in sync/);
});

test("Claude Code workflow is pinned, current, and auth-gated", () => {
  const workflow = read(".github/workflows/claude.yml");
  const prompt = read(".github/claude-review-prompt.md");
  const readme = read("README.md");
  const contributing = read("CONTRIBUTING.md");

  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, ready_for_review, reopened\]/);
  assert.match(workflow, /anthropics\/claude-code-action@[a-f0-9]{40}/);
  assert.doesNotMatch(workflow, /anthropics\/claude-code-action@v1/);
  assert.doesNotMatch(workflow, /^\s+mode:/m);
  assert.doesNotMatch(workflow, /prompt-file:/);
  assert.match(workflow, /Run Claude auto review with OAuth/);
  assert.match(workflow, /Run Claude auto review with API key/);
  assert.match(workflow, /Run Claude interactive response with OAuth/);
  assert.match(workflow, /Run Claude interactive response with API key/);
  assert.match(workflow, /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.match(workflow, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.match(workflow, /Verify Claude auth secret configured/);
  assert.match(workflow, /Claude Code Action requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(workflow, /IS_UNTRUSTED_FORK_PR/);
  assert.match(workflow, /does not pass repository Actions secrets to forked pull_request workflows/);
  assert.match(workflow, /--append-system-prompt/);
  assert.match(prompt, /Trust boundary:/);
  assert.match(prompt, /Review priorities, in order:/);
  assert.match(readme, /Reviewer Composition/);
  assert.match(readme, /Claude \(Anthropic Opus 4\.7\)/);
  assert.match(contributing, /Working With Reviewers/);
  assert.match(contributing, /ANTHROPIC_API_KEY/);
});

test("public launch community files and release notes are present", () => {
  const codeowners = read(".github/CODEOWNERS");
  const bug = read(".github/ISSUE_TEMPLATE/bug_report.yml");
  const feature = read(".github/ISSUE_TEMPLATE/feature_request.yml");
  const security = read(".github/ISSUE_TEMPLATE/security_report.yml");
  const issueConfig = read(".github/ISSUE_TEMPLATE/config.yml");
  const prTemplate = read(".github/PULL_REQUEST_TEMPLATE.md");
  const conduct = read("CODE_OF_CONDUCT.md");
  const releaseNotes = read("RELEASE_NOTES_v1.0.3.md");

  assert.match(codeowners, /^\*\s+@Kenmege/m);
  assert.match(codeowners, /CODEOWNERS only auto-requests humans\/teams with/);
  assert.match(bug, /Claude CLI version/);
  assert.match(bug, /Sanitized log tail/);
  assert.match(feature, /Affected review lane\(s\)/);
  assert.match(security, /Do not include exploit details in a public issue/);
  assert.match(issueConfig, /blank_issues_enabled: false/);
  assert.match(prTemplate, /No tokens, API keys, or credentials/);
  assert.match(conduct, /Contributor Covenant/);
  assert.match(releaseNotes, /v1\.0\.3/);
  assert.match(releaseNotes, /first public OSS release/);
  assert.match(releaseNotes, /Security Hardening/);
});

test("security docs describe inherit-mcp Task subagent trust expansion", () => {
  const architecture = read("docs/architecture.md");
  const security = read("SECURITY.md");
  for (const source of [architecture, security]) {
    assert.match(source, /--inherit-mcp/);
    assert.match(source, /Task subagents?/i);
    assert.match(source, /second-order trust expansion|expands trust indirectly/i);
    assert.match(source, /docs\.anthropic\.com\/en\/docs\/claude-code\/sub-agents/);
  }
});

test("public docs document the add-dir boundary override", () => {
  const readme = read("README.md");
  const security = read("SECURITY.md");
  for (const source of [readme, security]) {
    assert.match(source, /CODEX_CLAUDE_ADD_DIR_BOUNDARY/);
    assert.match(source, /--add-dir/);
    assert.match(source, /workspace root/);
  }
});

test("release checklist documents npmjs publish switch and v-tag trigger", () => {
  const source = read("CONTRIBUTING.md");
  assert.match(source, /NPMJS_PUBLISH_ENABLED=true/);
  assert.match(source, new RegExp("NPM" + "_TOKEN"));
  assert.match(source, /NODE_AUTH_TOKEN/);
  assert.match(source, /v1\.0\.3/);
  assert.match(source, /matching the package version exactly/);
  assert.match(source, /RELEASE_NOTES_v\$\{VERSION\}\.md/);
  assert.match(source, /generated stub/);
});

test("architecture docs reference the exported structured parser name", () => {
  const source = read("docs/architecture.md");
  assert.match(source, /parseClaudeStructuredOutput/);
  assert.doesNotMatch(source, new RegExp("parseClaudeStructured" + "Review"));
});

test("repository validation accepts fork-renamed local marketplace names", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-cc-fork-"));
  try {
    fs.cpSync(root, tempRoot, {
      recursive: true,
      filter(source) {
        const relative = path.relative(root, source);
        return (
          relative !== ".git" &&
          !relative.startsWith(".git/") &&
          relative !== ".claude-review" &&
          !relative.startsWith(".claude-review/")
        );
      }
    });
    const marketplacePath = path.join(tempRoot, ".agents/plugins/marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
    marketplace.name = "my-forked-review-marketplace";
    fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);

    const output = execFileSync("node", ["scripts/validate-repo.mjs"], {
      cwd: tempRoot,
      encoding: "utf8"
    });
    assert.match(output, /Repository validation passed/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
