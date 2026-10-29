const base = "smartclassroom/room/+/device/%u";
const acl = (acltype, topic) => ({ acltype, topic, allow: true, priority: 1 });
const nodeAcls = (send, receive) => [
  ...send.map((suffix) => acl("publishClientSend", `${base}/${suffix}`)),
  ...receive.flatMap((suffix) => [acl("publishClientReceive", `${base}/${suffix}`), acl("subscribePattern", `${base}/${suffix}`)]),
];

export async function bootstrapBroker(admin, { backendUsername, backendPassword, backendClientId }) {
  // Mặc định từ chối; chỉ các topic được cấp rõ trong từng role mới được truy cập.
  await admin.request({ command: "setDefaultACLAccess", acls: [
    { acltype: "publishClientSend", allow: false }, { acltype: "publishClientReceive", allow: false },
    { acltype: "subscribe", allow: false }, { acltype: "unsubscribe", allow: true },
  ] });
  // Xóa tài khoản demo do broker tạo mặc định để tránh giữ lại một định danh ngoài kiểm soát.
  if (await admin.getClient("democlient")) await admin.request({ command: "deleteClient", username: "democlient" });
  const roles = {
    sensor_role: nodeAcls(["telemetry", "heartbeat", "status", "config/ack"], ["telemetry/ack", "config"]),
    control_role: nodeAcls(["ack", "reported", "heartbeat", "status", "config/ack"], ["command", "config"]),
    backend_role: [acl("publishClientSend", "smartclassroom/#"), acl("publishClientReceive", "smartclassroom/#"), acl("subscribePattern", "smartclassroom/#")],
  };
  for (const [rolename, acls] of Object.entries(roles)) {
    let exists;
    try { await admin.request({ command: "getRole", rolename }); exists = true; }
    catch (error) { if (error.code !== "BROKER_OPERATION_FAILED" || !/role not found/i.test(error.brokerError)) throw error; exists = false; }
    await admin.request({ command: exists ? "modifyRole" : "createRole", rolename, acls });
  }
  await admin.setIdentity({ username: backendUsername, password: backendPassword, clientId: backendClientId, role: "backend_role" });
}
