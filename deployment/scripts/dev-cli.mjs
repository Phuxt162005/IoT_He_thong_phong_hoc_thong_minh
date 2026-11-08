import "dotenv/config";
import { randomUUID } from "node:crypto";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:3000") + "/api/v1";

async function login() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "Đăng nhập thất bại");
  return data.data.access_token;
}

async function request(token, path, method = "GET", body = null) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message ?? `Lỗi API ${res.status}`);
    err.code = data.error?.code;
    err.details = data.error?.details;
    throw err;
  }
  return data.data;
}

async function findRoomByCode(token, roomCode) {
  const res = await request(token, `/rooms?page_size=100`);
  return res?.find?.((r) => r.room_code === roomCode) ?? null;
}

async function findDeviceByCode(token, deviceCode) {
  const res = await request(token, `/devices?page_size=100`);
  return res?.find?.((d) => d.device_code === deviceCode) ?? null;
}

async function cmdSetup(roomCode, deviceCode, deviceType) {
  if (!roomCode || !deviceCode || !deviceType) {
    console.log("Cú pháp: node dev-cli.mjs setup <ROOM_CODE> <DEVICE_CODE> <SENSOR_NODE|CONTROL_NODE>");
    console.log("Ví dụ : node dev-cli.mjs setup A101 SN-A101-01 SENSOR_NODE");
    return;
  }

  deviceType = deviceType.toUpperCase();
  if (!["SENSOR_NODE", "CONTROL_NODE"].includes(deviceType)) {
    console.error("Loại thiết bị chỉ có thể là SENSOR_NODE hoặc CONTROL_NODE");
    return;
  }

  const token = await login();

  // 1. Kiểm tra hoặc tạo phòng
  let room = await findRoomByCode(token, roomCode);
  if (!room) {
    console.log(`[1/3] Phòng ${roomCode} chưa tồn tại. Đang tạo mới...`);
    room = await request(token, "/rooms", "POST", {
      room_code: roomCode,
      room_name: `Phòng học ${roomCode}`,
    });
    console.log(` -> Đã tạo phòng ID: ${room.room_id}`);
  } else {
    console.log(`[1/3] Phòng ${roomCode} đã tồn tại (ID: ${room.room_id})`);
  }

  // 2. Kiểm tra hoặc đăng ký thiết bị
  let device = await findDeviceByCode(token, deviceCode);
  if (!device) {
    console.log(`[2/3] Đăng ký thiết bị ${deviceCode} (${deviceType})...`);
    device = await request(token, "/devices", "POST", {
      device_code: deviceCode,
      device_name: `${deviceType === "SENSOR_NODE" ? "Cảm biến" : "Điều khiển"} ${roomCode}`,
      device_type: deviceType,
      room_id: room.room_id,
      firmware_version: "1.0.0",
    });
    console.log(` -> Đã đăng ký thiết bị ID: ${device.device_id} (Trạng thái: ${device.lifecycle_status})`);
  } else {
    console.log(`[2/3] Thiết bị ${deviceCode} đã tồn tại (ID: ${device.device_id}, Trạng thái: ${device.lifecycle_status})`);
  }

  // 3. Cấp phát thông tin xác thực MQTT (Provision)
  let credentials = null;
  if (["REGISTERED", "REVOKED"].includes(device.lifecycle_status)) {
    console.log(`[3/3] Cấp phát thông tin xác thực MQTT (Provision)...`);
    const prov = await request(token, `/devices/${device.device_id}/provision`, "POST", {
      reason: "Dev CLI Provision",
      confirmed: true,
    });
    credentials = prov.credentials;
  } else if (device.lifecycle_status === "PROVISIONED") {
    console.log(`[3/3] Thiết bị đang ở trạng thái PROVISIONED. Bạn có muốn đổi secret mới không?`);
    console.log(` -> Nếu đã quên secret, hãy chạy: node dev-cli.mjs rotate ${deviceCode}`);
  } else {
    console.log(`[3/3] Thiết bị đang ở trạng thái ${device.lifecycle_status}.`);
  }

  if (credentials) {
    console.log("\n==================================================================");
    console.log("  CẤU HÌNH THÀNH CÔNG! HÃY SAO CHÉP VÀO FILE Config.h TRÊN ESP32:");
    console.log("==================================================================");
    console.log(`#define DEVICE_ID           "${credentials.client_id}"`);
    console.log(`#define ROOM_ID             "${roomCode}"`);
    console.log(`#define MQTT_USERNAME       "${credentials.username}"`);
    console.log(`#define MQTT_PASSWORD       "${credentials.password}"`);
    console.log("==================================================================\n");
    console.log("Tiếp theo: Sau khi nạp code lên ESP32 và thấy Serial báo CONNECTED, hãy chạy:");
    console.log(`npm run dev:cli activate ${deviceCode}`);
  }
}

async function cmdRotate(deviceCode) {
  if (!deviceCode) {
    console.log("Cú pháp: node dev-cli.mjs rotate <DEVICE_CODE>");
    return;
  }
  const token = await login();
  const device = await findDeviceByCode(token, deviceCode);
  if (!device) {
    console.error(`Không tìm thấy thiết bị có mã ${deviceCode}`);
    return;
  }
  const res = await request(token, `/devices/${device.device_id}/rotate-credentials`, "POST", {
    reason: "Dev CLI rotate",
  });
  console.log("\n==================================================================");
  console.log(`  ĐÃ ĐỔI MẬT KHẨU MỚI CHO ${deviceCode}! SAO CHÉP VÀO Config.h:`);
  console.log("==================================================================");
  console.log(`#define MQTT_PASSWORD       "${res.credentials.password}"`);
  console.log("==================================================================\n");
}

async function cmdActivate(deviceCode) {
  if (!deviceCode) {
    console.log("Cú pháp: node dev-cli.mjs activate <DEVICE_CODE>");
    return;
  }
  const token = await login();
  const device = await findDeviceByCode(token, deviceCode);
  if (!device) {
    console.error(`Không tìm thấy thiết bị có mã ${deviceCode}`);
    return;
  }

  try {
    await request(token, `/devices/${device.device_id}/activate`, "POST", {
      reason: "Dev CLI manual activation",
    });
    console.log(`Thành công! Thiết bị ${deviceCode} đã được KÍCH HOẠT (ACTIVE)!`);
  } catch (err) {
    console.error(`Kích hoạt thất bại: ${err.message}`);
    if (err.code === "INVALID_TRANSITION" || err.code === "DEVICE_NOT_READY") {
      console.log("💡 Gợi ý: Backend chỉ cho kích hoạt khi ESP32 đã kết nối ONLINE và gửi ít nhất 1 heartbeat.");
      console.log(`Hãy kiểm tra trạng thái thiết bị bằng: npm run dev:cli status ${deviceCode}`);
    }
  }
}

async function cmdStatus(deviceCode) {
  if (!deviceCode) {
    console.log("Cú pháp: node dev-cli.mjs status <DEVICE_CODE>");
    return;
  }
  const token = await login();
  const device = await findDeviceByCode(token, deviceCode);
  if (!device) {
    console.error(`Không tìm thấy thiết bị có mã ${deviceCode}`);
    return;
  }

  const detail = await request(token, `/devices/${device.device_id}`);
  console.log("\n--- THÔNG TIN THIẾT BỊ ---");
  console.log(`Mã thiết bị     : ${detail.device_code}`);
  console.log(`Tên thiết bị    : ${detail.device_name}`);
  console.log(`Loại thiết bị   : ${detail.device_type}`);
  console.log(`Vòng đời        : ${detail.lifecycle_status}`);
  console.log(`Kết nối         : ${detail.connection_status === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}`);
  console.log(`Phiên MQTT      : ${detail.session_id ?? "(Chưa có)"}`);
  console.log(`Heartbeat cuối  : ${detail.last_heartbeat_at ? new Date(detail.last_heartbeat_at).toLocaleString() : "(Chưa có)"}`);
  console.log(`Uptime          : ${detail.last_uptime_seconds ? `${detail.last_uptime_seconds}s` : "N/A"}`);
  console.log(`Wi-Fi RSSI      : ${detail.last_rssi_dbm ? `${detail.last_rssi_dbm} dBm` : "N/A"}`);
  console.log(`Free Heap       : ${detail.last_free_heap_bytes ? `${detail.last_free_heap_bytes} bytes` : "N/A"}`);
  console.log(`Firmware Ver    : ${detail.firmware_version ?? "N/A"}`);

  if (detail.actuators && detail.actuators.length > 0) {
    console.log("\n--- TRẠNG THÁI CƠ CẤU CHẤP HÀNH (ACTUATORS) ---");
    for (const a of detail.actuators) {
      console.log(`- ${a.actuator_type}: Current=${a.current_state} | Desired=${a.desired_state}`);
    }
  }
}

async function cmdCommand(deviceCode, fanState, lightState) {
  if (!deviceCode) {
    console.log("Cú pháp: node dev-cli.mjs command <DEVICE_CODE> [fan:ON|OFF] [light:ON|OFF]");
    console.log("Ví dụ : node dev-cli.mjs command CN-A101-01 ON OFF");
    return;
  }
  const token = await login();
  const device = await findDeviceByCode(token, deviceCode);
  if (!device) {
    console.error(`Không tìm thấy thiết bị có mã ${deviceCode}`);
    return;
  }

  const desired_state = {};
  if (fanState) desired_state.fan = fanState.toUpperCase();
  if (lightState) desired_state.light = lightState.toUpperCase();

  if (Object.keys(desired_state).length === 0) {
    console.error("Cần chỉ định ít nhất 1 trạng thái quạt hoặc đèn (ON/OFF)");
    return;
  }

  console.log(`Đang gửi lệnh điều khiển tới ${deviceCode}:`, desired_state);
  try {
    const res = await request(token, `/devices/${device.device_id}/commands`, "POST", {
      desired_state,
      timeout_seconds: 5,
    });
    console.log(` -> Lệnh đã được tiếp nhận (Command ID: ${res.command?.command_id}, Trạng thái: ${res.command?.status})`);
  } catch (err) {
    console.error(`Gửi lệnh thất bại: ${err.message}`);
  }
}

async function cmdList() {
  const token = await login();
  const devices = await request(token, `/devices?page_size=100`);
  console.log("\nDANH SÁCH THIẾT BỊ HIỆN CÓ:");
  console.table(
    devices.map((d) => ({
      ID: d.device_id,
      Code: d.device_code,
      Name: d.device_name,
      Type: d.device_type,
      Lifecycle: d.lifecycle_status,
      Connection: d.connection_status,
      Session: d.session_id ?? "-",
    }))
  );
}

// Điều hướng lệnh
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "setup":
    cmdSetup(args[0], args[1], args[2]);
    break;
  case "rotate":
    cmdRotate(args[0]);
    break;
  case "activate":
    cmdActivate(args[0]);
    break;
  case "status":
    cmdStatus(args[0]);
    break;
  case "list":
    cmdList();
    break;
  case "command":
    cmdCommand(args[0], args[1], args[2]);
    break;
  default:
    console.log(`
===============================================================
  SMART CLASSROOM DEV CLI - QUẢN LÝ & TEST THIẾT BỊ VỚI BACKEND
===============================================================
Lệnh hỗ trợ:
  node dev-cli.mjs setup <ROOM_CODE> <DEVICE_CODE> <TYPE>  : Đăng ký & lấy secret cho ESP32
  node dev-cli.mjs activate <DEVICE_CODE>                 : Kích hoạt thiết bị khi đã ONLINE
  node dev-cli.mjs status <DEVICE_CODE>                   : Xem thông số kết nối, RSSI, heap
  node dev-cli.mjs list                                   : Liệt kê tất cả thiết bị
  node dev-cli.mjs command <DEVICE_CODE> <FAN> <LIGHT>    : Điều khiển bật/tắt quạt & đèn
`);
}

