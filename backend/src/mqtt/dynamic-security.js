import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import { AppError } from "../common/errors.js";

const control = "$CONTROL/dynamic-security/v1";
const unavailable = () => new AppError("BROKER_UNAVAILABLE", 503, "MQTT broker chưa sẵn sàng");

export class DynamicSecurity {
  constructor({ url, username = "admin", password }) { this.url = url; this.username = username; this.password = password; }
  async request(command) {
    let client;
    const correlationData = randomUUID();
    let deadline;
    const timeout = new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(unavailable()), 5000); });
    const work = async () => {
      // Phản hồi dùng chung topic: ghép bằng correlationData để không nhận nhầm kết quả lệnh khác.
      client = mqtt.connect(this.url, { username: this.username, password: this.password, clientId: `dynsec-${randomUUID()}`, reconnectPeriod: 0, connectTimeout: 2500, protocolVersion: 5, queueQoSZero: false });
      client.on("error", () => {});
      await new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", () => reject(unavailable()));
        client.once("close", () => reject(unavailable()));
      });
      await client.subscribeAsync(`${control}/response`, { qos: 1 });
      const reply = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(unavailable()), 2500);
        const finish = (fn, value) => { clearTimeout(timeout); fn(value); };
        client.on("message", (_topic, raw) => {
          try {
            const response = JSON.parse(raw.toString()).responses?.find((row) => row.correlationData === correlationData);
            if (response) finish(resolve, response);
          } catch { finish(reject, unavailable()); }
        });
        client.once("close", () => finish(reject, unavailable()));
        client.publish(control, JSON.stringify({ commands: [{ ...command, correlationData }] }), { qos: 1, retain: false }, (error) => { if (error) finish(reject, unavailable()); });
      });
      const response = await reply;
      if (!response || response.command !== command.command) throw unavailable();
      if (response.error) {
        const error = new AppError("BROKER_OPERATION_FAILED", 503, "Broker chưa áp dụng được cấu hình");
        error.brokerError = response.error;
        throw error;
      }
      return response.data;
    };
    try {
      return await Promise.race([work(), timeout]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    } finally { clearTimeout(deadline); await client?.endAsync(true); }
  }
  async getClient(username) {
    try { return (await this.request({ command: "getClient", username }))?.client ?? null; }
    catch (error) { if (error.code === "BROKER_OPERATION_FAILED" && /client not found/i.test(error.brokerError)) return null; throw error; }
  }
  async setIdentity({ username, password, deviceType, clientId = username, role }) {
    const roles = [{ rolename: role ?? (deviceType === "SENSOR_NODE" ? "sensor_role" : "control_role"), priority: 1 }];
    if (await this.getClient(username)) {
      // Ngắt phiên cũ trước khi đổi mật khẩu/ACL, rồi mới cho phép kết nối với cấu hình mới.
      await this.request({ command: "disableClient", username });
      await this.request({ command: "modifyClient", username, password, clientid: clientId, roles, groups: [] });
      await this.request({ command: "enableClient", username });
    } else {
      await this.request({ command: "createClient", username, password, clientid: clientId, roles });
    }
  }
  async revoke(username) {
    if (await this.getClient(username)) await this.request({ command: "disableClient", username });
  }
}
