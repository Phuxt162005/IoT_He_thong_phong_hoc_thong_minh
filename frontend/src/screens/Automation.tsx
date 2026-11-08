import { useState } from "react";
import { useAuthStore } from "../store/auth";
import { write } from "../lib/resources";
import type { RuleRecord } from "../lib/resource-types";
import { useDevices, usePage, useRooms } from "../hooks/useApi";
import { Empty, StatusBadge } from "../components/ui";
import {
  Choice,
  Editor,
  ErrorBox,
  Filters,
  Paged,
  Title,
  useAction,
} from "../components/workspace-ui";
type Condition =
  | { metric: string; operator: string; value: number | boolean }
  | { all: Condition[] }
  | { any: Condition[] };
const leaf: Condition = { metric: "temperature", operator: "GT", value: 30 };
function conditionText(value: Condition): string {
  if ("all" in value)
    return "(" + value.all.map(conditionText).join(" VÀ ") + ")";
  if ("any" in value)
    return "(" + value.any.map(conditionText).join(" HOẶC ") + ")";
  return `${({ temperature: "Nhiệt độ", humidity: "Độ ẩm", lux: "Ánh sáng", occupancy: "Hiện diện" } as Record<string, string>)[value.metric] || value.metric} ${({ GT: ">", GTE: "≥", LT: "<", LTE: "≤", EQ: "=", NE: "≠" } as Record<string, string>)[value.operator] || value.operator} ${typeof value.value === "boolean" ? (value.value ? "Có người" : "Không có người") : value.value}`;
}
function count(condition: Condition): number {
  return "all" in condition
    ? 1 + condition.all.reduce((n, item) => n + count(item), 0)
    : "any" in condition
      ? 1 + condition.any.reduce((n, item) => n + count(item), 0)
      : 1;
}
function ConditionBuilder({
  value,
  change,
  depth = 0,
  total,
}: {
  value: Condition;
  change: (value: Condition) => void;
  depth?: number;
  total: number;
}) {
  const group = "all" in value ? "all" : "any" in value ? "any" : "";
  const children = "all" in value ? value.all : "any" in value ? value.any : [];
  return (
    <fieldset className="condition-builder">
      <legend>Điều kiện</legend>
      <select
        aria-label="Kiểu điều kiện"
        value={group || "leaf"}
        onChange={(event) =>
          change(
            event.target.value === "leaf"
              ? { ...leaf }
              : event.target.value === "all"
                ? { all: [{ ...leaf }] }
                : { any: [{ ...leaf }] },
          )
        }
      >
        <option value="leaf">So sánh chỉ số</option>
        {depth < 4 && (
          <>
            <option value="all">Tất cả điều kiện (AND)</option>
            <option value="any">Ít nhất một điều kiện (OR)</option>
          </>
        )}
      </select>
      {group ? (
        <>
          {children.map((child, index) => (
            <div key={index}>
              <ConditionBuilder
                value={child}
                depth={depth + 1}
                total={total}
                change={(next) =>
                  change(
                    group === "all"
                      ? {
                          all: children.map((item, i) =>
                            i === index ? next : item,
                          ),
                        }
                      : {
                          any: children.map((item, i) =>
                            i === index ? next : item,
                          ),
                        },
                  )
                }
              />
              <button
                type="button"
                className="secondary"
                disabled={children.length === 1}
                onClick={() =>
                  change(
                    group === "all"
                      ? { all: children.filter((_, i) => i !== index) }
                      : { any: children.filter((_, i) => i !== index) },
                  )
                }
              >
                Bỏ điều kiện
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={total >= 20 || children.length >= 10}
            onClick={() =>
              change(
                group === "all"
                  ? { all: [...children, { ...leaf }] }
                  : { any: [...children, { ...leaf }] },
              )
            }
          >
            + Điều kiện
          </button>
        </>
      ) : "metric" in value ? (
        <div className="filters">
          <label>
            Chỉ số
            <select
              value={value.metric}
              onChange={(e) =>
                change({
                  metric: e.target.value,
                  operator: e.target.value === "occupancy" ? "EQ" : "GT",
                  value: e.target.value === "occupancy" ? true : 30,
                })
              }
            >
              {[
                ["temperature", "Nhiệt độ"],
                ["humidity", "Độ ẩm"],
                ["lux", "Ánh sáng"],
                ["occupancy", "Hiện diện"],
              ].map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            So sánh
            <select
              value={value.operator}
              onChange={(e) => change({ ...value, operator: e.target.value })}
            >
              {(value.metric === "occupancy"
                ? ["EQ", "NE"]
                : ["GT", "GTE", "LT", "LTE", "EQ", "NE"]
              ).map((op) => (
                <option key={op} value={op}>
                  {
                    (
                      {
                        GT: ">",
                        GTE: "≥",
                        LT: "<",
                        LTE: "≤",
                        EQ: "=",
                        NE: "≠",
                      } as Record<string, string>
                    )[op]
                  }
                </option>
              ))}
            </select>
          </label>
          {value.metric === "occupancy" ? (
            <label>
              Hiện diện
              <select
                value={String(value.value)}
                onChange={(e) =>
                  change({ ...value, value: e.target.value === "true" })
                }
              >
                <option value="true">Có người</option>
                <option value="false">Không có người</option>
              </select>
            </label>
          ) : (
            <label>
              Giá trị
              <input
                type="number"
                required
                step="any"
                min={value.metric === "temperature" ? -10 : 0}
                max={
                  value.metric === "temperature"
                    ? 60
                    : value.metric === "humidity"
                      ? 100
                      : 65535
                }
                value={Number(value.value)}
                onChange={(e) =>
                  change({ ...value, value: Number(e.target.value) })
                }
              />
            </label>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
function RuleEditor({
  room,
  rule,
  close,
}: {
  room: string;
  rule?: RuleRecord;
  close: () => void;
}) {
  const devices = useDevices(room);
  const [condition, setCondition] = useState<Condition>(
    (rule?.condition as Condition) || { ...leaf },
  );
  return (
    <Editor
      title={rule ? "Sửa quy tắc" : "Tạo quy tắc"}
      fields={[
        { name: "name", label: "Tên quy tắc", required: true, maxLength: 100 },
        {
          name: "target_device_id",
          label: "Control Node",
          type: "select",
          required: true,
          options:
            devices.data
              ?.filter((device) => device.device_type === "CONTROL_NODE")
              .map((device) => ({
                value: device.device_id,
                label: device.device_name,
              })) || [],
        },
        {
          name: "actuator",
          label: "Thiết bị chấp hành",
          type: "select",
          required: true,
          options: [
            { value: "LIGHT", label: "Đèn" },
            { value: "FAN", label: "Quạt" },
          ],
        },
        {
          name: "action",
          label: "Hành động",
          type: "select",
          required: true,
          options: [
            { value: "ON", label: "Bật" },
            { value: "OFF", label: "Tắt" },
          ],
        },
        {
          name: "hold_seconds",
          label: "Duy trì điều kiện (giây)",
          type: "number",
          required: true,
          min: 0,
          max: 300,
        },
        {
          name: "cooldown_seconds",
          label: "Thời gian nghỉ giữa hai lần (giây)",
          type: "number",
          required: true,
          min: 1,
          max: 3600,
        },
        {
          name: "priority",
          label: "Ưu tiên (số nhỏ ưu tiên cao)",
          type: "number",
          required: true,
          min: 1,
          max: 1000,
        },
        { name: "is_enabled", label: "Bật quy tắc", type: "checkbox" },
      ]}
      initial={
        rule
          ? Object.fromEntries(
              Object.entries(rule).map(([key, value]) => [key, String(value)]),
            )
          : {
              actuator: "LIGHT",
              action: "ON",
              hold_seconds: "0",
              cooldown_seconds: "60",
              priority: "100",
              is_enabled: "true",
            }
      }
      close={close}
      save={(values) => {
        if (count(condition) > 20) throw new Error("Tối đa 20 nút điều kiện.");
        return write(
          rule ? "PATCH" : "POST",
          rule
            ? `/automation-rules/${rule.rule_id}`
            : `/rooms/${room}/automation-rules`,
          {
            name: values.name,
            target_device_id: values.target_device_id,
            actuator: values.actuator,
            action: values.action,
            hold_seconds: Number(values.hold_seconds),
            cooldown_seconds: Number(values.cooldown_seconds),
            priority: Number(values.priority),
            is_enabled: values.is_enabled === "true",
            condition,
          },
        );
      }}
    >
      <ConditionBuilder
        value={condition}
        change={setCondition}
        total={count(condition)}
      />
      {devices.error && <ErrorBox error={devices.error} />}
    </Editor>
  );
}
export function AutomationPage() {
  const admin = useAuthStore((s) => s.user?.role === "ADMIN");
  const rooms = useRooms();
  const [room, setRoom] = useState("");
  const [page, setPage] = useState(1);
  const query = usePage<RuleRecord>(
    "rules",
    `/rooms/${room}/automation-rules`,
    { page, page_size: 20 },
    Boolean(room),
  );
  const [editor, setEditor] = useState<RuleRecord | "new">();
  const action = useAction();
  return (
    <>
      <Title
        action={
          admin && (
            <button
              className="primary"
              disabled={!room}
              onClick={() => setEditor("new")}
            >
              + Tạo quy tắc
            </button>
          )
        }
      >
        Tự động hóa
      </Title>
      <Filters>
        <Choice
          label="Phòng"
          value={room}
          empty="Chọn phòng"
          options={
            rooms.data?.map((room) => ({
              value: room.room_id,
              label: room.room_name,
            })) || []
          }
          onChange={(value) => {
            setRoom(value);
            setPage(1);
          }}
        />
      </Filters>
      {action.error && <ErrorBox error={action.error} />}
      {!room ? (
        <Empty text="Chọn phòng để xem quy tắc." />
      ) : (
        <Paged
          query={query}
          change={setPage}
          rowKey={(rule) => rule.rule_id}
          columns={[
            { label: "Tên", render: (rule) => rule.name },
            {
              label: "Điều kiện",
              render: (rule) => (
                <span className="condition-summary">
                  {conditionText(rule.condition as Condition)}
                </span>
              ),
            },
            {
              label: "Hành động",
              render: (rule) => `${rule.actuator} → ${rule.action}`,
            },
            {
              label: "Ưu tiên / nghỉ",
              render: (rule) => `${rule.priority} / ${rule.cooldown_seconds}s`,
            },
            {
              label: "Trạng thái",
              render: (rule) => (
                <StatusBadge status={rule.is_enabled ? "ACTIVE" : "DISABLED"} />
              ),
            },
            {
              label: "Thao tác",
              render: (rule) =>
                admin && (
                  <div className="user-actions">
                    <button
                      className="secondary"
                      onClick={() => setEditor(rule)}
                    >
                      Sửa
                    </button>
                    <button
                      className="secondary"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(
                          () =>
                            write(
                              "PATCH",
                              `/automation-rules/${rule.rule_id}`,
                              {
                                is_enabled: !rule.is_enabled,
                              },
                            ),
                          "Đã cập nhật quy tắc.",
                          true,
                        )
                      }
                    >
                      {rule.is_enabled ? "Tắt" : "Bật"}
                    </button>
                  </div>
                ),
            },
          ]}
        />
      )}
      {editor && (
        <RuleEditor
          room={room}
          rule={editor === "new" ? undefined : editor}
          close={() => setEditor(undefined)}
        />
      )}
    </>
  );
}
