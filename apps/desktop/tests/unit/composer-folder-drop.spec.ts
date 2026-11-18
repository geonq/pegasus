import { expect, test } from "@playwright/test";
import { partitionDroppedFolders } from "../../src/features/conversation/composer-attachments";

function fakeFile(name: string, path: string): File {
  return { name, path, type: "", size: 0, lastModified: 1 } as unknown as File;
}

function fakeTransfer(entries: readonly { file: File; isDirectory: boolean }[]): DataTransfer {
  return {
    types: ["Files"],
    files: entries.map((entry) => entry.file),
    items: entries.map((entry) => ({
      kind: "file",
      getAsFile: () => entry.file,
      webkitGetAsEntry: () => ({ isDirectory: entry.isDirectory }),
    })),
  } as unknown as DataTransfer;
}

test("splits a drop into folder paths and plain files", () => {
  const folder = fakeFile("notes", "C:\\work\\notes");
  const file = fakeFile("a.txt", "C:\\work\\a.txt");
  const { folderPaths, files } = partitionDroppedFolders(
    fakeTransfer([
      { file: folder, isDirectory: true },
      { file, isDirectory: false },
    ]),
  );
  expect(folderPaths).toEqual(["C:\\work\\notes"]);
  expect(files).toEqual([file]);
});

test("an empty or missing drop gives nothing", () => {
  expect(partitionDroppedFolders(null)).toEqual({ folderPaths: [], files: [] });
});
