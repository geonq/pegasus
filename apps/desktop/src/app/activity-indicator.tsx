import { useEffect, useRef, useState, type ReactNode } from "react";
import { MODE_FRAMES, paintFrame, resolvePreset, type OrbState } from "thinking-orbs/engine";
import { AnimatePresence, motion } from "motion/react";
import type { AgentActivityState } from "../../contracts/agent-activity";
import { ActivityBeam } from "../ui/activity-beam";
import { useActiveTheme } from "../ui/active-theme";
import { subscribeMotion } from "../ui/motion-clock";

interface ActivityIndicatorProps {
  readonly label: ReactNode;
  readonly state?: AgentActivityState;
}

/** Activity motion stops for reduced-motion users and while the window is hidden. */
export function useSystemMotionPaused(): boolean {
  const [paused, setPaused] = useState(true);
  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPaused(reducedMotion.matches || document.hidden);
    update();
    reducedMotion.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      reducedMotion.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return paused;
}

function OrbCanvas({
  state,
  size,
  paused,
  dark,
}: {
  readonly state: OrbState;
  readonly size: 20 | 64;
  readonly paused: boolean;
  readonly dark: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const { mode, speed, opts } = resolvePreset(state, size);
    const frameAt = MODE_FRAMES[mode];
    const paint = (seconds: number) => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, size, size);
      paintFrame(context, frameAt(size, seconds * speed, opts), dark);
    };
    paint(performance.now() / 1000);
    return paused ? undefined : subscribeMotion(paint);
  }, [state, size, paused, dark]);
  return <canvas ref={ref} style={{ display: "block", width: size, height: size }} />;
}

/** Fixed canvas bounds and a short crossfade keep state changes from flashing or shifting text. */
export function StateOrb({
  state,
  size = 20,
  paused: requestedPause = false,
}: {
  readonly state: OrbState;
  readonly size?: 20 | 64;
  readonly paused?: boolean;
}) {
  const { variant } = useActiveTheme();
  const paused = useSystemMotionPaused() || requestedPause;
  return (
    <span
      className="state-orb"
      data-orb-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={state}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: paused ? 0 : 0.2 }}
        >
          <OrbCanvas dark={variant === "dark"} paused={paused} size={size} state={state} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function ActivityIndicator({ label, state = "solving" }: ActivityIndicatorProps) {
  const systemPaused = useSystemMotionPaused();
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [longRunning, setLongRunning] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setLongRunning(true), 5000);
    return () => window.clearTimeout(timer);
  }, []);

  const paused = systemPaused || manuallyPaused;

  return (
    <div className="running-activity">
      <ActivityBeam active={!paused} className="running-activity__beam" preset="pill">
        <span className="running-activity__badge">
          <StateOrb paused={paused} state={state} />
          <span aria-hidden="true">{label}</span>
          <span className="sr-only" role="status">
            Agent working
          </span>
        </span>
      </ActivityBeam>
      {longRunning && !systemPaused ? (
        <button
          aria-label={manuallyPaused ? "Resume activity animation" : "Pause activity animation"}
          aria-pressed={manuallyPaused}
          className="running-activity__toggle"
          onClick={() => setManuallyPaused((current) => !current)}
          title={manuallyPaused ? "Resume activity animation" : "Pause activity animation"}
          type="button"
        >
          {manuallyPaused ? "Resume" : "Pause"}
        </button>
      ) : null}
    </div>
  );
}
