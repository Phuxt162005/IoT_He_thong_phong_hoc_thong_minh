import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth";
import { all, dateText, page, upload, write } from "../lib/resources";
import type { FirmwareRecord, JobRecord, Params } from "../lib/resource-types";
import { useDevices, usePage, useRooms } from "../hooks/useApi";
import { Empty, StatusBadge } from "../components/ui";
import {
  Choice,
  Editor,
  ErrorBox,
  Filters,
  Inspect,
  Paged,
  Title,
  useFilters,
} from "../components/workspace-ui";
export function OtaPage() {
  const admin = useAuthStore((s) => s.user?.role === "ADMIN");
  const rooms = useRooms();
  const devices = useDevices();
  const filter = useFilters();
  const jobFilter = useFilters();
  const firmware = usePage<FirmwareRecord>(
    "ota",
    "/ota/firmware",
    filter.params,
  );
  const jobParams: Params = {
    ...jobFilter.params,
    ...(!admin && !jobFilter.params.device_id
      ? { room_id: jobFilter.params.room_id || rooms.data?.[0]?.room_id }
      : {}),
  };
  const jobs = useQuery({
    queryKey: ["ota-jobs", jobParams],
    enabled: admin || Boolean(jobParams.room_id || jobParams.device_id),
    queryFn: ({ signal }) => page<JobRecord>("/ota/jobs", jobParams, signal),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.items.some((row) =>
        [
          "PENDING",
          "NOTIFIED",
          "DOWNLOADING",
          "VERIFYING",
          "INSTALLING",
          "REBOOTING",
        ].includes(row.status),
      )
        ? 15000
        : false,
  });
  const [editor, setEditor] = useState<
    "upload" | "update" | { row: FirmwareRecord; action: "publish" | "revoke" }
  >();
  const [file, setFile] = useState<File>();
  const [detail, setDetail] = useState<unknown>();
  return (
    <>
      <Title
        action={
          admin && (
            <div className="user-actions">
              <button
                className="primary"
                onClick={() => {
                  setFile(undefined);
                  setEditor("upload");
                }}
              >
                Upload firmware
              </button>
              <button className="secondary" onClick={() => setEditor("update")}>
                Cập nhật thiết bị
              </button>
            </div>
          )
        }
      >
        OTA firmware
      </Title>
      <Filters>
        <Choice
          label="Loại node"
          value={String(filter.params.device_type || "")}
          options={["SENSOR_NODE", "CONTROL_NODE"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(v) => filter.filter("device_type", v)}
        />
        {admin && (
          <Choice
            label="Trạng thái firmware"
            value={String(filter.params.status || "")}
            options={["DRAFT", "PUBLISHED", "REVOKED"].map((value) => ({
              value,
              label: value,
            }))}
            onChange={(v) => filter.filter("status", v)}
          />
        )}
        <label>
          Phần cứng
          <input
            value={String(filter.params.hardware_target || "")}
            onChange={(e) => filter.filter("hardware_target", e.target.value)}
          />
        </label>
      </Filters>
      <Paged
        query={firmware}
        change={filter.go}
        rowKey={(row) => row.firmware_id}
        columns={[
          { label: "Phiên bản", render: (row) => row.version },
          {
            label: "Node / phần cứng",
            render: (row) => `${row.device_type} / ${row.hardware_target}`,
          },
          {
            label: "Tệp",
            render: (row) => `${row.file_name} (${row.file_size} byte)`,
          },
          {
            label: "Trạng thái",
            render: (row) => <StatusBadge status={row.status} />,
          },
          {
            label: "Thao tác",
            render: (row) => (
              <div className="user-actions">
                <button className="secondary" onClick={() => setDetail(row)}>
                  Chi tiết
                </button>
                {admin && row.status === "DRAFT" && (
                  <button
                    className="secondary"
                    onClick={() => setEditor({ row, action: "publish" })}
                  >
                    Phát hành
                  </button>
                )}
                {admin && row.status === "PUBLISHED" && (
                  <button
                    className="secondary"
                    onClick={() => setEditor({ row, action: "revoke" })}
                  >
                    Thu hồi
                  </button>
                )}
              </div>
            ),
          },
        ]}
      />
      <h3>Tiến trình cập nhật</h3>
      <p className="muted small">
        Các job đang chạy được kiểm tra lại mỗi 15 giây. Cập nhật chỉ thành công
        khi thiết bị báo SUCCESS; ROLLED_BACK là đã quay về firmware trước.
      </p>
      <Filters>
        <Choice
          label="Phòng"
          value={String(jobParams.room_id || "")}
          options={
            rooms.data?.map((room) => ({
              value: room.room_id,
              label: room.room_name,
            })) || []
          }
          onChange={(v) => {
            jobFilter.filter("room_id", v);
            jobFilter.filter("device_id", "");
          }}
        />
        <Choice
          label="Thiết bị"
          value={String(jobFilter.params.device_id || "")}
          options={
            devices.data
              ?.filter(
                (device) =>
                  !jobParams.room_id || device.room_id === jobParams.room_id,
              )
              .map((device) => ({
                value: device.device_id,
                label: device.device_name,
              })) || []
          }
          onChange={(v) => jobFilter.filter("device_id", v)}
        />
        <Choice
          label="Trạng thái job"
          value={String(jobFilter.params.status || "")}
          options={[
            "PENDING",
            "NOTIFIED",
            "DOWNLOADING",
            "VERIFYING",
            "INSTALLING",
            "REBOOTING",
            "SUCCESS",
            "FAILED",
            "ROLLED_BACK",
            "CANCELLED",
            "TIMEOUT",
          ].map((value) => ({ value, label: value }))}
          onChange={(v) => jobFilter.filter("status", v)}
        />
        <button
          className="secondary"
          disabled={!admin && !jobParams.room_id && !jobParams.device_id}
          onClick={() => void jobs.refetch()}
        >
          Cập nhật tiến trình
        </button>
      </Filters>
      {!admin && !jobParams.room_id && !jobParams.device_id && (
        <Empty text="Bạn chưa được gán phòng để xem lịch sử OTA." />
      )}
      <Paged
        query={jobs}
        change={jobFilter.go}
        rowKey={(row) => row.job_id}
        columns={[
          {
            label: "Thiết bị",
            render: (row) =>
              devices.data?.find((device) => device.device_id === row.device_id)
                ?.device_name || row.device_id,
          },
          {
            label: "Trạng thái",
            render: (row) => <StatusBadge status={row.status} />,
          },
          {
            label: "Tiến độ",
            render: (row) => (
              <>
                <progress max={100} value={row.progress} />
                {row.progress}%
              </>
            ),
          },
          {
            label: "Lỗi / firmware trước",
            render: (row) => (
              <>
                {row.error_code || "—"}
                <small className="block muted">
                  {row.previous_firmware_version || "—"}
                </small>
              </>
            ),
          },
          { label: "Thời gian", render: (row) => dateText(row.created_at) },
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
      {editor === "upload" && (
        <Editor
          title="Upload firmware"
          close={() => setEditor(undefined)}
          fields={[
            {
              name: "version",
              label: "Phiên bản",
              required: true,
              maxLength: 40,
            },
            {
              name: "device_type",
              label: "Loại node",
              type: "select",
              required: true,
              options: ["SENSOR_NODE", "CONTROL_NODE"].map((value) => ({
                value,
                label: value,
              })),
            },
            {
              name: "hardware_target",
              label: "Phần cứng đích",
              required: true,
              maxLength: 80,
            },
            {
              name: "release_notes",
              label: "Ghi chú phát hành",
              type: "textarea",
              maxLength: 2000,
            },
          ]}
          save={(values) => {
            if (!file || file.size === 0)
              throw new Error("Chọn tệp firmware không rỗng.");
            return upload(file, values);
          }}
        >
          <label>
            Tệp firmware (.bin)
            <input
              type="file"
              accept=".bin,application/octet-stream"
              required
              onChange={(event) => setFile(event.target.files?.[0])}
            />
          </label>
        </Editor>
      )}
      {editor === "update" && <UpdateJob close={() => setEditor(undefined)} />}
      {typeof editor === "object" && (
        <Editor
          title={`${editor.action === "publish" ? "Phát hành" : "Thu hồi"} firmware ${editor.row.version}`}
          close={() => setEditor(undefined)}
          fields={[
            {
              name: "confirmed",
              label:
                editor.action === "publish"
                  ? "Tôi xác nhận phát hành phiên bản này"
                  : "Tôi xác nhận ngừng cấp phiên bản này cho cập nhật mới",
              type: "checkbox",
              required: true,
            },
          ]}
          save={() =>
            write(
              "POST",
              `/ota/firmware/${editor.row.firmware_id}/${editor.action}`,
              {},
            )
          }
        >
          <p>
            Node: {editor.row.device_type} · phần cứng{" "}
            {editor.row.hardware_target}
          </p>
        </Editor>
      )}
      {detail && (
        <Inspect
          title="Chi tiết OTA"
          value={detail}
          close={() => setDetail(undefined)}
        />
      )}
    </>
  );
}
function UpdateJob({ close }: { close: () => void }) {
  const devices = useDevices();
  const firmware = useQuery({
    queryKey: ["ota", "published-options"],
    queryFn: async ({ signal }) => {
      return all<FirmwareRecord>(
        "/ota/firmware",
        { status: "PUBLISHED" },
        signal,
      );
    },
    retry: false,
  });
  return (
    <Editor
      title="Yêu cầu cập nhật thiết bị"
      close={close}
      fields={[
        {
          name: "device_id",
          label: "Thiết bị",
          type: "select",
          required: true,
          options:
            devices.data
              ?.filter(
                (device) =>
                  ["PROVISIONED", "ACTIVE"].includes(device.lifecycle_status) &&
                  device.connection_status === "ONLINE",
              )
              .map((device) => ({
                value: device.device_id,
                label: `${device.device_name} · ${device.device_type}`,
              })) || [],
        },
        {
          name: "firmware_id",
          label: "Firmware đã phát hành",
          type: "select",
          required: true,
          options:
            firmware.data?.map((row) => ({
              value: row.firmware_id,
              label: `${row.version} · ${row.device_type} · ${row.hardware_target}`,
            })) || [],
        },
        {
          name: "confirmed",
          label:
            "Tôi xác nhận thiết bị có thể khởi động lại trong quá trình cập nhật",
          type: "checkbox",
          required: true,
        },
      ]}
      save={(values) => {
        const device = devices.data?.find(
            (row) => row.device_id === values.device_id,
          ),
          release = firmware.data?.find(
            (row) => row.firmware_id === values.firmware_id,
          );
        if (
          !device ||
          !release ||
          device.device_type !== release.device_type ||
          device.hardware_version !== release.hardware_target
        )
          throw new Error("Firmware không đúng loại thiết bị.");
        return write("POST", `/devices/${values.device_id}/ota`, {
          firmware_id: values.firmware_id,
        });
      }}
    >
      {firmware.error && <ErrorBox error={firmware.error} />}
    </Editor>
  );
}
