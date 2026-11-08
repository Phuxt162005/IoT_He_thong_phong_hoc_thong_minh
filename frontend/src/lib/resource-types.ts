export type Params = Record<
  string,
  string | number | boolean | undefined | null
>;
export type Page<T> = {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  from?: string;
  to?: string;
};
export type RoomRecord = {
  room_id: string;
  room_code: string;
  room_name: string;
  status: "ACTIVE" | "INACTIVE";
  devices?: DeviceRecord[];
};
export type Member = {
  user_id: string;
  username: string;
  display_name: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  status: "ACTIVE" | "DISABLED";
};
export type DeviceRecord = {
  device_id: string;
  device_code: string;
  device_name: string;
  device_type: "SENSOR_NODE" | "CONTROL_NODE";
  room_id: string | null;
  room_code?: string;
  room_status?: "ACTIVE" | "INACTIVE";
  lifecycle_status: string;
  connection_status: string;
  broker_sync_status: string;
  firmware_version?: string;
  hardware_version?: string;
  last_seen?: string;
  last_heartbeat_at?: string;
  last_rssi_dbm?: number;
  last_free_heap_bytes?: number;
  last_uptime_seconds?: string;
  control_mode?: "AUTO" | "MANUAL";
  actuators?: unknown[];
};
export type TelemetryRecord = {
  data_id: string;
  device_id: string;
  room_id: string;
  recorded_at: string;
  received_at: string;
  temperature: number;
  humidity: number;
  lux: number;
  occupancy: boolean | null;
  stale?: boolean;
  fresh_until?: string;
  clock_skew?: boolean;
  is_backfill?: boolean;
};
export type AlertRecord = {
  alert_id: string;
  room_id: string;
  device_id: string;
  alert_type: string;
  severity: string;
  status: string;
  value?: number | null;
  message?: string;
  occurrence_count: number;
  created_at: string;
  resolution_note?: string;
};
export type States = {
  light: "ON" | "OFF" | "UNKNOWN";
  fan: "ON" | "OFF" | "UNKNOWN";
};
export type CommandRecord = {
  command_id: string;
  device_id: string;
  desired_state: Partial<States>;
  status: string;
  source: string;
  created_at: string;
  timeout_at: string;
  acked_at?: string;
  error_code?: string;
};
export type ShadowRecord = {
  device_id: string;
  desired_state: States;
  reported_state: States;
  shadow_version: number;
  reported_version: number;
  in_sync: boolean;
  differences?: unknown;
  last_reported_at?: string;
  latest_command?: CommandRecord;
  last_command_error?: string;
};
export type RuleRecord = {
  rule_id: string;
  room_id: string;
  name: string;
  target_device_id: string;
  actuator: string;
  action: string;
  condition: unknown;
  hold_seconds: number;
  cooldown_seconds: number;
  priority: number;
  is_enabled: boolean;
};
export type Threshold = {
  sensor_type: string;
  severity: string;
  operator: string;
  threshold_value: number;
  clear_value: number;
  is_enabled: boolean;
};
export type AuditRecord = {
  log_id: string;
  actor_type: string;
  actor_id?: string;
  action: string;
  target_type: string;
  target_id?: string;
  result: string;
  request_id?: string;
  created_at: string;
  details: unknown;
};
export type Finding = {
  metric: string;
  value: number;
  anomaly: boolean;
  status: string;
  median?: number;
  mad?: number;
  score?: number | null;
  reason?: string;
  baselineSamples?: number;
};
export type AnomalyRecord = {
  result_id: string;
  device_id: string;
  device_code: string;
  room_id: string;
  room_name: string;
  anomaly_detected: boolean;
  analyzed_at: string;
  recorded_at: string;
  findings: Finding[];
  temperature?: number;
  humidity?: number;
  lux?: number;
};
export type FirmwareRecord = {
  firmware_id: string;
  version: string;
  device_type: string;
  hardware_target: string;
  file_name: string;
  file_size: number;
  sha256: string;
  release_notes?: string;
  status: string;
  created_at: string;
  signature?: string;
};
export type JobRecord = {
  job_id: string;
  device_id: string;
  firmware_id: string;
  status: string;
  progress: number;
  error_code?: string;
  previous_firmware_version?: string;
  created_at: string;
  updated_at?: string;
};
export type ConfigHistory = {
  config_id: string;
  version: number;
  settings: Record<string, number>;
  status: string;
  created_at: string;
  error_code?: string;
};
export type ConfigData = {
  limits?: {
    sample_interval_seconds: { min: number; max: number };
    heartbeat_interval_seconds: { min: number; max: number };
  };
  state: {
    desired_version: number;
    applied_version: number;
    desired_settings: Record<string, number>;
    applied_settings: Record<string, number>;
    last_error_code?: string;
  } | null;
  history: ConfigHistory[];
};
export type CredentialResult = {
  operation: { status: string; operation_id: string };
  credentials?: {
    username: string;
    client_id: string;
    password: string;
    mqtt_url: string;
    room_code: string;
  };
};
