import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkCaptureBridge, NetworkCaptureSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/index.js";

const PAGE_SIZE = 100;

/** 网络页只轮询有界投影；采集生命周期属于 Main 中的窗口。 */
export function NetworkSection({ bridge }: { bridge?: NetworkCaptureBridge }) {
  const { intl, locale } = useZCodeIntl();
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    [locale],
  );
  const [snapshot, setSnapshot] = useState<NetworkCaptureSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!bridge || clearing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const startedGeneration = generation.current;
      try {
        const next = await bridge.getSnapshot();
        if (!disposed && startedGeneration === generation.current) {
          setSnapshot(next);
          setFailed(false);
        }
      } catch {
        if (!disposed && startedGeneration === generation.current) setFailed(true);
      }
      if (!disposed) timer = setTimeout(refresh, 500);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [bridge, clearing, revision]);
  const records = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (snapshot?.records ?? [])
      .filter(
        (record) =>
          !query ||
          `${record.processType} ${record.pid} ${record.method} ${record.url}`
            .toLowerCase()
            .includes(query),
      )
      .toSorted((left, right) => right.timestamp - left.timestamp || right.id - left.id);
  }, [snapshot, filter]);
  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const clear = async () => {
    if (!bridge) return;
    // 清空前已发出的快照不能在返回后把旧列表写回来。
    generation.current++;
    setClearing(true);
    try {
      await bridge.clear();
      setSnapshot(null);
      setPage(0);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setClearing(false);
      setRevision((value) => value + 1);
    }
  };
  const label = (id: string) => intl.formatMessage({ id: `resourceManager.network.${id}` });
  return (
    <section
      className="space-y-3"
      aria-label={intl.formatMessage({ id: "resourceManager.network" })}
    >
      <p className="text-ui-sm text-muted-foreground">{label("description")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}
          aria-label={label("filter")}
          placeholder={label("filter")}
        />
        <Button variant="outline" disabled={!bridge || clearing} onClick={() => void clear()}>
          {label("clear")}
        </Button>
      </div>
      {!bridge || failed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {label("unavailable")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm text-muted-foreground">
        <span>
          {intl.formatMessage(
            { id: "resourceManager.network.count" },
            { count: records.length, dropped: snapshot?.dropped ?? 0 },
          )}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {label("previous")}
          </Button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            variant="ghost"
            disabled={currentPage + 1 === pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            {label("next")}
          </Button>
        </div>
      </div>
      <div
        data-testid="resource-network-list"
        className="overflow-x-auto rounded-xl border border-border bg-background"
      >
        <table className="w-full table-fixed text-left text-ui-sm">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="w-24 px-3 py-2 font-medium">{label("time")}</th>
              <th className="w-28 px-3 py-2 font-medium">{label("process")}</th>
              <th className="w-20 px-3 py-2 font-medium">{label("method")}</th>
              <th className="px-3 py-2 font-medium">URL</th>
            </tr>
          </thead>
          <tbody>
            {records.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((record) => (
              <tr key={record.id} className="border-b border-border last:border-0 hover:bg-hover">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {timeFormat.format(record.timestamp)}
                </td>
                <td className="px-3 py-2">
                  <div>{record.processType}</div>
                  <div className="text-muted-foreground tabular-nums">{record.pid}</div>
                </td>
                <td className="px-3 py-2 font-mono">{record.method}</td>
                <td className="break-all px-3 py-2 select-text" title={record.url}>
                  {record.url}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 ? (
          <p className="p-6 text-center text-ui-sm text-muted-foreground">
            {label(filter ? "noMatches" : "empty")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
