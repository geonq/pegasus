// Plain Node tests for the chat's agents summary: node --test --experimental-strip-types
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestrationChildThread } from "../../api/types.ts";
import { agentSummaryParts, countAgents, groupAgents } from "./agent-summary.ts";

const agent = (
  id: string,
  status: OrchestrationChildThread["status"],
  minute: number,
): OrchestrationChildThread => ({
  id,
  title: id,
  status,
  latestTranscript: "",
  parentWorkspaceId: "w",
  parentSessionId: "p",
  childWorkspaceId: "w",
  childSessionId: id,
  updatedAt: new Date(Date.UTC(2026, 10, 24, 10, minute)).toISOString(),
});

test("agents group into needs you, running and done, newest first, empty groups dropped", () => {
  const groups = groupAgents([
    agent("old-done", "complete", 1),
    agent("ask", "waiting", 2),
    agent("queued", "queued", 3),
    agent("broke", "failed", 4),
    agent("run", "running", 5),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.title, group.agents.map((entry) => entry.id)]),
    [
      ["Needs you", ["ask"]],
      ["Running", ["run", "queued"]],
      ["Done", ["broke", "old-done"]],
    ],
  );
  assert.deepEqual(
    groupAgents([agent("a", "complete", 1)]).map((group) => group.id),
    ["done"],
  );
});

test("the pill names the total, then what needs you, what runs and what failed", () => {
  const counts = countAgents([
    agent("a", "running", 1),
    agent("b", "queued", 1),
    agent("c", "waiting", 1),
    agent("d", "failed", 1),
    agent("e", "complete", 1),
  ]);
  assert.deepEqual(counts, { total: 5, running: 2, waiting: 1, failed: 1 });
  const summary = agentSummaryParts(counts);
  assert.equal(summary.total, "5 agents");
  assert.deepEqual(
    summary.parts.map((part) => part.text),
    ["1 needs you", "2 running", "1 failed"],
  );
  const done = agentSummaryParts(countAgents([agent("a", "complete", 1)]));
  assert.equal(done.total, "1 agent");
  assert.deepEqual(done.parts, [{ text: "all done", tone: "muted" }]);
});
