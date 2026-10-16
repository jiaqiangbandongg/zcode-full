import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type TooltipItem,
} from "chart.js";
import type { ReactNode } from "react";
import { Line } from "react-chartjs-2";
import type { PerformanceTrends, TrendSeries } from "./trendData.js";
import { formatNumber } from "./format.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
);

export function TrendPanels({
  trendError,
  trends,
}: {
  trendError?: string | null;
  trends: PerformanceTrends | null;
}) {
  if (trendError) {
    return (
      <Panel meta="summary statistics are still available" title="Performance Trends" wide>
        <EmptyText text={`趋势数据加载失败：${trendError}`} />
      </Panel>
    );
  }

  const cpuSeries = combineSeries([
    ...(trends?.containerCpu ?? []),
    ...prefixSeries(trends?.processCpu ?? [], "Electron"),
  ]);
  const memorySeries = combineSeries([
    ...(trends?.containerMemory ?? []),
    ...prefixSeries(trends?.processMemory ?? [], "Electron"),
  ]);

  return (
    <section className="trendGrid">
      <TrendLinePanel title="CPU Trend" series={cpuSeries} unit="%" />
      <TrendLinePanel title="Memory Trend" series={memorySeries} unit="MB" />
    </section>
  );
}

function TrendLinePanel({
  series,
  title,
  unit,
  wide,
}: {
  series: TrendSeries[];
  title: string;
  unit: string;
  wide?: boolean;
}) {
  const maxPointCount = Math.max(0, ...series.map((item) => item.points.length));
  return (
    <Panel
      meta={
        maxPointCount > 0
          ? `${series.length} series · ${maxPointCount} max samples · ${unit}`
          : "no samples"
      }
      title={title}
      wide={wide}
    >
      {maxPointCount > 0 ? (
        <div className="chartBox trendChart">
          <Line data={buildLineData(series)} options={buildLineOptions(unit)} />
        </div>
      ) : (
        <EmptyText text="没有可绘制的时间序列采样。" />
      )}
    </Panel>
  );
}

function Panel(props: {
  children: ReactNode;
  meta?: string;
  title: string;
  wide?: boolean;
}) {
  return (
    <section className={props.wide ? "panel wide" : "panel"}>
      <div className="panelHeader">
        <h2>{props.title}</h2>
        {props.meta ? <span>{props.meta}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

function EmptyText({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function prefixSeries(series: TrendSeries[], prefix: string) {
  return series.map((item) => ({
    ...item,
    label: `${prefix} ${item.label}`,
  }));
}

function combineSeries(series: TrendSeries[]) {
  return series.filter((item) => item.points.length > 0);
}

function buildLineData(series: TrendSeries[]): ChartData<"line"> {
  return {
    datasets: series
      .filter((item) => item.points.length > 0)
      .map((item) => {
        const color = resolveChartColor(item.color);
        return {
          backgroundColor: withAlpha(color, 0.16),
          borderColor: color,
          borderWidth: item.label.includes("Total") ? 3 : 2,
          data: item.points.map((point) => ({
            x: point.elapsedSeconds,
            y: point.value,
          })),
          label: item.label,
          pointRadius: item.points.length > 1 ? 2 : 4,
          tension: 0.28,
        };
      }),
  };
}

function buildLineOptions(unit: string): ChartOptions<"line"> {
  return {
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: chartTextColor(),
          usePointStyle: true,
        },
      },
      tooltip: {
        callbacks: {
          label(context: TooltipItem<"line">) {
            const value = Number(context.raw ?? 0);
            return `${context.dataset.label ?? "Value"}: ${formatNumber(
              value,
              unit,
            )}`;
          },
        },
      },
    },
    responsive: true,
    scales: {
      x: {
        type: "linear",
        grid: { color: chartGridColor() },
        ticks: {
          callback(value) {
            return formatElapsedSeconds(Number(value));
          },
          color: chartTextColor(),
          maxRotation: 0,
        },
        title: { color: chartTextColor(), display: true, text: "Elapsed time" },
      },
      y: {
        beginAtZero: true,
        grid: { color: chartGridColor() },
        ticks: {
          callback(value) {
            return formatNumber(Number(value), unit);
          },
          color: chartTextColor(),
        },
        title: { color: chartTextColor(), display: true, text: unit },
      },
    },
  };
}

function formatElapsedSeconds(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return "";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds) % 60}s`;
}

function resolveChartColor(color: string) {
  const cssVarMatch = color.match(/^var\((--[^)]+)\)$/u);
  if (!cssVarMatch) {
    return color;
  }
  const cssVariable = cssVarMatch[1];
  if (!cssVariable) {
    return color;
  }
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(cssVariable)
      .trim() || color
  );
}

function withAlpha(color: string, alpha: number) {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const [red, green, blue] = hexToRgb(color);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }
  return color;
}

function hexToRgb(color: string): [number, number, number] {
  if (color.length === 4) {
    const red = color.charAt(1);
    const green = color.charAt(2);
    const blue = color.charAt(3);
    return [
      Number.parseInt(red + red, 16),
      Number.parseInt(green + green, 16),
      Number.parseInt(blue + blue, 16),
    ];
  }
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function chartTextColor() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--muted")
    .trim();
}

function chartGridColor() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--line")
    .trim();
}
