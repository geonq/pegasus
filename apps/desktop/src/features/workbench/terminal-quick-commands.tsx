import { useEffect, useState, type FormEvent } from "react";
import type { QuickCommand } from "../../../contracts/ipc";
import { PencilIcon, PlusIcon } from "../../ui/icons";

interface Draft {
  readonly id?: string;
  readonly name: string;
  readonly command: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Saved commands of the terminal's project: one click types a command into the active terminal
 * and presses Enter. The host stores and runs them; this keeps only what is on screen.
 */
export function TerminalQuickCommands({
  workspaceId,
  terminalId,
  onRan,
}: {
  readonly workspaceId: string;
  readonly terminalId: string | undefined;
  readonly onRan: () => void;
}) {
  const api = window.piApp;
  const [commands, setCommands] = useState<readonly QuickCommand[] | null>(null);
  const [managing, setManaging] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!api) return undefined;
    let live = true;
    setCommands(null);
    api
      .listQuickCommands(workspaceId)
      .then((next) => live && setCommands(next))
      .catch((err: unknown) => live && setError(message(err)));
    return () => {
      live = false;
    };
  }, [api, workspaceId]);

  if (!api) return null;

  const update = (request: Promise<readonly QuickCommand[]>) => {
    setError("");
    return request.then(setCommands, (err: unknown) => {
      setError(message(err));
      throw err;
    });
  };

  const run = (command: QuickCommand) => {
    if (!terminalId) return;
    setError("");
    api.runQuickCommand(workspaceId, terminalId, command.id).then(onRan, (err: unknown) => {
      setError(message(err));
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    update(api.saveQuickCommand(workspaceId, draft)).then(
      () => setDraft(null),
      () => undefined,
    );
  };

  const list = commands ?? [];
  return (
    <div className="quick-commands" data-testid="terminal-quick-commands">
      <div className="quick-commands__strip">
        {list.length === 0 && commands ? (
          <span className="quick-commands__empty">No quick commands for this project yet</span>
        ) : null}
        {list.map((command) => (
          <button
            key={command.id}
            className="quick-commands__chip"
            type="button"
            disabled={!terminalId}
            title={command.command}
            data-testid="quick-command"
            onClick={() => run(command)}
          >
            {command.name}
          </button>
        ))}
        <span className="quick-commands__tools">
          <button
            className="icon-button terminal-panel__action"
            type="button"
            title="Add quick command"
            aria-label="Add quick command"
            onClick={() => {
              setManaging(true);
              setDraft({ name: "", command: "" });
            }}
          >
            <PlusIcon />
          </button>
          {list.length > 0 ? (
            <button
              className="icon-button terminal-panel__action"
              type="button"
              title="Edit quick commands"
              aria-label="Edit quick commands"
              aria-pressed={managing}
              onClick={() => {
                setManaging((open) => !open);
                setDraft(null);
              }}
            >
              <PencilIcon />
            </button>
          ) : null}
        </span>
      </div>
      {error ? (
        <p className="quick-commands__error" role="alert">
          {error}
        </p>
      ) : null}
      {managing ? (
        <div className="quick-commands__manage">
          {list.map((command) =>
            draft?.id === command.id ? null : (
              <div className="quick-commands__row" key={command.id}>
                <span className="quick-commands__name">{command.name}</span>
                <code className="quick-commands__command">{command.command}</code>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => setDraft(command)}
                >
                  Edit
                </button>
                <button
                  className="button button--ghost quick-commands__delete"
                  type="button"
                  aria-label={`Delete ${command.name}`}
                  onClick={() =>
                    void update(api.deleteQuickCommand(workspaceId, command.id)).catch(
                      () => undefined,
                    )
                  }
                >
                  Delete
                </button>
              </div>
            ),
          )}
          {draft ? (
            <form className="quick-commands__form" onSubmit={submit}>
              <input
                className="quick-commands__input"
                aria-label="Name"
                placeholder="Name, e.g. Run tests"
                maxLength={80}
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <input
                className="quick-commands__input quick-commands__input--command"
                aria-label="Command"
                placeholder="Command, e.g. pnpm test"
                spellCheck={false}
                autoComplete="off"
                value={draft.command}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setDraft(null);
                }}
              />
              <button
                className="button button--primary"
                type="submit"
                disabled={!draft.name.trim() || !draft.command.trim()}
              >
                {draft.id ? "Save" : "Add"}
              </button>
              <button className="button" type="button" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
