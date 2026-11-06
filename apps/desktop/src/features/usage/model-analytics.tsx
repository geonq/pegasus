import type { ModelPerformance, UsageReport } from "../../../contracts/usage";
import { ProviderIcon } from "../../ui/icons";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function ModelAnalytics({
  report,
  account,
  since,
}: {
  readonly report: UsageReport;
  readonly account: string;
  readonly since: number;
}) {
  const models = new Map<string, ModelPerformance>();
  for (const row of report.performance ?? []) {
    if (row.dayStart < since || (account !== "all" && !row.key.startsWith(`${account}/`))) continue;
    const previous = models.get(row.key);
    models.set(
      row.key,
      previous
        ? {
            ...row,
            requests: previous.requests + row.requests,
            requestMs: previous.requestMs + row.requestMs,
            outputTokens: previous.outputTokens + row.outputTokens,
            tasks: previous.tasks + row.tasks,
            taskMs: previous.taskMs + row.taskMs,
            pricedTasks: previous.pricedTasks + row.pricedTasks,
            taskApiCost: previous.taskApiCost + row.taskApiCost,
            taskTokens: previous.taskTokens + row.taskTokens,
            promptTokens: previous.promptTokens + row.promptTokens,
            cachedTokens: previous.cachedTokens + row.cachedTokens,
            replyTokens: previous.replyTokens + row.replyTokens,
          }
        : row,
    );
  }
  return (
    <section className="usage-card usage-model-analytics" aria-label="Model analytics">
      <h3>Model analytics</h3>
      {report.openscalePlan && (account === "all" || account === "openscale") ? (
        <p className="usage-view__note">
          <ProviderIcon providerId="openscale" /> OpenScale · Unlimited plan key. Included models do
          not bill your balance. Subscription fee is separate.
        </p>
      ) : null}
      <p className="usage-view__note">
        Saved conversations only; automatic title calls are excluded. Compare consumption, speed and
        completed tasks by model.
      </p>
      {models.size ? (
        <div
          className="usage-model-analytics__scroll"
          tabIndex={0}
          role="region"
          aria-label="Model comparison table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Effective output tok/s</th>
                <th scope="col">Timed replies</th>
                <th scope="col">Avg task time</th>
                <th scope="col">Tasks</th>
                <th scope="col">API value / task</th>
                <th scope="col">Tokens / task</th>
                <th scope="col">Cache reuse</th>
                <th scope="col">Input / output</th>
              </tr>
            </thead>
            <tbody>
              {[...models.values()]
                .sort((a, b) => b.requests - a.requests)
                .map((row) => {
                  const slash = row.key.indexOf("/");
                  const provider = row.key.slice(0, slash);
                  const model = row.key.slice(slash + 1);
                  return (
                    <tr key={row.key}>
                      <th scope="row">
                        <span title={model}>
                          <ProviderIcon providerId={provider} modelId={model} />
                          {model.split("/").at(-1)}
                        </span>
                        <small>{provider}</small>
                      </th>
                      <td>
                        {row.requestMs
                          ? number.format(row.outputTokens / (row.requestMs / 1000))
                          : "Unavailable"}
                      </td>
                      <td>{number.format(row.requests)}</td>
                      <td>
                        {row.tasks
                          ? `${number.format(row.taskMs / row.tasks / 1000)} s`
                          : "Unavailable"}
                      </td>
                      <td>{number.format(row.tasks)}</td>
                      <td title={`${row.pricedTasks} tasks with known public API prices`}>
                        {row.pricedTasks
                          ? money.format(row.taskApiCost / row.pricedTasks)
                          : "Unavailable"}
                      </td>
                      <td>
                        {row.tasks ? number.format(row.taskTokens / row.tasks) : "Unavailable"}
                      </td>
                      <td>
                        {row.promptTokens
                          ? `${number.format((row.cachedTokens / row.promptTokens) * 100)}%`
                          : "Unavailable"}
                      </td>
                      <td>
                        {row.replyTokens
                          ? `${number.format(row.promptTokens / row.replyTokens)}:1`
                          : "Unavailable"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="usage-card__empty">No comparable timing records for this selection.</p>
      )}
      <details className="usage-view__note">
        <summary>How these numbers work</summary>
        <p>
          Effective speed includes request latency and reasoning; task time includes tools. One task
          runs from a user request to its final reply. Interrupted and mixed-model tasks are
          excluded. Different tasks are not a controlled benchmark.
        </p>
        <p>
          API value is an estimate at public PAYG prices, not an invoice or an additional charge on
          your unlimited plan. Historical prices may differ. Missing timing and prices stay
          unavailable.
        </p>
        <p>
          Cache reuse is cached input divided by all prompt tokens. Tokens per task includes
          repeated context and output across its replies. These describe consumption, not answer
          quality or parity with another coding agent.
        </p>
      </details>
    </section>
  );
}
