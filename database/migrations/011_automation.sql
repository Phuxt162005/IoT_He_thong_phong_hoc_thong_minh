CREATE TABLE automation_rules (
  rule_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES rooms(room_id),
  name VARCHAR(100) NOT NULL,
  target_device_id BIGINT NOT NULL REFERENCES devices(device_id),
  actuator VARCHAR(10) NOT NULL CHECK(actuator IN ('LIGHT','FAN')),
  action VARCHAR(3) NOT NULL CHECK(action IN ('ON','OFF')),
  condition JSONB NOT NULL,
  hold_seconds INTEGER NOT NULL CHECK(hold_seconds BETWEEN 0 AND 300),
  cooldown_seconds INTEGER NOT NULL CHECK(cooldown_seconds BETWEEN 1 AND 3600),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 1000),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX automation_rules_room_idx ON automation_rules(room_id,priority,rule_id);
CREATE TABLE automation_rule_state (
  rule_id BIGINT PRIMARY KEY REFERENCES automation_rules(rule_id),
  true_since TIMESTAMPTZ,
  last_evaluated_at TIMESTAMPTZ,
  last_triggered_at TIMESTAMPTZ,
  last_data_id BIGINT REFERENCES sensor_data(data_id) ON DELETE SET NULL,
  last_trigger_data_id BIGINT REFERENCES sensor_data(data_id) ON DELETE SET NULL
);
ALTER TABLE commands ADD CONSTRAINT commands_rule_fk FOREIGN KEY(rule_id) REFERENCES automation_rules(rule_id);
