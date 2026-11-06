import { HeatmapRect } from "@visx/heatmap";
import { useMemo, useState, type PointerEvent } from "react";
import { HeatmapChart } from "@/components/charts/heatmap/heatmap-chart";
import {
  type HeatmapBin,
  type HeatmapColumn,
  HeatmapInteractionBoundary,
  HeatmapInteractionProvider,
  useHeatmap,
  useHeatmapInteraction,
} from "@/components/charts/heatmap/heatmap-context";
import { HeatmapTooltip } from "@/components/charts/heatmap/heatmap-tooltip";
import { HeatmapXAxis } from "@/components/charts/heatmap/heatmap-x-axis";
import { mixBrands, type Brand, type BrandWeights } from "./brand-color";

const DAY = 86_400_000;
const WEEKS = 53;
const MODES = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "cumulative", label: "Cumulative" },
] as const;
type Mode = (typeof MODES)[number]["id"];

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** Empty dot, then four steps from faint to the full color of whatever was used that day. */
const levelsOf = (color: string) => [
  "var(--overlay-hover)",
  `color-mix(in srgb, ${color} 30%, transparent)`,
  `color-mix(in srgb, ${color} 55%, transparent)`,
  color,
  `color-mix(in srgb, ${color} 60%, white)`,
];
const sumWeights = (into: BrandWeights, from: BrandWeights | undefined) => {
  for (const brand of Object.keys(from ?? {}) as Brand[])
    into[brand] = (into[brand] ?? 0) + (from?.[brand] ?? 0);
};

const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

function mondayOf(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

/** A year of daily tokens as a dot grid (like a profile activity chart), drawn with Bklit's heatmap. */
export function TokenHeatmap({
  tokensByDay,
  brandsByDay,
}: {
  readonly tokensByDay: ReadonlyMap<number, number>;
  /** Tokens per brand for each day, which tints that day's dot. */
  readonly brandsByDay: ReadonlyMap<number, BrandWeights>;
}) {
  const [mode, setMode] = useState<Mode>("daily");

  const view = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = today.getTime();
    const firstMonday = mondayOf(end) - (WEEKS - 1) * 7 * DAY;
    const days = Array.from({ length: WEEKS * 7 }, (_, index) => firstMonday + index * DAY);
    const daily = days.map((day) => (day > end ? null : (tokensByDay.get(day) ?? 0)));

    let running = 0;
    const values = daily.map((value, index) => {
      if (value === null) return null;
      if (mode === "cumulative") return (running += value);
      if (mode === "weekly") {
        const week = Math.floor(index / 7) * 7;
        return daily.slice(week, week + 7).reduce<number>((sum, entry) => sum + (entry ?? 0), 0);
      }
      return value;
    });

    // Quartiles of the non-zero values, so the blues spread over this account's real range.
    const sorted = values.filter((value): value is number => !!value).sort((a, b) => a - b);
    const cut = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    const thresholds = [cut(0.25), cut(0.5), cut(0.75)];
    // Each dot leans toward the brand used most in its day, week or running total.
    const runningBrands = {} as BrandWeights;
    const fills = days.map((day, index) => {
      const value = values[index];
      const weights = {} as BrandWeights;
      if (mode === "daily") sumWeights(weights, brandsByDay.get(day));
      else if (mode === "weekly") {
        const week = Math.floor(index / 7) * 7;
        for (const member of days.slice(week, week + 7))
          sumWeights(weights, brandsByDay.get(member));
      } else {
        sumWeights(runningBrands, brandsByDay.get(day));
        sumWeights(weights, runningBrands);
      }
      // Days still to come are null: drawn blank.
      if (value === null || value === undefined) return "transparent";
      const levels = levelsOf(mixBrands(weights));
      return levels[value <= 0 ? 0 : 1 + thresholds.filter((limit) => value > limit).length]!;
    });
    const colorScale = (count: number | null | undefined) =>
      count === null || count === undefined || count < 0 ? "transparent" : "var(--overlay-hover)";

    const data = Array.from({ length: WEEKS }, (_, week) => ({
      bin: week,
      bins: Array.from({ length: 7 }, (_, row) => ({
        bin: row,
        count: values[week * 7 + row] ?? -1,
        date: new Date(days[week * 7 + row]!),
      })),
    }));

    const active = daily.map((value) => (value ?? 0) > 0);
    let longest = 0;
    let streak = 0;
    for (const on of active) {
      streak = on ? streak + 1 : 0;
      longest = Math.max(longest, streak);
    }
    let current = 0;
    const todayIndex = Math.round((end - firstMonday) / DAY);
    for (let index = todayIndex; index >= 0 && active[index]; index -= 1) current += 1;
    const known = daily.filter((value): value is number => value !== null);
    return {
      data,
      colorScale,
      fills,
      total: known.reduce((sum, value) => sum + value, 0),
      peak: Math.max(0, ...known),
      longest,
      current,
    };
  }, [tokensByDay, brandsByDay, mode]);

  return (
    <section className="usage-card usage-heatmap">
      <div className="usage-heatmap__stats">
        <Figure label="Tokens, past year" value={compact.format(view.total)} />
        <Figure label="Peak day" value={compact.format(view.peak)} />
        <Figure label="Longest streak" value={days(view.longest)} />
        <Figure label="Current streak" value={days(view.current)} />
      </div>
      <div className="usage-heatmap__head">
        <h3>Token usage</h3>
        <div aria-label="Heatmap values" className="usage-heatmap__modes" role="group">
          {MODES.map((entry) => (
            <button
              aria-pressed={mode === entry.id}
              key={entry.id}
              onClick={() => setMode(entry.id)}
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <HeatmapInteractionProvider>
        <HeatmapInteractionBoundary>
          <HeatmapChart
            colorScale={view.colorScale}
            data={view.data}
            gap={3}
            margin={{ top: 22, right: 0, bottom: 0, left: 0 }}
          >
            <UsageCells fills={view.fills} />
            <HeatmapXAxis />
            <HeatmapTooltip
              formatLabel={(count) => (count < 0 ? "Not yet" : `${compact.format(count)} tokens`)}
            />
          </HeatmapChart>
        </HeatmapInteractionBoundary>
      </HeatmapInteractionProvider>
    </section>
  );
}

/**
 * Plain SVG dots instead of Bklit's per-cell motion layers, which re-rendered and re-animated
 * all 371 cells on every hovered day. The dots are built once per data change; hover is CSS, and
 * one delegated handler updates only the tooltip.
 */
function UsageCells({ fills }: { readonly fills: readonly string[] }) {
  const { data, binWidth, binHeight, gap, margin, xScale, yScale, fillScale } = useHeatmap();
  const { setTooltipData } = useHeatmapInteraction();

  const dots = useMemo(
    () => (
      <HeatmapRect<HeatmapColumn, HeatmapBin>
        binHeight={binHeight}
        bins={(column) => column.bins}
        binWidth={binWidth}
        colorScale={(count) => fillScale(Number(count))}
        count={(bin) => bin.count}
        data={data}
        gap={gap}
        xScale={xScale}
        yScale={yScale}
      >
        {(cells) =>
          cells
            .flat()
            .map((cell) => (
              <rect
                className="usage-heatmap__cell"
                data-column={cell.column}
                data-row={cell.row}
                fill={fills[cell.column * 7 + cell.row] ?? cell.color}
                height={cell.height}
                key={`${cell.column}-${cell.row}`}
                rx={6}
                width={cell.width}
                x={cell.x}
                y={cell.y}
              />
            ))
        }
      </HeatmapRect>
    ),
    [binHeight, binWidth, data, fills, fillScale, gap, xScale, yScale],
  );

  const showDay = (event: PointerEvent<SVGGElement>) => {
    const target = event.target as SVGElement;
    const column = Number(target.dataset.column);
    const row = Number(target.dataset.row);
    const bin = data[column]?.bins[row];
    if (!bin) return;
    setTooltipData((current) =>
      current?.column === column && current.row === row
        ? current
        : {
            column,
            row,
            count: bin.count,
            date: bin.date,
            x: margin.left + xScale(column) + binWidth / 2,
            y: margin.top + yScale(row) + binHeight / 2,
          },
    );
  };

  return (
    <g onPointerLeave={() => setTooltipData(null)} onPointerOver={showDay}>
      {dots}
    </g>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="usage-heatmap__figure">
      <span className="usage-heatmap__value">{value}</span>
      <span className="usage-heatmap__label">{label}</span>
    </div>
  );
}
