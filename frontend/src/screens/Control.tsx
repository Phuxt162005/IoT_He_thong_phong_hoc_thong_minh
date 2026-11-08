import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth";
import { useSearchParams } from "react-router-dom";
import { useClock } from "../hooks/useClock";
import { deviceBlockReason } from "../lib/device-readiness";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { commandText, dateText, page, write } from "../lib/resources";
import type { CommandRecord, ShadowRecord } from "../lib/resource-types";
import { useApi, useDevices, usePage, useRooms } from "../hooks/useApi";
import { StatusBadge } from "../components/ui";
import {
  ActuatorStatus,
  actuatorStateName,
} from "../components/actuator-status";
import {
  Choice,
  Editor,
  ErrorBox,
  Filters,
  Paged,
  Title,
} from "../components/workspace-ui";
type Submission = {
  device: string;
  key: string;
  retryUntil: number;
  desired_state: { light?: "ON" | "OFF"; fan?: "ON" | "OFF" };
};
// The backend caches an idempotency key for 60 seconds. Use a monotonic
// 55-second window from the first attempt, preserving a network safety margin.
const SAFE_RETRY_MS = 55000;
export function ControlPage() {
  const canControl = useAuthStore((state) => state.user?.role !== "VIEWER");
  const queries = useQueryClient();
  const [params] = useSearchParams();
  const rooms = useRooms();
  const [selectedRoom, setRoom] = useState(() => params.get("room_id") || "");
  const room =
    rooms.data?.find((item) => item.room_id === selectedRoom)?.room_id ||
    rooms.data?.[0]?.room_id ||
    "";
  const devices = useDevices(room || undefined);
  const controls =
    devices.data?.filter(
      (device) =>
        device.room_id === room && device.device_type === "CONTROL_NODE",
    ) || [];
  const [selection, setDevice] = useState(() => params.get("device_id") || "");
  const device =
    controls.find((item) => item.device_id === selection) ||
    controls.find((item) => item.lifecycle_status === "ACTIVE") ||
    controls[0];
  const id = device?.device_id || "";
  const shadow = useApi<ShadowRecord>(
    "shadow",
    `/devices/${id}/shadow`,
    {},
    Boolean(id),
  );
  const [historyPage, setHistoryPage] = useState(1);
  const history = usePage<CommandRecord>(
    "commands",
    `/devices/${id}/commands`,
    { page: historyPage, page_size: 20 },
    Boolean(id),
  );
  const [pending, setPending] = useState<CommandRecord>();
  const pendingRef = useRef<CommandRecord>();
  pendingRef.current = pending;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState<Submission>();
  const now = useClock(Boolean(retry));
  useEffect(() => {
    if (retry && performance.now() >= retry.retryUntil) {
      setRetry(undefined);
      setError(undefined);
      setMessage(
        "Đã hết thời hạn gửi lại an toàn. Hãy cập nhật lịch sử và trạng thái trước khi tạo yêu cầu mới.",
      );
    }
  }, [retry, now]);
  const [modeEditor, setModeEditor] = useState(false);
  const finish = (command: CommandRecord) => {
    if (
      !pendingRef.current ||
      command.command_id !== pendingRef.current.command_id
    )
      return;
    setPending(undefined);
    pendingRef.current = undefined;
    setMessage(
      `Lệnh ${command.command_id}: ${command.status}${command.error_code ? " · " + command.error_code : ""}`,
    );
    void queries.invalidateQueries({ queryKey: ["shadow"] });
    void queries.invalidateQueries({ queryKey: ["commands"] });
  };
  const check = useQuery({
    queryKey: ["pending-command", pending?.command_id],
    enabled: Boolean(pending),
    queryFn: ({ signal }) =>
      page<CommandRecord>(
        `/devices/${pending!.device_id}/commands`,
        { page_size: 100 },
        signal,
      ),
    retry: false,
    refetchInterval: pending ? 2000 : false,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    const command = check.data?.items.find(
      (row) => row.command_id === pending?.command_id,
    );
    if (command && command.status !== "PENDING") finish(command);
  }, [check.data, pending?.command_id]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(
      () => {
        if (pendingRef.current?.command_id === pending.command_id) {
          setPending(undefined);
          pendingRef.current = undefined;
          setMessage(
            "Chưa nhận được kết quả cuối. Hãy cập nhật lịch sử; trạng thái thiết bị không được tự đổi.",
          );
          void queries.invalidateQueries({ queryKey: ["commands"] });
        }
      },
      Math.max(1000, Date.parse(pending.timeout_at) - Date.now() + 3000),
    );
    return () => window.clearTimeout(timer);
  }, [pending?.command_id]);
  useEffect(() => {
    const listener = (event: Event) => {
      const data = (
        event as CustomEvent<{
          type: string;
          payload: {
            command_id?: string;
            device_id?: string;
            status?: string;
            error_code?: string;
          };
        }>
      ).detail;
      if (
        data.type === "command.updated" &&
        data.payload.command_id === pendingRef.current?.command_id &&
        data.payload.status &&
        data.payload.status !== "PENDING"
      )
        finish({
          ...pendingRef.current!,
          status: data.payload.status,
          error_code: data.payload.error_code,
        });
    };
    window.addEventListener("iot:event", listener);
    return () => window.removeEventListener("iot:event", listener);
  }, [queries]);
  async function send(submission: Submission) {
    if (!canControl || busyRef.current || pendingRef.current) return;
    if (performance.now() >= submission.retryUntil) {
      setRetry(undefined);
      setMessage(
        "Đã hết thời hạn gửi lại an toàn. Hãy kiểm tra lịch sử trước khi tạo yêu cầu mới.",
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setRetry(undefined);
    setMessage("Đang gửi lệnh…");
    try {
      const response = await write<{ command: CommandRecord }>(
        "POST",
        `/devices/${submission.device}/commands`,
        { desired_state: submission.desired_state },
        { "Idempotency-Key": submission.key },
      );
      setPending(response.command);
      pendingRef.current = response.command;
      if (response.command.status !== "PENDING") finish(response.command);
      else setMessage(`Đang chờ ACK · ${response.command.command_id}`);
      void queries.invalidateQueries({ queryKey: ["commands"] });
    } catch (error) {
      setError(error);
      setRetry(submission);
      setMessage(
        "Chưa xác định kết quả gửi. Nếu thử lại, hệ thống sẽ dùng cùng mã yêu cầu để tránh tạo lệnh trùng.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const blocked = busy || Boolean(pending);
  const blockReason = deviceBlockReason(
    device,
    ["ACTIVE"],
    rooms.data?.find((item) => item.room_id === room)?.status,
  );
  const ready = !blockReason;
  const canChangeMode = Boolean(
    id &&
      device &&
      !["REVOKED", "DECOMMISSIONED"].includes(device.lifecycle_status),
  );
  return (
    <>
      <Title>Điều khiển</Title>
      <Filters>
        <Choice
          label="Phòng"
          value={room}
          disabled={blocked}
          options={
            rooms.data?.map((room) => ({
              value: room.room_id,
              label: room.room_name,
            })) || []
          }
          onChange={(value) => {
            setRoom(value);
            setDevice("");
            setRetry(undefined);
            setHistoryPage(1);
          }}
        />
        <Choice
          label="Control Node"
          value={id}
          disabled={blocked}
          options={controls.map((device) => ({
            value: device.device_id,
            label: `${device.device_name || device.device_code} · ${device.lifecycle_status}`,
          }))}
          onChange={(value) => {
            setDevice(value);
            setRetry(undefined);
            setHistoryPage(1);
          }}
        />
        {canControl && (
          <button
            className="secondary"
            disabled={!canChangeMode || blocked}
            onClick={() => setModeEditor(true)}
          >
            Chế độ {device?.control_mode || "AUTO/MANUAL"}
          </button>
        )}
        <button
          className="secondary"
          disabled={!id || blocked}
          onClick={() => {
            void shadow.refetch();
            void history.refetch();
          }}
        >
          Cập nhật trạng thái
        </button>
      </Filters>
      {rooms.error && <ErrorBox error={rooms.error} />}
      {devices.error && <ErrorBox error={devices.error} />}
      {shadow.error && <ErrorBox error={shadow.error} />}
      {error && <ErrorBox error={error} />}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {retry && (
        <button
          className="secondary"
          disabled={
            blocked ||
            retry.device !== id ||
            performance.now() >= retry.retryUntil ||
            !ready
          }
          onClick={() => void send(retry)}
        >
          Gửi lại cùng yêu cầu
        </button>
      )}
      {!ready && (
        <p className="muted">
          {blockReason} Bạn vẫn có thể xem trạng thái và lịch sử lệnh.
        </p>
      )}
      <div className="control-grid">
        {(["light", "fan"] as const).map((actuator) => {
          const state = shadow.data?.reported_state?.[actuator] || "UNKNOWN";
          return (
            <ActuatorStatus
              key={actuator}
              type={actuator}
              state={state}
              online={
                device?.connection_status === "ONLINE" &&
                !["REVOKED", "DECOMMISSIONED"].includes(device.lifecycle_status)
              }
              available={Boolean(device)}
            >
              <p className="muted small">
                Yêu cầu gần nhất:{" "}
                {actuatorStateName(shadow.data?.desired_state?.[actuator])}
                <span className="block">
                  Cập nhật: {dateText(shadow.data?.last_reported_at)}
                </span>
              </p>
              {canControl && (
                <button
                  className="primary"
                  disabled={
                    blocked ||
                    !ready ||
                    shadow.isFetching ||
                    state === "UNKNOWN"
                  }
                  onClick={() =>
                    void send({
                      device: id,
                      key: crypto.randomUUID(),
                      retryUntil: performance.now() + SAFE_RETRY_MS,
                      desired_state: {
                        [actuator]: state === "ON" ? "OFF" : "ON",
                      },
                    })
                  }
                >
                  {state === "ON" ? "Tắt" : "Bật"}
                </button>
              )}
            </ActuatorStatus>
          );
        })}
      </div>
      <h3>Lịch sử lệnh</h3>
      <Paged
        query={history}
        change={setHistoryPage}
        rowKey={(row) => row.command_id}
        columns={[
          { label: "Mã lệnh", render: (row) => row.command_id },
          { label: "Yêu cầu", render: commandText },
          { label: "Nguồn", render: (row) => row.source },
          {
            label: "Trạng thái",
            render: (row) => <StatusBadge status={row.status} />,
          },
          {
            label: "Gửi / xác nhận",
            render: (row) => (
              <>
                {dateText(row.created_at)}
                <small className="block muted">{dateText(row.acked_at)}</small>
              </>
            ),
          },
          { label: "Lỗi", render: (row) => row.error_code || "—" },
        ]}
      />
      {canControl && modeEditor && (
        <Editor
          title="Đổi chế độ điều khiển"
          fields={[
            {
              name: "control_mode",
              label: "Chế độ",
              type: "select",
              required: true,
              options: [
                { value: "AUTO", label: "Tự động theo rule" },
                { value: "MANUAL", label: "Chỉ điều khiển thủ công" },
              ],
            },
            {
              name: "reason",
              label: "Lý do",
              required: true,
              minLength: 3,
              maxLength: 255,
            },
          ]}
          initial={{ control_mode: device?.control_mode || "MANUAL" }}
          close={() => setModeEditor(false)}
          save={(values) => write("PUT", `/devices/${id}/control-mode`, values)}
        />
      )}
    </>
  );
}
