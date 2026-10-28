#!/bin/sh
set -eu
if [ ! -s /mosquitto/data/dynamic-security.json ]; then
  mosquitto_ctrl dynsec init /mosquitto/data/dynamic-security.json admin "$MQTT_ADMIN_PASSWORD" >/dev/null
fi
chown -R mosquitto:mosquitto /mosquitto/data
exec mosquitto -c /mosquitto/config/mosquitto.conf
