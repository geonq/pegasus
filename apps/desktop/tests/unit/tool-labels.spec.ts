import { expect, test } from "@playwright/test";
import { builtInToolLabel, humanToolName } from "../../contracts/tool-labels";

test("every tool pi-gui and pi-ecosystem run reads as a sentence, never its raw id", () => {
  const rows: Array<[string, unknown, string]> = [
    ["project_shell", { command: "git status\ngit log" }, "Ran git status"],
    [
      "project_shell",
      { command: "npm test", description: "Open test program" },
      "Open test program",
    ],
    ["bash", { command: "ls -la" }, "Ran ls -la"],
    ["powershell", {}, "Ran a command"],
    ["mac_exec", { command: "open -a Safari" }, "Ran open -a Safari"],
    ["project_read", { path: "src/app.ts" }, "Read src/app.ts"],
    ["project_read", { path: String.raw`D:\Pi\shots\frames\001.PNG` }, "Looked at image 001.PNG"],
    ["read", { path: "a/b/c/d/e.md" }, "Read c/d/e.md"],
    ["project_ls", { path: "src" }, "Listed src"],
    ["glob", { pattern: "**/*.ts" }, "Listed **/*.ts"],
    ["grep", { pattern: "toolLabel" }, "Searched for toolLabel"],
    ["project_edit", { path: String.raw`C:\x\y\z\w.ts`, edits: [] }, "Edited y/z/w.ts"],
    ["project_write", { path: "notes.md", content: "" }, "Wrote notes.md"],
    ["web_fetch", { url: "https://docs.example.com/a?b" }, "Opened docs.example.com"],
    ["web_search", { query: "electron clipboard" }, "Searched the web for electron clipboard"],
    ["project_screen_record", { path: "demo.mov", seconds: 10 }, "Recorded screen to demo.mov"],
    ["find_skills", { query: "pdf" }, "Searched skills for pdf"],
    ["read_skill", { id: "ponytail" }, "Loaded skill ponytail"],
    ["mcp__pi__project_shell", { command: "pwd" }, "Ran pwd"],
  ];
  for (const [name, input, label] of rows) {
    expect(builtInToolLabel(name, input), name).toBe(label);
  }
  expect(builtInToolLabel("mcp__github__get_issue", { number: 1 })).toBeUndefined();
  expect(humanToolName("mcp__github__get_issue")).toBe("Get issue");
  expect(humanToolName("project_screen_record")).toBe("Screen record");
  expect(humanToolName("mcp__my_server__lookup")).toBe("Lookup");
});
