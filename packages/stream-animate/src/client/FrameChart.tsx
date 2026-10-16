import type { FrameScenario, FrameTrendPoint, RunSummary } from "@/shared/types";
import { useEffect, useRef } from "react";

export function FrameCharts({ run }: { run: RunSummary | null }) {
  if (!run?.metrics) {
    return (
      <section className="panel chartEmpty">
        <h2>帧可视化</h2>
        <p>等待 SSE 数据。</p>
      </section>
    );
  }

  return (
    <section className="charts">
      <FrameChart scenario={run.metrics.frames["60"]} title="60fps" />
      <FrameChart scenario={run.metrics.frames["120"]} title="120fps" />
    </section>
  );
}

interface FrameChartProps {
  embedded?: boolean;
  scenario: FrameScenario;
  showForecast?: boolean;
  subtitle?: string;
  title: string;
}

export function FrameChart({
  embedded = false,
  scenario,
  showForecast = true,
  subtitle,
  title,
}: FrameChartProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const chartHeight = embedded ? 200 : 220;
  const gutter = 42;
  const barWidth = scenario.totalFrames > 240 ? 4 : 7;
  const gap = scenario.totalFrames > 240 ? 1 : 2;
  const forecast = showForecast ? scenario.forecast : undefined;
  const forecastFrames = forecast?.horizonFrames ?? 0;
  const chartFrameCount = scenario.buckets.length + forecastFrames;
  const chartWidth = Math.max(embedded ? 520 : 720, gutter + chartFrameCount * (barWidth + gap) + 20);
  const maxChars = Math.max(
    1,
    scenario.maxChars,
    maxTrendChars(forecast?.observed),
    maxTrendChars(forecast?.predicted),
  );
  const actualEndX = gutter + scenario.buckets.length * (barWidth + gap);
  const observedPath = buildTrendPath(forecast?.observed ?? [], {
    barWidth,
    chartHeight,
    gap,
    gutter,
    maxChars,
  });
  const predictedPath = buildTrendPath(forecast?.predicted ?? [], {
    barWidth,
    chartHeight,
    gap,
    gutter,
    maxChars,
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    scroller.scrollTo({ behavior: "smooth", left: scroller.scrollWidth });
  }, [scenario.nonEmptyFrames, scenario.totalFrames]);

  return (
    <article className={embedded ? "embeddedChart" : "panel chartPanel"}>
      <div className="panelHeader">
        <div>
          <h2>{title}</h2>
          <p>{subtitle ?? `${scenario.totalFrames} frames · ${scenario.nonEmptyFrames} non-empty · max ${scenario.maxChars} chars`}</p>
          {forecast ? (
            <p>
              smooth window {forecast.windowFrames} frames · forecast {forecast.horizonFrames} frames
            </p>
          ) : null}
        </div>
        <div className="chartMeta">
          <strong>{scenario.frameMs.toFixed(2)}ms/frame</strong>
          <span>
            <i className={forecast ? "legendLine actual" : "legendLine raw"} />
            {forecast ? "smoothed" : "raw"}
          </span>
          {forecast ? (
            <span>
              <i className="legendLine predicted" />
              predicted
            </span>
          ) : null}
        </div>
      </div>
      <div className="chartScroller" ref={scrollerRef}>
        <svg
          aria-label={`${title} chars per frame`}
          height={chartHeight + 46}
          role="img"
          width={chartWidth}
        >
          <line
            className="axis"
            x1={gutter}
            x2={chartWidth - 10}
            y1={chartHeight}
            y2={chartHeight}
          />
          <line className="axis" x1={gutter} x2={gutter} y1={12} y2={chartHeight} />
          <text className="axisLabel" x={8} y={22}>
            chars
          </text>
          <text className="axisLabel" x={chartWidth - 58} y={chartHeight + 32}>
            frame
          </text>
          {forecastFrames > 0 ? (
            <>
              <rect
                className="futureBand"
                height={chartHeight - 12}
                width={chartWidth - actualEndX - 10}
                x={actualEndX}
                y={12}
              />
              <line
                className="futureDivider"
                x1={actualEndX}
                x2={actualEndX}
                y1={12}
                y2={chartHeight}
              />
              <text className="futureLabel" x={actualEndX + 10} y={30}>
                forecast
              </text>
            </>
          ) : null}
          {scenario.buckets.map((bucket) => {
            const height = Math.max(1, (bucket.chars / maxChars) * (chartHeight - 28));
            const x = gutter + bucket.frameIndex * (barWidth + gap);
            const y = chartHeight - height;
            return (
              <rect
                className={bucket.chars > 0 ? "bar active" : "bar"}
                height={height}
                key={bucket.frameIndex}
                rx={2}
                width={barWidth}
                x={x}
                y={y}
              >
                <title>
                  frame {bucket.frameIndex}: {bucket.chars} chars
                </title>
              </rect>
            );
          })}
          {observedPath ? <path className="speedLine" d={observedPath} /> : null}
          {predictedPath ? <path className="forecastLine" d={predictedPath} /> : null}
        </svg>
      </div>
    </article>
  );
}

function buildTrendPath(
  points: FrameTrendPoint[],
  options: {
    barWidth: number;
    chartHeight: number;
    gap: number;
    gutter: number;
    maxChars: number;
  },
) {
  if (points.length === 0) {
    return "";
  }
  return points
    .map((point, index) => {
      const x = options.gutter + point.frameIndex * (options.barWidth + options.gap) + options.barWidth / 2;
      const y = options.chartHeight - (point.chars / options.maxChars) * (options.chartHeight - 28);
      return `${index === 0 ? "M" : "L"} ${roundPathValue(x)} ${roundPathValue(y)}`;
    })
    .join(" ");
}

function maxTrendChars(points: FrameTrendPoint[] | undefined) {
  return points?.reduce((max, point) => Math.max(max, point.chars), 0) ?? 0;
}

function roundPathValue(value: number) {
  return Math.round(value * 10) / 10;
}
