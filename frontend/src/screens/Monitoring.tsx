import { useState } from "react";
import { dateText, timeRange } from "../lib/resources";
import { useApi, usePage } from "../hooks/useApi";
import { Card, Loading, StatusBadge } from "../components/ui";
import {
  Choice,
  DetailData,
  ErrorBox,
  Inspect,
  Paged,
  Title,
  useFilters,
} from "../components/workspace-ui";
import { localInput } from "../lib/resources";
type Snapshot = {
  generatedAt: string;
  summary: Record<string, number>;
  components: Record<string, unknown>[];
  devices: Record<string, unknown>[];
  counters: unknown;
};
export function MonitoringPage() {
  const snapshot = useApi<Snapshot>("monitoring", "/monitoring/snapshot");
  const filter = useFilters();
  const logs = usePage<Record<string, unknown>>(
    "monitoring-logs",
    "/monitoring/logs",
    filter.params,
  );
  const [draft, setDraft] = useState<Record<string, string>>({
    from: localInput(new Date(Date.now() - 86400000)),
    to: localInput(new Date(Date.now() + 1000)),
  });
  const [error, setError] = useState<unknown>();
  const [detail, setDetail] = useState<unknown>();
  return (
    <>
      <Title
        action={
          <button className="secondary" onClick={() => void snapshot.refetch()}>
            Cập nhật sức khỏe
          </button>
        }
      >
        Giám sát hệ thống
      </Title>
      {snapshot.isLoading ? (
        <Loading />
      ) : snapshot.error ? (
        <ErrorBox
          error={snapshot.error}
          retry={() => void snapshot.refetch()}
        />
      ) : snapshot.data ? (
        <>
          <p className="muted">
            Cập nhật: {dateText(snapshot.data.generatedAt)}
          </p>
          <div className="metric-grid">
            {Object.entries(snapshot.data.summary || {}).map(([key, value]) => (
              <Card key={key}>
                <p className="muted">
                  {(
                    {
                      componentCount: "Thành phần",
                      componentUp: "Hoạt động",
                      componentDegraded: "Suy giảm",
                      componentDown: "Ngừng hoạt động",
                      deviceCount: "Thiết bị",
                      deviceOnline: "Online",
                      deviceOffline: "Offline",
                    } as Record<string, string>
                  )[key] || key}
                </p>
                <div className="metric">{value}</div>
              </Card>
            ))}
          </div>
          <Card>
            <h3>Thành phần hệ thống</h3>
            {snapshot.data.components?.map((row, index) => (
              <div className="list-row" key={String(row.name || index)}>
                <span>{String(row.name || row.component || "Thành phần")}</span>
                <StatusBadge status={String(row.status || "UNKNOWN")} />
              </div>
            ))}
            <details>
              <summary>Chẩn đoán thiết bị và bộ đếm</summary>
              <DetailData
                value={{
                  devices: snapshot.data.devices,
                  counters: snapshot.data.counters,
                }}
              />
            </details>
          </Card>
        </>
      ) : null}
      <h3>Tra cứu log</h3>
      <form
        className="filters workspace-filters"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const range = timeRange(draft.from, draft.to, 30);
            for (const [key, value] of Object.entries({ ...draft, ...range }))
              filter.filter(key, value);
            setError(undefined);
          } catch (error) {
            setError(error);
          }
        }}
      >
        <Choice
          label="Mức độ"
          value={draft.level || ""}
          options={["DEBUG", "INFO", "WARN", "ERROR"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(v) => setDraft({ ...draft, level: v })}
        />
        {[
          ["service", "Dịch vụ"],
          ["search", "Tìm nội dung"],
        ].map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              value={draft[key] || ""}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
        <label>
          Từ
          <input
            type="datetime-local"
            step="1"
            required
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        <label>
          Đến
          <input
            type="datetime-local"
            step="1"
            required
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </label>
        <button className="primary">Lọc log</button>
      </form>
      {error && <ErrorBox error={error} />}
      <Paged
        query={logs}
        change={filter.go}
        rowKey={(row) => String(row.logId || row.log_id || row.id)}
        columns={[
          {
            label: "Thời gian",
            render: (row) =>
              dateText(
                String(
                  row.logged_at ||
                    row.recorded_at ||
                    row.timestamp ||
                    row.created_at,
                ),
              ),
          },
          {
            label: "Mức độ",
            render: (row) => <StatusBadge status={String(row.level)} />,
          },
          { label: "Dịch vụ", render: (row) => String(row.service || "—") },
          { label: "Nội dung", render: (row) => String(row.message || "—") },
          {
            label: "Chi tiết",
            render: (row) => (
              <button className="secondary" onClick={() => setDetail(row)}>
                Xem
              </button>
            ),
          },
        ]}
      />
      {detail && (
        <Inspect
          title="Chi tiết log"
          value={detail}
          close={() => setDetail(undefined)}
        />
      )}
    </>
  );
}
