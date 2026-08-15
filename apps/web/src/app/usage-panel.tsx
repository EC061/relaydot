"use client";

import { useMemo, useState } from "react";

import {
  PROVIDERS,
  RANGES,
  formatBucketTick,
  formatBucketTooltip,
  formatShare,
  formatTokens,
  formatUsd
} from "@/lib/analytics";
import type { ProviderKey, RangeKey, UsageSummary } from "@/lib/analytics";

/**
 * Categorical slots 1 and 2 from the documented visualization palette, stepped
 * for a dark surface and validated against this panel's ink background
 * (lightness band, chroma floor, CVD separation, normal-vision floor, contrast).
 * Colour follows the provider, never its rank, so filtering never repaints.
 */
const SERIES_COLOR: Record<ProviderKey, string> = {
  claude: "#3987e5",
  openai: "#d95926"
};

type Metric = "cost" | "tokens";
type Breakdown = "model" | "hour";

const PLOT = { width: 720, height: 190, top: 12, right: 8, bottom: 22, left: 44 };

function niceCeiling(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) {
      return candidate;
    }
  }
  return 10 * magnitude;
}

export function UsagePanel({ summary }: { summary: UsageSummary }) {
  const [metric, setMetric] = useState<Metric>("cost");
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const [hover, setHover] = useState<number | null>(null);

  const valueOf = (bucketIndex: number, provider: ProviderKey): number => {
    const slot = summary.buckets[bucketIndex].perProvider[provider];
    return metric === "cost" ? slot.costMicroUsd : slot.tokens;
  };

  const chart = useMemo(() => {
    const stacked = summary.buckets.map((_, index) =>
      PROVIDERS.reduce((sum, provider) => sum + valueOf(index, provider.key), 0)
    );
    const max = niceCeiling(Math.max(...stacked, 0));
    const innerWidth = PLOT.width - PLOT.left - PLOT.right;
    const innerHeight = PLOT.height - PLOT.top - PLOT.bottom;
    const stepX =
      summary.buckets.length > 1 ? innerWidth / (summary.buckets.length - 1) : 0;
    const x = (index: number) => PLOT.left + index * stepX;
    const y = (value: number) => PLOT.top + innerHeight * (1 - value / max);
    return { stacked, max, x, y, innerHeight, innerWidth };
  }, [summary, metric]);

  /** Cumulative bands so the fills stack without overlapping. */
  const bands = useMemo(() => {
    const running = summary.buckets.map(() => 0);
    return PROVIDERS.map((provider) => {
      const lower = [...running];
      summary.buckets.forEach((_, index) => {
        running[index] += valueOf(index, provider.key);
      });
      const upper = [...running];
      const top = upper.map((value, index) => `${chart.x(index)},${chart.y(value)}`);
      const bottom = lower
        .map((value, index) => `${chart.x(index)},${chart.y(value)}`)
        .reverse();
      return {
        provider,
        area: `${top.join(" ")} ${bottom.join(" ")}`,
        line: top.join(" "),
        upper
      };
    });
  }, [summary, metric, chart]);

  const formatValue = (value: number) =>
    metric === "cost" ? formatUsd(value) : formatTokens(value);

  const totalCost = summary.totals.costMicroUsd;
  const observedInput =
    summary.totals.inputUncached + summary.totals.cacheWrite + summary.totals.cacheRead;
  const savings = summary.totals.uncachedMicroUsd - totalCost;
  const perActiveHour =
    summary.activeBuckets > 0
      ? Math.round(
          (summary.totals.inputUncached +
            summary.totals.cacheWrite +
            summary.totals.cacheRead +
            summary.totals.output) /
            summary.activeBuckets
        )
      : 0;
  const processed =
    summary.totals.inputUncached +
    summary.totals.cacheWrite +
    summary.totals.cacheRead +
    summary.totals.output;

  const tiles = [
    {
      label: "Processed tokens",
      value: formatTokens(processed),
      note: `${formatTokens(perActiveHour)} per active ${
        summary.bucketSeconds === 3600 ? "hour" : "day"
      }`
    },
    {
      label: "Cached input",
      value: formatTokens(summary.totals.cacheRead),
      note: `${formatShare(summary.totals.cacheRead, observedInput)} of observed input`
    },
    {
      label: "Uncached input",
      value: formatTokens(summary.totals.inputUncached),
      note: `${formatTokens(summary.totals.cacheWrite)} cache writes`
    },
    {
      label: "Output",
      value: formatTokens(summary.totals.output),
      note: `includes ${formatTokens(summary.totals.reasoning)} reasoning`
    },
    {
      label: "Cache savings",
      value: formatUsd(savings),
      note:
        totalCost > 0
          ? `${(summary.totals.uncachedMicroUsd / totalCost).toFixed(1)}x the raw token cost`
          : "no billable usage yet"
    }
  ];

  const hourRows = summary.buckets
    .map((bucket, index) => ({
      index,
      label: formatBucketTooltip(bucket.start, summary.bucketSeconds),
      cost: PROVIDERS.reduce(
        (sum, provider) => sum + bucket.perProvider[provider.key].costMicroUsd,
        0
      ),
      tokens: PROVIDERS.reduce(
        (sum, provider) => sum + bucket.perProvider[provider.key].tokens,
        0
      )
    }))
    .filter((row) => row.tokens > 0)
    .reverse();

  const tickEvery = Math.max(1, Math.ceil(summary.buckets.length / 6));

  return (
    <section className="usagePanel" id="usage" aria-labelledby="usage-heading">
      <header className="usageTop">
        <div>
          <p className="eyebrow">Usage analytics</p>
          <h2 id="usage-heading">Token spend</h2>
        </div>
        <nav className="rangeTabs" aria-label="Time range">
          {RANGES.map((range) => (
            <a
              aria-current={summary.range === range.key ? "true" : undefined}
              className={summary.range === range.key ? "active" : undefined}
              href={`/?range=${range.key}#usage`}
              key={range.key}
            >
              {range.label}
            </a>
          ))}
        </nav>
      </header>

      <div className="usageGrid">
        <div className="costSummary">
          <p className="tileLabel">Raw token cost</p>
          <strong className="costHero">
            {formatUsd(totalCost)}
            <span aria-hidden="true">*</span>
          </strong>
          <p className="costHeroNote">* if billed at full API rate</p>

          <ul className="providerList">
            {PROVIDERS.map((provider) => {
              const totals = summary.perProvider[provider.key];
              const tokens =
                totals.inputUncached +
                totals.cacheWrite +
                totals.cacheRead +
                totals.output;
              return (
                <li key={provider.key}>
                  <div className="providerHead">
                    <span
                      className="swatch"
                      style={{ background: SERIES_COLOR[provider.key] }}
                    />
                    <span className="providerName">{provider.label}</span>
                    <span className="providerCost">
                      {formatUsd(totals.costMicroUsd)}
                    </span>
                  </div>
                  <div className="shareTrack">
                    <span
                      style={{
                        background: SERIES_COLOR[provider.key],
                        width:
                          totalCost > 0
                            ? `${(totals.costMicroUsd / totalCost) * 100}%`
                            : "0%"
                      }}
                    />
                  </div>
                  <p className="providerNote">
                    {formatShare(totals.costMicroUsd, totalCost)} of cost ·{" "}
                    {formatTokens(tokens)} tokens
                  </p>
                </li>
              );
            })}
          </ul>
        </div>

        <figure className="chartFigure">
          <figcaption>
            <span className="chartTitle">
              {summary.bucketSeconds === 3600 ? "Hourly" : "Daily"}{" "}
              {metric === "cost" ? "cost" : "tokens"}
            </span>
            <span className="chartControls">
              <span className="segmented" role="group" aria-label="Metric">
                <button
                  aria-pressed={metric === "cost"}
                  className={metric === "cost" ? "on" : undefined}
                  onClick={() => setMetric("cost")}
                  type="button"
                >
                  Cost
                </button>
                <button
                  aria-pressed={metric === "tokens"}
                  className={metric === "tokens" ? "on" : undefined}
                  onClick={() => setMetric("tokens")}
                  type="button"
                >
                  Tokens
                </button>
              </span>
              {/* Legend is always present for two series, so identity is never
                  colour-alone. */}
              <span className="legend">
                {PROVIDERS.map((provider) => (
                  <span key={provider.key}>
                    <span
                      className="swatch"
                      style={{ background: SERIES_COLOR[provider.key] }}
                    />
                    {provider.label}
                  </span>
                ))}
              </span>
            </span>
          </figcaption>

          <svg
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label={`${metric === "cost" ? "Cost" : "Tokens"} per ${
              summary.bucketSeconds === 3600 ? "hour" : "day"
            } by provider. Full values are in the breakdown table below.`}
            viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
          >
            {[0, 0.5, 1].map((fraction) => {
              const value = chart.max * (1 - fraction);
              const y = PLOT.top + chart.innerHeight * fraction;
              return (
                <g key={fraction}>
                  <line
                    className="gridline"
                    x1={PLOT.left}
                    x2={PLOT.width - PLOT.right}
                    y1={y}
                    y2={y}
                  />
                  <text className="axisText" dy="0.32em" textAnchor="end" x={PLOT.left - 8} y={y}>
                    {value === 0 ? "0" : formatValue(value)}
                  </text>
                </g>
              );
            })}

            {bands.map((band) => (
              <g key={band.provider.key}>
                <polygon
                  fill={SERIES_COLOR[band.provider.key]}
                  fillOpacity="0.22"
                  points={band.area}
                />
                {/* 2px stroke sits on the surface gap between stacked fills. */}
                <polyline
                  fill="none"
                  points={band.line}
                  stroke={SERIES_COLOR[band.provider.key]}
                  strokeLinecap="round"
                  strokeWidth="2"
                />
              </g>
            ))}

            {summary.buckets.map((bucket, index) =>
              index % tickEvery === 0 ? (
                <text
                  className="axisText"
                  key={bucket.start}
                  textAnchor={index === 0 ? "start" : "middle"}
                  x={chart.x(index)}
                  y={PLOT.height - 6}
                >
                  {formatBucketTick(bucket.start, summary.bucketSeconds)}
                </text>
              ) : null
            )}

            {hover !== null ? (
              <g>
                <line
                  className="crosshair"
                  x1={chart.x(hover)}
                  x2={chart.x(hover)}
                  y1={PLOT.top}
                  y2={PLOT.top + chart.innerHeight}
                />
                {bands.map((band) => (
                  <circle
                    cx={chart.x(hover)}
                    cy={chart.y(band.upper[hover])}
                    fill={SERIES_COLOR[band.provider.key]}
                    key={band.provider.key}
                    r="4.5"
                    stroke="#151811"
                    strokeWidth="2"
                  />
                ))}
              </g>
            ) : null}

            {/* Hit targets are wider than the marks they select. */}
            {summary.buckets.map((bucket, index) => (
              <rect
                fill="transparent"
                height={chart.innerHeight}
                key={bucket.start}
                onMouseEnter={() => setHover(index)}
                width={Math.max(6, chart.innerWidth / summary.buckets.length)}
                x={chart.x(index) - chart.innerWidth / summary.buckets.length / 2}
                y={PLOT.top}
              />
            ))}
          </svg>

          {hover !== null ? (
            <div className="tooltip" role="status">
              <strong>
                {formatBucketTooltip(summary.buckets[hover].start, summary.bucketSeconds)}
              </strong>
              {PROVIDERS.map((provider) => (
                <span key={provider.key}>
                  <span
                    className="swatch"
                    style={{ background: SERIES_COLOR[provider.key] }}
                  />
                  {provider.label}
                  <b>{formatValue(valueOf(hover, provider.key))}</b>
                </span>
              ))}
            </div>
          ) : (
            <p className="chartHint">Hover the chart for per-bucket values.</p>
          )}
        </figure>
      </div>

      <div className="tileRow">
        {tiles.map((tile) => (
          <article key={tile.label}>
            <p className="tileLabel">{tile.label}</p>
            <strong>{tile.value}</strong>
            <span>{tile.note}</span>
          </article>
        ))}
      </div>

      <div className="breakdown">
        <div className="breakdownHead">
          <span className="chartTitle">Breakdown</span>
          <span className="segmented" role="group" aria-label="Breakdown dimension">
            <button
              aria-pressed={breakdown === "model"}
              className={breakdown === "model" ? "on" : undefined}
              onClick={() => setBreakdown("model")}
              type="button"
            >
              Model
            </button>
            <button
              aria-pressed={breakdown === "hour"}
              className={breakdown === "hour" ? "on" : undefined}
              onClick={() => setBreakdown("hour")}
              type="button"
            >
              {summary.bucketSeconds === 3600 ? "Hour" : "Day"}
            </button>
          </span>
        </div>

        {summary.models.length === 0 ? (
          <p className="quiet">
            No usage in this window. Configure a WebDAV store and sync a node to
            populate this view.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">{breakdown === "model" ? "Model" : "Bucket"}</th>
                <th className="num" scope="col">
                  Cost
                </th>
                <th className="num" scope="col">
                  Share
                </th>
                <th className="num" scope="col">
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {breakdown === "model"
                ? summary.models.map((row) => (
                    <tr key={row.modelId}>
                      <th scope="row">
                        <span
                          className="swatch"
                          style={{ background: SERIES_COLOR[row.provider] }}
                        />
                        {row.modelId}
                        {row.priced ? null : (
                          <em className="unpriced" title="No reviewed price on file">
                            unpriced
                          </em>
                        )}
                      </th>
                      <td className="num">{formatUsd(row.costMicroUsd)}</td>
                      <td className="num">{formatShare(row.costMicroUsd, totalCost)}</td>
                      <td className="num">{formatTokens(row.tokens)}</td>
                    </tr>
                  ))
                : hourRows.map((row) => (
                    <tr key={row.index}>
                      <th scope="row">{row.label}</th>
                      <td className="num">{formatUsd(row.cost)}</td>
                      <td className="num">{formatShare(row.cost, totalCost)}</td>
                      <td className="num">{formatTokens(row.tokens)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        )}

        {summary.unpricedModels.length > 0 ? (
          <p className="quiet">
            {summary.unpricedModels.length} model
            {summary.unpricedModels.length === 1 ? "" : "s"} have no reviewed price and
            contribute tokens but no cost: {summary.unpricedModels.join(", ")}.
          </p>
        ) : null}
      </div>
    </section>
  );
}
