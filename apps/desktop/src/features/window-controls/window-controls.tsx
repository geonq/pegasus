import { useEffect, useState } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import {
  WindowCloseIcon,
  WindowMaximizeIcon,
  WindowMinimizeIcon,
  WindowRestoreIcon,
} from "../../ui/icons";

/** Minimize, maximize/restore and close for the frameless Windows window, at its top-right corner. */
export function WindowControls({ api }: { readonly api: PiDesktopApi }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .isWindowMaximized()
      .then((next) => live && setMaximized(next))
      .catch(() => undefined);
    const stop = api.onWindowMaximizedChanged(setMaximized);
    return () => {
      live = false;
      stop();
    };
  }, [api]);

  const buttons = [
    { id: "minimize", label: "Minimize", icon: <WindowMinimizeIcon />, run: api.minimizeWindow },
    {
      id: "maximize",
      label: maximized ? "Restore" : "Maximize",
      icon: maximized ? <WindowRestoreIcon /> : <WindowMaximizeIcon />,
      run: api.toggleWindowMaximize,
    },
    { id: "close", label: "Close", icon: <WindowCloseIcon />, run: api.closeWindow },
  ];

  return (
    <div className="window-controls" data-testid="window-controls">
      {buttons.map((button) => (
        <span className="shortcut-tooltip-wrap window-controls__wrap" key={button.id}>
          <button
            aria-label={button.label}
            className={`window-controls__button window-controls__button--${button.id}`}
            data-testid={`window-${button.id}`}
            type="button"
            onClick={() => {
              button
                .run()
                .catch((error: unknown) => console.error(`[renderer] window ${button.id}`, error));
            }}
          >
            {button.icon}
          </button>
          <span className="shortcut-tooltip window-controls__tooltip" role="tooltip">
            {button.label}
          </span>
        </span>
      ))}
    </div>
  );
}
