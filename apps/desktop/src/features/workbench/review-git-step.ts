import type { GitActionState } from "../../../contracts/git-actions";

export type GitStep =
  | {
      readonly kind: "stage" | "commit" | "push" | "pr" | "view-pr";
      readonly label: string;
      readonly hint: string;
    }
  | { readonly kind: "none"; readonly label: string; readonly hint: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The one thing the review's git button offers next: stage, commit, push, then pull request. */
export function nextGitStep(state: GitActionState): GitStep {
  if (state.conflicted > 0)
    return { kind: "none", label: "Resolve conflicts", hint: "Fix the merge conflicts first." };
  if (!state.branch)
    return {
      kind: "none",
      label: "Detached HEAD",
      hint: "Check out a branch to commit and push.",
    };
  if (state.staged === 0 && state.unstaged > 0)
    return {
      kind: "stage",
      label: "Stage all",
      hint: `${plural(state.unstaged, "changed file")} not staged`,
    };
  if (state.staged > 0)
    return {
      kind: "commit",
      label: "Commit",
      hint:
        state.unstaged > 0
          ? `${plural(state.staged, "file")} staged, ${state.unstaged} left out`
          : `${plural(state.staged, "file")} staged`,
    };
  const onBase = state.branch === state.base;
  const unpublished = !state.upstream && state.aheadOfBase > 0 && !onBase;
  if (state.ahead > 0 || unpublished) {
    if (!state.remote)
      return {
        kind: "none",
        label: "No remote",
        hint: "Add a remote with git remote add origin <url>.",
      };
    return {
      kind: "push",
      label: "Push",
      hint: state.upstream
        ? `${plural(state.ahead, "commit")} to ${state.upstream}`
        : `Publish ${state.branch} to ${state.remote}`,
    };
  }
  if (state.pullRequest)
    return {
      kind: "view-pr",
      label: `View PR #${state.pullRequest.number}`,
      hint: "Open it in the browser",
    };
  if (state.upstream && !onBase && state.aheadOfBase > 0)
    return {
      kind: "pr",
      label: state.ghAvailable ? "Create PR" : "Open PR page",
      hint: state.base ? `Into ${state.base}` : "On your Git host",
    };
  return { kind: "none", label: "Up to date", hint: "Nothing to commit or push." };
}
