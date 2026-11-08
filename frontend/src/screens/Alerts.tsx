import { useState } from "react";
import type { ReactNode } from "react";
import { useAuthStore } from "../store/auth";
import { dateText, read, write } from "../lib/resources";
import type { AlertRecord, Threshold } from "../lib/resource-types";
import { usePage, useRooms } from "../hooks/useApi";
import { StatusBadge } from "../components/ui";
import {
  Choice,
  Editor,
  ErrorBox,
  Filters,
  Inspect,
  Paged,
  Title,
  useAction,
  useFilters,
} from "../components/workspace-ui";
import type { Field } from "../components/workspace-ui";
export function AlertsPage() {
  const role = useAuthStore((s) => s.user?.role);
  const canAct = role === "ADMIN" || role === "OPERATOR";
  const rooms = useRooms();
  const filter = useFilters();
  const query = usePage<AlertRecord>("alerts", "/alerts", filter.params);
  const [editor, setEditor] = useState<ReactNode>();
  const action = useAction();
  const act = (alert: AlertRecord, resolve: boolean) =>
    setEditor(
      <Editor
        title={resolve ? "Đóng cảnh báo" : "Xác nhận cảnh báo"}
        fields={
          resolve
            ? [
                {
                  name: "reason",
                  label: "Lý do xử lý",
                  required: true,
                  minLength: 3,
                  maxLength: 255,
                },
              ]
            : []
        }
        close={() => setEditor(null)}
        save={(values) =>
          write(
            "POST",
            `/alerts/${alert.alert_id}/${resolve ? "resolve" : "acknowledge"}`,
            resolve ? { reason: values.reason } : {},
          )
        }
      >
        <p>{alert.message || alert.alert_type}</p>
      </Editor>,
    );
  const thresholds = () =>
    action.run(async () => {
      const id = String(filter.params.room_id);
      const rows = await read<Threshold[]>(`/rooms/${id}/alert-thresholds`);
      if (role !== "ADMIN") {
        setEditor(
          <Inspect
            title="Ngưỡng cảnh báo của phòng"
            value={rows}
            close={() => setEditor(null)}
          />,
        );
        return;
      }
      const fields: Field[] = [];
      const initial: Record<string, string> = {};
      for (const sensor of ["TEMPERATURE", "HUMIDITY"])
        for (const severity of ["WARNING", "CRITICAL"]) {
          const key = sensor + "_" + severity;
          const row = rows.find(
            (row) => row.sensor_type === sensor && row.severity === severity,
          );
          fields.push(
            {
              name: key + "_enabled",
              label: `${sensor} · ${severity} · Bật`,
              type: "checkbox",
            },
            {
              name: key + "_operator",
              label: "So sánh",
              type: "select",
              required: true,
              options: [
                { value: "GT", label: "Lớn hơn" },
                { value: "GTE", label: "Lớn hơn hoặc bằng" },
              ],
            },
            {
              name: key + "_threshold",
              label: "Ngưỡng kích hoạt",
              type: "number",
              required: true,
              min: sensor === "TEMPERATURE" ? -10 : 0,
              max: sensor === "TEMPERATURE" ? 60 : 100,
              step: "any",
            },
            {
              name: key + "_clear",
              label: "Ngưỡng phục hồi",
              type: "number",
              required: true,
              min: sensor === "TEMPERATURE" ? -10 : 0,
              max: sensor === "TEMPERATURE" ? 60 : 100,
              step: "any",
            },
          );
          initial[key + "_enabled"] = String(row?.is_enabled ?? true);
          initial[key + "_operator"] = row?.operator || "GT";
          initial[key + "_threshold"] = String(
            row?.threshold_value ?? (sensor === "TEMPERATURE" ? 30 : 80),
          );
          initial[key + "_clear"] = String(
            row?.clear_value ?? (sensor === "TEMPERATURE" ? 28 : 75),
          );
        }
      setEditor(
        <Editor
          title="Ngưỡng cảnh báo của phòng"
          fields={fields}
          initial={initial}
          close={() => setEditor(null)}
          save={(values) => {
            const thresholds = ["TEMPERATURE", "HUMIDITY"].flatMap(
              (sensor_type) =>
                ["WARNING", "CRITICAL"].map((severity) => {
                  const key = sensor_type + "_" + severity;
                  return {
                    sensor_type,
                    severity,
                    is_enabled: values[key + "_enabled"] === "true",
                    operator: values[key + "_operator"],
                    threshold_value: Number(values[key + "_threshold"]),
                    clear_value: Number(values[key + "_clear"]),
                  };
                }),
            );
            for (const row of thresholds)
              if (row.clear_value > row.threshold_value)
                throw new Error(
                  "Ngưỡng phục hồi phải không lớn hơn ngưỡng kích hoạt.",
                );
            return write("PUT", `/rooms/${id}/alert-thresholds`, {
              thresholds,
            });
          }}
        />,
      );
    }, "");
  return (
    <>
      <Title
        action={
          <button
            className="primary"
            disabled={!filter.params.room_id || action.busy}
            onClick={() => void thresholds()}
          >
            {role === "ADMIN" ? "Cấu hình ngưỡng phòng" : "Xem ngưỡng phòng"}
          </button>
        }
      >
        Cảnh báo
      </Title>
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
          onChange={(v) => filter.filter("room_id", v)}
        />
        {[
          ["status", "Trạng thái", ["OPEN", "ACKNOWLEDGED", "RESOLVED"]],
          ["severity", "Mức độ", ["WARNING", "CRITICAL"]],
          [
            "alert_type",
            "Loại",
            ["TEMP_HIGH", "HUMIDITY_HIGH", "DEVICE_OFFLINE", "DEVICE_FAULT"],
          ],
        ].map(([key, label, values]) => (
          <Choice
            key={String(key)}
            label={String(label)}
            value={String(filter.params[String(key)] || "")}
            options={(values as string[]).map((value) => ({
              value,
              label: value,
            }))}
            onChange={(v) => filter.filter(String(key), v)}
          />
        ))}
      </Filters>
      {action.error && <ErrorBox error={action.error} />}
      <Paged
        query={query}
        change={filter.go}
        rowKey={(row) => row.alert_id}
        columns={[
          { label: "Loại", render: (row) => row.alert_type },
          {
            label: "Phòng",
            render: (row) =>
              rooms.data?.find((room) => room.room_id === row.room_id)
                ?.room_name || row.room_id,
          },
          {
            label: "Mức độ",
            render: (row) => <StatusBadge status={row.severity} />,
          },
          {
            label: "Giá trị / số lần",
            render: (row) => `${row.value ?? "—"} / ${row.occurrence_count}`,
          },
          {
            label: "Trạng thái",
            render: (row) => <StatusBadge status={row.status} />,
          },
          { label: "Thời gian", render: (row) => dateText(row.created_at) },
          {
            label: "Thao tác",
            render: (row) => (
              <div className="user-actions">
                <button
                  className="secondary"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      setEditor(
                        <Inspect
                          title="Chi tiết cảnh báo"
                          value={await read(`/alerts/${row.alert_id}`)}
                          close={() => setEditor(null)}
                        />,
                      );
                    }, "")
                  }
                >
                  Chi tiết
                </button>
                {canAct && row.status === "OPEN" && (
                  <button className="secondary" onClick={() => act(row, false)}>
                    Xác nhận
                  </button>
                )}
                {canAct && row.status !== "RESOLVED" && (
                  <button className="secondary" onClick={() => act(row, true)}>
                    Đóng
                  </button>
                )}
              </div>
            ),
          },
        ]}
      />
      {editor}
    </>
  );
}
