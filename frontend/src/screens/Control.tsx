import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { commandText, dateText, page, write } from "../lib/resources";
import type { CommandRecord, ShadowRecord } from "../lib/resource-types";
import { useApi, useDevices, usePage, useRooms } from "../hooks/useApi";
import { Card, StatusBadge } from "../components/ui";
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
  desired_state: { light?: "ON" | "OFF"; fan?: "ON" | "OFF" };
};
export function ControlPage() {
  const canControl = useAuthStore((state) => state.user?.role !== "VIEWER");
  const queries = useQueryClient();
  const rooms = useRooms();
  const [selectedRoom, setRoom] = useState("");
  const room =
    rooms.data?.find((item) => item.room_id === selectedRoom)?.room_id ||
    rooms.data?.[0]?.room_id ||
    "";
  const devices = useDevices(room || undefined);
  const controls =
    devices.data?.filter(
      (device) =>
        device.room_id === room &&
        device.device_type === "CONTROL_NODE" &&
        !["REVOKED", "DECOMMISSIONED"].includes(device.lifecycle_status),
    ) || [];
  const [selection, setDevice] = useState("");
  const device =
    controls.find((item) => item.device_id === selection) || controls[0];
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
          payload: { command_id?: string; device_id?: string; status?: string };
        }>
      ).detail;
      if (
        data.type === "command.updated" &&
        data.payload.command_id === pendingRef.current?.command_id &&
        data.payload.status &&
        data.payload.status !== "PENDING"
      )
        finish({ ...pendingRef.current!, status: data.payload.status });
    };
    window.addEventListener("iot:event", listener);
    return () => window.removeEventListener("iot:event", listener);
  }, [queries]);
  async function send(submission: Submission) {
    if (!canControl || busyRef.current || pendingRef.current) return;
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
  const ready =
    device?.lifecycle_status === "ACTIVE" &&
    device.connection_status === "ONLINE";
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
            label: device.device_name || device.device_code,
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
            disabled={!id || blocked}
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
          disabled={blocked || retry.device !== id}
          onClick={() => void send(retry)}
        >
          Gửi lại cùng yêu cầu
        </button>
      )}
      {!ready && (
        <p className="muted">
          Chỉ điều khiển thiết bị ACTIVE và ONLINE. Chọn thiết bị có trạng thái
          báo về rõ ràng.
        </p>
      )}
      <div className="control-grid">
        {(["light", "fan"] as const).map((actuator) => {
          const state = shadow.data?.reported_state?.[actuator] || "UNKNOWN";
          return (
            <Card key={actuator}>
              <h3>{actuator === "light" ? "Đèn" : "Quạt"}</h3>
              <StatusBadge status={state} />
              <p className="muted small">
                Mong muốn: {shadow.data?.desired_state?.[actuator] || "UNKNOWN"}{" "}
                · báo về {dateText(shadow.data?.last_reported_at)}
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
                      desired_state: {
                        [actuator]: state === "ON" ? "OFF" : "ON",
                      },
                    })
                  }
                >
                  {state === "ON" ? "Tắt" : "Bật"}
                </button>
              )}
            </Card>
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
