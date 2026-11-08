import type { ReactNode } from "react";
import { Fan, Lightbulb } from "lucide-react";
import "./actuator-status.css";

export function actuatorStateName(state?: string) {
  return state === "ON" ? "Bật" : state === "OFF" ? "Tắt" : "Chưa xác định";
}

export function ActuatorStatus({
  type,
  state = "UNKNOWN",
  online = false,
  available = true,
  children,
}: {
  type: "light" | "fan";
  state?: string;
  online?: boolean;
  available?: boolean;
  children?: ReactNode;
}) {
  const known = state === "ON" || state === "OFF";
  const live = online && available;
  const title = type === "light" ? "Đèn" : "Quạt";
  const Icon = type === "light" ? Lightbulb : Fan;
  const label =
    !available || !known
      ? "Chưa xác định"
      : live
        ? state === "ON"
          ? "Đang bật"
          : "Đã tắt"
        : state === "ON"
          ? "Bật lần cuối"
          : "Tắt lần cuối";
  const hint = !available
    ? "Chưa có bộ điều khiển"
    : !online
      ? "Thiết bị đang ngoại tuyến"
      : !known
        ? "Chờ thiết bị gửi trạng thái"
        : "Đã nhận phản hồi từ thiết bị";
  return (
    <article
      className={`actuator-tile ${live && known ? (state === "ON" ? "is-on" : "is-off") : "is-unknown"} ${children ? "actuator-panel" : ""}`}
      data-actuator={type}
      data-state={state}
      aria-label={`${title}: ${label}`}
    >
      <div className="actuator-heading">
        <span className="actuator-icon">
          <Icon size={22} strokeWidth={1.8} />
        </span>
        <div>
          <h4>{title}</h4>
          <span className="actuator-kind">
            {type === "light" ? "Chiếu sáng" : "Thông gió"}
          </span>
        </div>
      </div>
      <span className="actuator-state">
        <span aria-hidden="true" />
        {label}
      </span>
      <p className="actuator-hint">{hint}</p>
      {children && <div className="actuator-actions">{children}</div>}
    </article>
  );
}
