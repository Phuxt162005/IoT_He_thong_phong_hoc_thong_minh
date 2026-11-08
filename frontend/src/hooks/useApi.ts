import { useQuery } from "@tanstack/react-query";
import { all, cleanParams, page, read } from "../lib/resources";
import type { DeviceRecord, Params, RoomRecord } from "../lib/resource-types";
export function useApi<T>(
  key: string,
  path: string,
  params: Params = {},
  enabled = true,
) {
  return useQuery({
    queryKey: [key, path, cleanParams(params)],
    queryFn: ({ signal }) => read<T>(path, params, signal),
    enabled,
    staleTime: 30000,
    retry: false,
  });
}
export function usePage<T>(
  key: string,
  path: string,
  params: Params = {},
  enabled = true,
) {
  return useQuery({
    queryKey: [key, path, cleanParams(params)],
    queryFn: ({ signal }) => page<T>(path, params, signal),
    enabled,
    staleTime: 30000,
    retry: false,
  });
}
export function useRooms() {
  return useQuery({
    queryKey: ["rooms", "options"],
    queryFn: ({ signal }) => all<RoomRecord>("/rooms", {}, signal),
    staleTime: 60000,
    retry: false,
  });
}
export function useDevices(room?: string) {
  return useQuery({
    queryKey: ["devices", "options", room || ""],
    queryFn: ({ signal }) =>
      all<DeviceRecord>("/devices", { room_id: room }, signal),
    staleTime: 60000,
    retry: false,
  });
}
