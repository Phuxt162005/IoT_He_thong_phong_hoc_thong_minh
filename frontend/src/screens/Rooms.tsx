import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { all, read, write } from "../lib/resources";
import type { DeviceRecord, Member, RoomRecord } from "../lib/resource-types";
import { useApi, usePage } from "../hooks/useApi";
import { Card, Loading, StatusBadge } from "../components/ui";
import {
  Choice,
  Editor,
  ErrorBox,
  Filters,
  Paged,
  Table,
  Title,
  useAction,
  useFilters,
} from "../components/workspace-ui";
const statuses = [
  { value: "ACTIVE", label: "Hoạt động" },
  { value: "INACTIVE", label: "Ngừng sử dụng" },
];
export function RoomsPage() {
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN");
  const filter = useFilters();
  const query = usePage<RoomRecord>("rooms", "/rooms", filter.params);
  const action = useAction();
  const [editor, setEditor] = useState<ReactNode>();
  const edit = (room?: RoomRecord) =>
    setEditor(
      <Editor
        title={room ? "Sửa phòng học" : "Thêm phòng học"}
        initial={room ? { room_name: room.room_name, status: room.status } : {}}
        fields={[
          ...(!room
            ? [
                {
                  name: "room_code",
                  label: "Mã phòng",
                  required: true,
                  pattern: "[A-Za-z0-9_-]{1,40}",
                  maxLength: 40,
                },
              ]
            : []),
          {
            name: "room_name",
            label: "Tên phòng",
            required: true,
            maxLength: 100,
          },
          ...(room
            ? [
                {
                  name: "status",
                  label: "Trạng thái",
                  type: "select" as const,
                  options: statuses,
                  required: true,
                },
              ]
            : []),
        ]}
        close={() => setEditor(null)}
        save={(values) =>
          write(
            room ? "PATCH" : "POST",
            room ? `/rooms/${room.room_id}` : "/rooms",
            values,
          )
        }
      />,
    );
  const members = (room: RoomRecord) =>
    action.run(async () => {
      const [people, members] = await Promise.all([
        all<Member>("/users"),
        read<Member[]>(`/rooms/${room.room_id}/users`),
      ]);
      const allowed = people.filter(
        (user) => user.role !== "ADMIN" && user.status === "ACTIVE",
      );
      setEditor(
        <Editor
          title={`Thành viên · ${room.room_name}`}
          initial={{
            user_ids: members
              .filter((user) =>
                allowed.some((item) => item.user_id === user.user_id),
              )
              .map((user) => user.user_id)
              .join(","),
          }}
          fields={[
            {
              name: "user_ids",
              label: "Operator/Viewer được truy cập phòng",
              type: "multiselect",
              options: allowed.map((user) => ({
                value: user.user_id,
                label: `${user.display_name} (${user.username} · ${user.role})`,
              })),
              hint: "Giữ Ctrl để chọn nhiều tài khoản. Bỏ chọn để thu hồi quyền. Người thay đổi phạm vi phải đăng nhập lại.",
            },
          ]}
          close={() => setEditor(null)}
          save={(values) =>
            write("PUT", `/rooms/${room.room_id}/users`, {
              user_ids: values.user_ids ? values.user_ids.split(",") : [],
            })
          }
        />,
      );
    }, "");
  return (
    <>
      <Title
        action={
          isAdmin && (
            <button className="primary" onClick={() => edit()}>
              + Thêm phòng
            </button>
          )
        }
      >
        Phòng học
      </Title>
      <Filters>
        <Choice
          label="Trạng thái"
          value={String(filter.params.status || "")}
          options={statuses}
          onChange={(value) => filter.filter("status", value)}
        />
      </Filters>
      {action.error && <ErrorBox error={action.error} />}
      <Paged
        query={query}
        change={filter.go}
        rowKey={(room) => room.room_id}
        columns={[
          {
            label: "Mã phòng",
            render: (room) => (
              <Link to={`/rooms/${room.room_id}`}>{room.room_code}</Link>
            ),
          },
          { label: "Tên phòng", render: (room) => room.room_name },
          {
            label: "Trạng thái",
            render: (room) => <StatusBadge status={room.status} />,
          },
          {
            label: "Thao tác",
            render: (room) =>
              isAdmin ? (
                <div className="user-actions">
                  <button className="secondary" onClick={() => edit(room)}>
                    Sửa
                  </button>
                  <button
                    className="secondary"
                    disabled={action.busy}
                    onClick={() => void members(room)}
                  >
                    Gán thành viên
                  </button>
                </div>
              ) : (
                <Link to={`/rooms/${room.room_id}`}>Chi tiết</Link>
              ),
          },
        ]}
      />
      {editor}
    </>
  );
}
export function RoomDetailPage() {
  const { id = "" } = useParams();
  const query = useApi<RoomRecord>("rooms", `/rooms/${id}`);
  return query.isLoading ? (
    <Loading />
  ) : query.error ? (
    <ErrorBox error={query.error} retry={() => void query.refetch()} />
  ) : query.data ? (
    <>
      <Title action={<Link to="/rooms">← Danh sách phòng</Link>}>
        {query.data.room_name}
      </Title>
      <Card>
        <p>
          Mã phòng: <strong>{query.data.room_code}</strong>
        </p>
        <StatusBadge status={query.data.status} />
        <p>{query.data.devices?.length || 0} thiết bị</p>
      </Card>
      <Card>
        <h3>Thiết bị trong phòng</h3>
        <Table
          items={query.data.devices || []}
          rowKey={(device) => device.device_id}
          columns={[
            {
              label: "Thiết bị",
              render: (device) => (
                <Link to={`/devices/${device.device_id}`}>
                  {device.device_name || device.device_code}
                </Link>
              ),
            },
            { label: "Loại", render: (device) => device.device_type },
            {
              label: "Vòng đời",
              render: (device) => (
                <StatusBadge status={device.lifecycle_status} />
              ),
            },
            {
              label: "Kết nối",
              render: (device) => (
                <StatusBadge status={device.connection_status} />
              ),
            } as import("../components/workspace-ui").Column<DeviceRecord>,
          ]}
        />
      </Card>
    </>
  ) : null;
}
