CREATE FUNCTION notify_iot_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('smartclass_iot_' || TG_TABLE_SCHEMA, NEW.event_id::text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER iot_events_notify AFTER INSERT ON iot_events FOR EACH ROW EXECUTE FUNCTION notify_iot_event();
