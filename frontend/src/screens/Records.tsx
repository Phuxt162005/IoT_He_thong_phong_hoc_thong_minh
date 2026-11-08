import { useState } from "react";
import type { ReactNode } from "react";
import { dateText, read, timeRange } from "../lib/resources";
import type { AnomalyRecord, AuditRecord } from "../lib/resource-types";
import { useDevices, usePage, useRooms } from "../hooks/useApi";
import { StatusBadge } from "../components/ui";
import {
  Choice,
  ErrorBox,
  Filters,
  Inspect,
  Paged,
  Title,
  useAction,
  useFilters,
} from "../components/workspace-ui";
import { localInput } from "../lib/resources";
export function AuditPage() {
  const filter = useFilters();
  const [draft, setDraft] = useState<Record<string, string>>({
    from: localInput(new Date(Date.now() - 7 * 86400000)),
    to: localInput(new Date(Date.now() + 1000)),
  });
  const query = usePage<AuditRecord>("audit", "/audit-logs", filter.params);
  const [error, setError] = useState<unknown>();
  const [detail, setDetail] = useState<AuditRecord>();
  return (
    <>
      <Title>Nhật ký thao tác</Title>
      <form
        className="filters workspace-filters"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const range = timeRange(draft.from, draft.to, 90);
            for (const [key, value] of Object.entries({ ...draft, ...range }))
              filter.filter(key, value);
            setError(undefined);
          } catch (error) {
            setError(error);
          }
        }}
      >
        {[
          ["action", "Hành động"],
          ["actor_id", "ID người thực hiện"],
          ["target_type", "Loại đối tượng"],
          ["target_id", "ID đối tượng"],
          ["request_id", "Request ID"],
        ].map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              value={draft[key] || ""}
              onChange={(event) =>
                setDraft({ ...draft, [key]: event.target.value })
              }
            />
          </label>
        ))}
        <Choice
          label="Người thực hiện"
          value={draft.actor_type || ""}
          options={["USER", "DEVICE", "SYSTEM"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(v) => setDraft({ ...draft, actor_type: v })}
        />
        <Choice
          label="Kết quả"
          value={draft.result || ""}
          options={["SUCCESS", "FAILURE", "DENIED"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(v) => setDraft({ ...draft, result: v })}
        />
        <label>
          Từ
          <input
            required
            type="datetime-local"
            step="1"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        <label>
          Đến
          <input
            required
            type="datetime-local"
            step="1"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </label>
        <button className="primary">Lọc</button>
      </form>
      {error && <ErrorBox error={error} />}
      <Paged
        query={query}
        change={filter.go}
        rowKey={(row) => row.log_id}
        columns={[
          { label: "Thời gian", render: (row) => dateText(row.created_at) },
          {
            label: "Người thực hiện",
            render: (row) => `${row.actor_type} ${row.actor_id || ""}`,
          },
          { label: "Hành động", render: (row) => row.action },
          {
            label: "Đối tượng",
            render: (row) => `${row.target_type} ${row.target_id || ""}`,
          },
          {
            label: "Kết quả",
            render: (row) => <StatusBadge status={row.result} />,
          },
          { label: "Request ID", render: (row) => row.request_id || "—" },
          {
            label: "Chi tiết",
            render: (row) => (
              <button className="secondary" onClick={() => setDetail(row)}>
                Xem metadata
              </button>
            ),
          },
        ]}
      />
      {detail && (
        <Inspect
          title="Chi tiết nhật ký"
          value={detail}
          close={() => setDetail(undefined)}
        />
      )}
    </>
  );
}
export function AnomaliesPage() {
  const rooms = useRooms();
  const filter = useFilters({ anomaly_detected: "true" });
  const devices = useDevices(String(filter.params.room_id || "") || undefined);
  const query = usePage<AnomalyRecord>(
    "anomalies",
    "/anomalies",
    filter.params,
  );
  const [detail, setDetail] = useState<ReactNode>();
  const action = useAction();
  return (
    <>
      <Title>Phát hiện bất thường</Title>
      <Filters>
        <Choice
          label="Phòng"
          value={String(filter.params.room_id || "")}
          options={
            rooms.data?.map((room) => ({
              value: room.room_id,
              label: room.room_name,
            })) || []
          }
          onChange={(v) => {
            filter.filter("room_id", v);
            filter.filter("device_id", "");
          }}
        />
        <Choice
          label="Thiết bị"
          value={String(filter.params.device_id || "")}
          options={
            devices.data?.map((device) => ({
              value: device.device_id,
              label: device.device_name,
            })) || []
          }
          onChange={(v) => filter.filter("device_id", v)}
        />
        <Choice
          label="Kết quả"
          value={String(filter.params.anomaly_detected || "")}
          options={[
            { value: "true", label: "Có bất thường" },
            { value: "false", label: "Bình thường / đang khởi tạo" },
          ]}
          onChange={(v) => filter.filter("anomaly_detected", v)}
        />
      </Filters>
      {action.error && <ErrorBox error={action.error} />}
      <Paged
        query={query}
        change={filter.go}
        rowKey={(row) => row.result_id}
        columns={[
          {
            label: "Đo / phân tích",
            render: (row) => (
              <>
                {dateText(row.recorded_at)}
                <small className="block muted">
                  {dateText(row.analyzed_at)}
                </small>
              </>
            ),
          },
          {
            label: "Thiết bị / phòng",
            render: (row) => (
              <>
                {row.device_code}
                <small className="block muted">{row.room_name}</small>
              </>
            ),
          },
          {
            label: "Kết quả",
            render: (row) => (
              <StatusBadge
                status={row.anomaly_detected ? "WARNING" : "NORMAL"}
              />
            ),
          },
          {
            label: "Chỉ số",
            render: (row) => (
              <div>
                {row.findings.map((finding) => (
                  <div key={finding.metric}>
                    {finding.metric}: <strong>{finding.value}</strong> ·{" "}
                    {finding.status} · baseline {finding.baselineSamples ?? 0} ·
                    score {finding.score ?? "—"}
                  </div>
                ))}
              </div>
            ),
          },
          {
            label: "Chi tiết",
            render: (row) => (
              <button
                className="secondary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    async () =>
                      setDetail(
                        <Inspect
                          title="Chi tiết phát hiện và baseline"
                          value={await read(`/anomalies/${row.result_id}`)}
                          close={() => setDetail(null)}
                        />,
                      ),
                    "",
                  )
                }
              >
                Xem
              </button>
            ),
          },
        ]}
      />
      {detail}
    </>
  );
}
