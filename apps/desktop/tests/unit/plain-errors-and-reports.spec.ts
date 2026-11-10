import { expect, test } from "@playwright/test";
import { parseChildReport } from "../../src/features/conversation/child-report";
import { describeProviderError } from "../../src/ui/provider-error";

test("provider errors become a sentence with the fix, unknown text stays untouched", () => {
  const openai = describeProviderError(
    'OpenAI API error (401): {"message":"Incorrect API key provided: sk-***","type":"invalid_request_error","param":null,"code":"invalid_api_key"}',
  );
  expect(openai?.summary).toBe(
    "OpenAI rejected the API key (401). Update it in Settings › Providers.",
  );
  expect(openai?.raw).toContain("Incorrect API key");

  expect(
    describeProviderError(
      'Anthropic API error (401): {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    )?.summary,
  ).toContain("rejected the API key");
  expect(
    describeProviderError(
      'Google API error (429): {"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}',
    )?.summary,
  ).toContain("rate limiting");
  expect(
    describeProviderError('OpenAI API error (400): {"error":{"message":"Bad tool schema"}}')
      ?.summary,
  ).toBe("OpenAI rejected the request (400): Bad tool schema");
  expect(describeProviderError("Network unreachable")).toBeUndefined();
  expect(describeProviderError("OpenAI API error (418): not json")).toBeUndefined();
});

test("a child thread report is read back into title, state, git lines and reply", () => {
  const report = parseChildReport(
    [
      '[Child thread report] "Write the docs" failed.',
      "childThreadId: abc-123",
      "Git:",
      "- /repo (main): 1 commit(s) since the child started; clean",
      "  - 1a2b3c4 Add docs",
      "Last reply:",
      "Line one\n\nLine two",
    ].join("\n"),
  );
  expect(report).toEqual({
    title: "Write the docs",
    failed: true,
    childThreadId: "abc-123",
    git: [
      {
        summary: "/repo (main): 1 commit(s) since the child started; clean",
        commits: ["1a2b3c4 Add docs"],
      },
    ],
    reply: "Line one\n\nLine two",
  });
  expect(
    parseChildReport(
      '[Child thread report] "T" finished.\nchildThreadId: x\nLast reply:\n(no reply; read_thread x for its transcript)',
    )?.reply,
  ).toBe("");
  expect(parseChildReport("[Child thread report] something else")).toBeNull();
  expect(parseChildReport("hello")).toBeNull();
});
