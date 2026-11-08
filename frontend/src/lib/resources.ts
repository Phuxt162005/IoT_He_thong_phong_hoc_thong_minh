import axios from "axios";
import api from "./api";
import { mockResource } from "./mockResources";
import type { Page, Params } from "./resource-types";
export type Envelope<T> = {
  success: boolean;
  data: T;
  meta?: Omit<Page<never>, "items">;
};
export const isMock = import.meta.env.VITE_USE_MOCK === "true";
export function cleanParams(params: Params = {}): Params {
  return Object.fromEntries(
    Object.entries(params)
      .filter(
        ([, value]) =>
          value !== undefined &&
          value !== null &&
          !(typeof value === "string" && !value.trim()),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.trim() : value,
      ]),
  );
}
export async function envelope<T>(
  path: string,
  params: Params = {},
  signal?: AbortSignal,
): Promise<Envelope<T>> {
  const query = cleanParams(params);
  return isMock
    ? (mockResource("GET", path, undefined, query) as Promise<Envelope<T>>)
    : (await api.get<Envelope<T>>(path, { params: query, signal })).data;
}
export async function read<T>(
  path: string,
  params: Params = {},
  signal?: AbortSignal,
): Promise<T> {
  return (await envelope<T>(path, params, signal)).data;
}
export async function page<T>(
  path: string,
  params: Params = {},
  signal?: AbortSignal,
): Promise<Page<T>> {
  const result = await envelope<T[]>(
    path,
    { page: 1, page_size: 20, ...params },
    signal,
  );
  return {
    items: result.data,
    page: result.meta?.page ?? Number(params.page || 1),
    page_size: result.meta?.page_size ?? Number(params.page_size || 20),
    total: result.meta?.total ?? result.data.length,
    from: result.meta?.from,
    to: result.meta?.to,
  };
}
export async function all<T>(
  path: string,
  params: Params = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  let current = 1;
  while (true) {
    const result = await page<T>(
      path,
      { ...params, page: current++, page_size: 100 },
      signal,
    );
    items.push(...result.items);
    if (items.length >= result.total || !result.items.length) return items;
  }
}
export async function write<T = unknown>(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  if (isMock)
    return (await mockResource(method, path, body, {}, headers)).data as T;
  return (
    await api.request<Envelope<T>>({ method, url: path, data: body, headers })
  ).data.data;
}
export async function upload(file: File, metadata: Record<string, string>) {
  if (isMock)
    return write("POST", "/ota/firmware", {
      ...metadata,
      file_name: file.name,
      file_size: file.size,
    });
  return (
    await api.post("/ota/firmware", file, {
      headers: {
        "Content-Type": "application/octet-stream",
        "x-firmware-version": encodeURIComponent(metadata.version),
        "x-device-type": metadata.device_type,
        "x-hardware-target": encodeURIComponent(metadata.hardware_target),
        "x-metadata-encoding": "percent-utf8",
        "x-firmware-file-name": encodeURIComponent(file.name),
        "x-release-notes": metadata.release_notes
          ? encodeURIComponent(metadata.release_notes)
          : undefined,
      },
      timeout: 60000,
    })
  ).data.data;
}
export async function exportTelemetry(room: string, params: Params) {
  if (isMock) {
    const rows = await all<Record<string, unknown>>(
      `/rooms/${room}/telemetry`,
      params,
    );
    return new Blob(
      [
        "recorded_at,temperature,humidity,lux,occupancy\r\n" +
          rows
            .map((row) =>
              [
                row.recorded_at,
                row.temperature,
                row.humidity,
                row.lux,
                row.occupancy,
              ].join(","),
            )
            .join("\r\n"),
      ],
      { type: "text/csv" },
    );
  }
  try {
    return (
      await api.get<Blob>(`/rooms/${room}/telemetry/export`, {
        params: cleanParams(params),
        responseType: "blob",
      })
    ).data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
      const body = await error.response.data.text();
      try {
        const payload = JSON.parse(body);
        throw new Error(payload.error?.message || "Không thể xuất CSV.");
      } catch (parsed) {
        if (parsed instanceof SyntaxError) throw error;
        throw parsed;
      }
    }
    throw error;
  }
}
export function commandText(command: {
  desired_state: Record<string, string | undefined>;
}) {
  return Object.entries(command.desired_state || {})
    .map(([name, state]) => `${name === "light" ? "Đèn" : "Quạt"}: ${state}`)
    .join(" · ");
}
export function dateText(value?: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("vi-VN")
    : "—";
}
export function timeRange(from: string, to: string, maxDays: number) {
  const start = new Date(from),
    end = new Date(to);
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    start >= end ||
    +end - +start > maxDays * 86400000
  )
    throw new Error(`Chọn khoảng thời gian hợp lệ, tối đa ${maxDays} ngày.`);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function localInput(date: Date) {
  return new Date(+date - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}
