import { useCallback, useEffect, useId } from 'react';
import { useQuery } from '@tanstack/react-query';

export function useResource<T>(load: () => Promise<T>, dependencies: readonly unknown[] = [], enabled = true) {
  const id = useId();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['resource', id, ...dependencies], queryFn: load, enabled, retry: false, refetchOnWindowFocus: false });
  const reload = useCallback(() => { void refetch(); }, [refetch]);
  useEffect(() => {
    const onEvent = (event: Event) => {
      const type = (event as CustomEvent<{ type?: string }>).detail?.type;
      if (enabled && type && ['authenticated', 'telemetry.stored', 'device.status_changed', 'device.lifecycle_changed', 'command.updated', 'actuator.state_changed', 'alert.created', 'alert.updated', 'anomaly.detected', 'config.updated', 'device.mode_changed'].includes(type)) reload();
    };
    window.addEventListener('iot:event', onEvent);
    return () => window.removeEventListener('iot:event', onEvent);
  }, [reload, enabled]);
  return { data, loading: isLoading, error: isError, reload };
}
