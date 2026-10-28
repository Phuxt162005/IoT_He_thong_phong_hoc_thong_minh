CREATE INDEX audit_logs_action_time_idx ON audit_logs(action,created_at DESC,log_id DESC);
CREATE INDEX audit_logs_request_idx ON audit_logs(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX lifecycle_device_time_idx ON device_lifecycle_events(device_id,created_at DESC,event_id DESC);
