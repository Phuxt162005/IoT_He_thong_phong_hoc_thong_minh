import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { iotFixture, waitFor } from "./helpers/iot.js";
import { createApp } from "../backend/src/app.js";
import { createRoutes } from "../backend/src/routes.js";
import { attachRealtime } from "../backend/src/modules/realtime/realtime.js";
import {
  bindTelemetry,
  TelemetryPipeline,
} from "../backend/src/modules/telemetry-ingestion/telemetry-pipeline.js";
import { MonitoringService } from "../backend/src/modules/monitoring-logging/monitoring.service.js";
import { PostgresMonitoringRepository } from "../backend/src/modules/monitoring-logging/monitoring.repository.postgres.js";

// Separate acceptance suite: npm run build -- --outDir ../.local/frontend-completion-build
// Requires Chrome (BROWSER_BIN can override), isolated test PostgreSQL/MQTT from .env.test.
test(
  "complete frontend workflows against isolated backend, MQTT and PostgreSQL",
  { timeout: 240000 },
  async (t) => {
    let browser, socket, site, apiServer, hub, heartbeatTimer;
    t.after(async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      socket?.close();
      browser?.kill();
      site?.closeAllConnections();
      site?.close();
      await hub?.stop();
      apiServer?.closeAllConnections();
      apiServer?.close();
    });
    const f = await iotFixture(t);
    t.after(
      bindTelemetry(
        f.runtime,
        new TelemetryPipeline({
          pool: f.pool,
          mqtt: f.runtime,
          logger: f.logger,
        }),
      ),
    );
    const sensor = await f.activateSensor(),
      control = await f.activateControl();
    await f.pool.query(
      "UPDATE devices SET hardware_version='ESP32' WHERE device_id=ANY($1::bigint[])",
      [[sensor.device.device_id, control.device.device_id]],
    );
    let uptime = 10;
    heartbeatTimer = setInterval(() => {
      uptime += 10;
      for (const node of [sensor, control])
        void node.client.publishAsync(
          node.topic + "/heartbeat",
          JSON.stringify({
            msg_id: randomUUID(),
            device_id: node.device.device_code,
            room_id: f.room.room_code,
            session_id: "boot-1",
            timestamp: Date.now(),
            uptime_seconds: uptime,
            free_heap_bytes: 100000,
            wifi_rssi_dbm: -50,
          }),
          { qos: 1 },
        );
    }, 10000);
    const sample = async (temperature) => {
      const msg_id = randomUUID();
      await sensor.client.publishAsync(
        sensor.topic + "/telemetry",
        JSON.stringify({
          msg_id,
          device_id: sensor.device.device_code,
          room_id: f.room.room_code,
          timestamp: Date.now(),
          data: { temperature, humidity: 60, lux: 200, occupancy: true },
        }),
        { qos: 1 },
      );
      await waitFor(
        async () =>
          (
            await f.pool.query("SELECT 1 FROM sensor_data WHERE msg_id=$1", [
              msg_id,
            ])
          ).rowCount === 1,
      );
    };
    await sample(26.5);
    const sampleId = (
      await f.pool.query(
        "SELECT data_id FROM sensor_data ORDER BY data_id DESC LIMIT 1",
      )
    ).rows[0].data_id;
    await f.pool.query(
      `INSERT INTO anomaly_detection_results(data_id,device_id,room_id,anomaly_detected,findings) VALUES($1,$2,$3,true,$4)`,
      [
        sampleId,
        sensor.device.device_id,
        f.room.room_id,
        JSON.stringify([
          {
            metric: "temperature",
            value: 0,
            anomaly: true,
            status: "ANOMALY",
            median: 25,
            score: 4,
            baselineSamples: 12,
          },
        ]),
      ],
    );
    const monitoring = new MonitoringService({
      repository: new PostgresMonitoringRepository(f.pool),
      logger: f.logger,
    });
    await monitoring.setComponentStatus("browser-test", "UP");
    await f.pool.query(
      "INSERT INTO monitoring_logs(logged_at,level,service,message,metadata) VALUES(now(),'INFO','frontend-test','Browser monitoring message','{}')",
    );
    const config = {
      ...f.config,
      telemetryFreshnessSeconds: 3,
      corsOrigins: ["http://127.0.0.1:5181"],
    };
    apiServer = createApp({
      config,
      logger: f.logger,
      routes: createRoutes({ ...f, pool: f.pool, config, monitoring }),
    }).listen(0, "127.0.0.1");
    await once(apiServer, "listening");
    const apiBase = "http://127.0.0.1:" + apiServer.address().port;
    hub = attachRealtime({
      server: apiServer,
      pool: f.pool,
      config,
      logger: f.logger,
    });
    await waitFor(() => hub.ready());
    const me = (await f.request("/auth/me", { token: f.token })).body.data;
    let heldCommand,
      hold = false;
    let state = { light: "OFF", fan: "OFF" };
    const ack = async (command) => {
      state = { ...state, ...command.desired_state };
      await control.client.publishAsync(
        control.topic + "/ack",
        JSON.stringify({
          command_id: command.command_id,
          device_id: control.device.device_code,
          room_id: f.room.room_code,
          session_id: "boot-1",
          shadow_version: command.shadow_version,
          status: "SUCCESS",
          reported_state: state,
          timestamp: Date.now(),
        }),
        { qos: 1 },
      );
    };
    control.client.on("message", (topic, raw) => {
      if (topic !== control.topic + "/command") return;
      const command = JSON.parse(raw.toString());
      if (hold) heldCommand = command;
      else void ack(command);
    });
    await control.client.subscribeAsync(control.topic + "/command", { qos: 1 });
    await control.client.publishAsync(
      control.topic + "/reported",
      JSON.stringify({
        device_id: control.device.device_code,
        room_id: f.room.room_code,
        session_id: "boot-1",
        shadow_version: 0,
        reported_state: state,
        timestamp: Date.now(),
      }),
      { qos: 1 },
    );
    const root = resolve(
      process.env.FRONTEND_BUILD_DIR || ".local/frontend-completion-build",
    );
    site = createServer((req, res) => {
      const path = new URL(req.url, "http://localhost").pathname;
      const file = path.startsWith("/assets/")
        ? resolve(root, "." + path)
        : resolve(root, "index.html");
      try {
        res.setHeader(
          "Content-Type",
          { ".js": "text/javascript", ".css": "text/css" }[extname(file)] ||
            "text/html",
        );
        res.end(readFileSync(file));
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => site.listen(5181, "127.0.0.1", resolve));
    const profile = resolve(".local/browser-" + randomUUID());
    mkdirSync(profile, { recursive: true });
    browser = spawn(
      process.env.BROWSER_BIN ||
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-web-security",
        "--remote-debugging-port=9229",
        "--user-data-dir=" + profile,
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    let tab;
    for (let i = 0; i < 80; i++) {
      try {
        tab = (
          await fetch("http://127.0.0.1:9229/json").then((r) => r.json())
        ).find((row) => row.type === "page");
      } catch {}
      if (tab) break;
      await delay(100);
    }
    assert.ok(tab, "Chrome starts");
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await once(socket, "open");
    let sequence = 0;
    const pending = new Map(),
      exceptions = [],
      requests = [];
    let dropCommandResponse = false;
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    socket.on("message", async (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.id) {
        const job = pending.get(event.id);
        pending.delete(event.id);
        event.error
          ? job?.reject(new Error(event.error.message))
          : job?.resolve(event.result);
      }
      if (event.method === "Runtime.exceptionThrown")
        exceptions.push(
          event.params.exceptionDetails.exception?.description ||
            event.params.exceptionDetails.text,
        );
      if (event.method !== "Fetch.requestPaused") return;
      const { requestId, request } = event.params;
      try {
        const url = new URL(request.url);
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(
            ([key]) =>
              ["authorization", "content-type", "idempotency-key"].includes(
                key.toLowerCase(),
              ) || key.startsWith("x-"),
          ),
        );
        const body = request.postDataEntries?.length
          ? Buffer.concat(
              request.postDataEntries.map((entry) =>
                Buffer.from(entry.bytes, "base64"),
              ),
            )
          : request.postData;
        const response = await fetch(apiBase + url.pathname + url.search, {
          method: request.method,
          headers,
          body,
        });
        const text = await response.text();
        requests.push({
          path: url.pathname + url.search,
          method: request.method,
          status: response.status,
          body: text,
        });
        if (
          dropCommandResponse &&
          request.method === "POST" &&
          url.pathname.endsWith("/commands")
        ) {
          dropCommandResponse = false;
          await send("Fetch.failRequest", { requestId, errorReason: "Failed" });
          return;
        }
        await send("Fetch.fulfillRequest", {
          requestId,
          responseCode: response.status,
          responseHeaders: [
            {
              name: "Content-Type",
              value: response.headers.get("content-type") || "application/json",
            },
          ],
          body: Buffer.from(text).toString("base64"),
        });
      } catch (error) {
        if (!error.message.includes("Invalid InterceptionId"))
          exceptions.push(error.message);
        await send("Fetch.failRequest", {
          requestId,
          errorReason: "Failed",
        }).catch(() => {});
      }
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Fetch.enable", {
      patterns: [{ urlPattern: "*://localhost:3000/api/v1/*" }],
    });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `if(!localStorage.getItem('test_initialized')){localStorage.setItem('smart_token',${JSON.stringify(f.token)});localStorage.setItem('smart_user',${JSON.stringify(JSON.stringify({ ...me, id: me.user_id }))});localStorage.setItem('test_initialized','true');}window.WebSocket=class extends WebSocket{constructor(url,protocols){super(${JSON.stringify(apiBase.replace("http", "ws") + "/ws")},protocols);}};`,
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text,
        );
      return result.result.value;
    };
    const until = async (expression, ms = 12000) => {
      for (let i = 0; i < ms / 50; i++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(
        "Timeout: " +
          expression +
          "\n" +
          (await evaluate("document.body.innerText")) +
          "\nRecent requests: " +
          JSON.stringify(
            requests.slice(-6).map(({ path, status }) => ({ path, status })),
          ),
      );
    };
    const navigate = async (path) => {
      await f.pool.query("DELETE FROM api_rate_limits");
      await send("Page.navigate", { url: "http://127.0.0.1:5181" + path });
      await until('document.readyState==="complete"');
    };
    const fill = async (selector, value) => {
      await until(
        "Boolean(document.querySelector(" + JSON.stringify(selector) + "))",
      );
      return evaluate(
        `(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw new Error('Input missing');const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    };
    const select = async (selector, value) => {
      await until(
        "Array.from(document.querySelector(" +
          JSON.stringify(selector) +
          ")?.options||[]).some(option=>option.value===" +
          JSON.stringify(value) +
          ")",
      );
      return evaluate(
        `(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw new Error('Select missing');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    };
    const click = async (text, root = "document") => {
      await until(
        `Array.from(${root}.querySelectorAll('button')).some(button=>button.textContent.trim()===${JSON.stringify(text)}&&!button.disabled)`,
      );
      return evaluate(
        `(()=>{const button=Array.from(${root}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Button missing: '+${JSON.stringify(text)});button.click();})()`,
      );
    };
    const form = () =>
      evaluate('document.querySelector("dialog form").requestSubmit()');
    const checked = (selector) =>
      evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const saved = () => until('!document.querySelector("dialog[open]")');
    await navigate("/dashboard");
    await until(
      'document.querySelector(".metric-grid")?.innerText.includes("26.5")',
    );
    await until('Boolean(document.querySelector(".socket-status.connected"))');
    t.diagnostic("Dashboard and authenticated WebSocket loaded real data");
    assert.equal(
      await evaluate(
        'document.body.innerText.includes("Dữ liệu cảm biến đã cũ")',
      ),
      false,
    );
    await until(
      'document.body.innerText.includes("Dữ liệu cảm biến đã cũ")',
      8000,
    );
    const stale = await fetch(
      `${apiBase}/api/v1/dashboard?room_id=${f.room.room_id}`,
      { headers: { Authorization: `Bearer ${f.token}` } },
    ).then((response) => response.json());
    assert.equal(stale.data.latest_telemetry[0].stale, true);
    t.diagnostic(
      "Dashboard ages cached samples without waiting for another MQTT event",
    );
    await navigate("/rooms");
    await until('Boolean(document.querySelector("table"))');
    await click("+ Thêm phòng");
    await fill("[name=room_code]", "UI_ROOM");
    await fill("[name=room_name]", "Phòng kiểm thử giao diện");
    await form();
    await saved();
    await until('document.body.innerText.includes("Phòng kiểm thử giao diện")');
    const newRoom = (
      await f.pool.query("SELECT * FROM rooms WHERE room_code='UI_ROOM'")
    ).rows[0];
    const viewer = (
      await f.request("/users", {
        method: "POST",
        token: f.token,
        body: {
          username: "ui_viewer",
          display_name: "UI Viewer",
          role: "VIEWER",
          password: "Eight@12",
        },
      })
    ).body.data;
    assert.equal(
      (
        await f.request(`/rooms/${f.room.room_id}/users`, {
          method: "PUT",
          token: f.token,
          body: { user_ids: [viewer.user_id] },
        })
      ).status,
      200,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('tbody tr')).find(row=>row.textContent.includes('UI_ROOM')).querySelectorAll('button')[1].click()`,
    );
    await until('Boolean(document.querySelector("dialog[open] select"))');
    await evaluate(
      `(()=>{const input=document.querySelector('dialog select');for(const option of input.options)option.selected=option.value===${JSON.stringify(viewer.user_id)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await form();
    await saved();
    assert.equal(
      (
        await f.pool.query(
          "SELECT * FROM user_rooms WHERE room_id=$1 AND user_id=$2",
          [newRoom.room_id, viewer.user_id],
        )
      ).rowCount,
      1,
    );
    t.diagnostic("Room creation and membership assignment persist");
    await navigate("/devices");
    await until('Boolean(document.querySelector("table"))');
    await click("+ Đăng ký thiết bị");
    await fill("[name=device_code]", "UI_UNASSIGNED");
    await fill("[name=device_name]", "Thiết bị chưa gán");
    await form();
    await saved();
    const device = (
      await f.pool.query(
        "SELECT * FROM devices WHERE device_code='UI_UNASSIGNED'",
      )
    ).rows[0];
    assert.equal(device.room_id, null);
    await navigate("/devices/" + device.device_id);
    await until('document.body.innerText.includes("Ngừng sử dụng")');
    await click("Ngừng sử dụng");
    await fill("[name=reason]", "Kiểm thử xác nhận ngừng");
    await checked("[name=confirmed]");
    await form();
    await saved();
    assert.equal(
      (
        await f.pool.query(
          "SELECT lifecycle_status FROM devices WHERE device_id=$1",
          [device.device_id],
        )
      ).rows[0].lifecycle_status,
      "DECOMMISSIONED",
    );
    t.diagnostic("Unassigned registration and confirmed decommission work");
    await navigate("/telemetry");
    await until('Boolean(document.querySelector("select"))');
    await select('[aria-label="Phòng"]', f.room.room_id);
    await until('document.body.innerText.includes("26.5")');
    await delay(100);
    await sample(27.8);
    await click("Áp dụng / Cập nhật");
    await until('document.body.innerText.includes("27.8")');
    t.diagnostic("Live telemetry query window advances");
    const downloadDirectory = resolve(".local/browser-downloads");
    mkdirSync(downloadDirectory, { recursive: true });
    await send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadDirectory,
    });
    await click("Xuất CSV");
    await waitFor(() =>
      requests.some(
        (row) =>
          row.path.includes("/telemetry/export") &&
          row.status === 200 &&
          row.body.includes("27.8"),
      ),
    );
    await f.pool.query(
      "INSERT INTO alerts(device_id,room_id,alert_type,severity,value,message) VALUES($1,$2,'TEMP_HIGH','WARNING',36,'UI test alert')",
      [sensor.device.device_id, f.room.room_id],
    );
    await navigate("/alerts");
    await until('document.body.innerText.includes("Xác nhận")');
    await click("Xác nhận");
    await form();
    await saved();
    await until('document.body.innerText.includes("ACKNOWLEDGED")');
    await click("Đóng");
    await fill("[name=reason]", "UI verified resolution");
    await form();
    await saved();
    await until('document.body.innerText.includes("RESOLVED")');
    await select('[aria-label="Phòng"]', f.room.room_id);
    await click("Cấu hình ngưỡng phòng");
    await until(
      'Boolean(document.querySelector("[name=TEMPERATURE_WARNING_threshold]"))',
    );
    await form();
    await saved();
    assert.equal(
      (
        await f.pool.query("SELECT * FROM alert_thresholds WHERE room_id=$1", [
          f.room.room_id,
        ])
      ).rowCount,
      4,
    );
    t.diagnostic(
      "Telemetry CSV and alert acknowledge/resolve/threshold forms match real API contracts",
    );
    await navigate("/audit-logs");
    await until('Boolean(document.querySelector("table"))');
    await select('[aria-label="Kết quả"]', "SUCCESS");
    await click("Lọc");
    await until('Boolean(document.querySelector("table"))');
    await select('[aria-label="Kết quả"]', "");
    await click("Lọc");
    await delay(250);
    assert.ok(
      !requests
        .slice(-5)
        .some((row) => row.path.includes("/audit-logs") && row.status === 400),
    );
    await navigate("/anomalies");
    await until('document.body.innerText.includes("temperature")');
    assert.ok(
      await evaluate('document.body.innerText.includes("baseline 12")'),
    );
    t.diagnostic(
      "Cleared audit filters and nested anomaly findings render correctly",
    );
    await navigate("/control/automation");
    await until('Boolean(document.querySelector("select"))');
    await select('[aria-label="Phòng"]', f.room.room_id);
    await click("+ Tạo quy tắc");
    await fill("[name=name]", "UI temperature rule");
    await until(
      "document.querySelector('[name=target_device_id]')?.options.length>1",
    );
    await select("[name=target_device_id]", control.device.device_id);
    for (let depth = 0; depth < 4; depth++) {
      await until(
        `Array.from(document.querySelectorAll('fieldset.condition-builder > select')[${depth}]?.options || []).some(option=>option.value==='all')`,
      );
      await evaluate(
        `(()=>{const input=document.querySelectorAll('fieldset.condition-builder > select')[${depth}];input.value='all';input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    }
    await until(
      'document.querySelectorAll("fieldset.condition-builder").length===5',
    );
    await form();
    await saved();
    await until('document.body.innerText.includes("UI temperature rule")');
    t.diagnostic("Automation rule creation persists");
    await navigate("/control");
    await until('Boolean(document.querySelector(".control-grid"))');
    await until(
      'Array.from(document.querySelectorAll(".control-grid button")).some(button=>!button.disabled)',
    );
    await click("Bật", 'document.querySelector(".control-grid")');
    await until(
      'document.querySelector(".notice")?.innerText.includes("SUCCESS")',
    );
    const first = (
      await f.pool.query(
        "SELECT command_id FROM commands ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    hold = true;
    await until(
      'Array.from(document.querySelectorAll(".control-grid button")).some(button=>!button.disabled)',
    );
    await click("Tắt", 'document.querySelector(".control-grid")');
    await waitFor(() => heldCommand);
    await evaluate(
      `window.dispatchEvent(new CustomEvent('iot:event',{detail:{type:'command.updated',payload:{device_id:${JSON.stringify(control.device.device_id)},command_id:${JSON.stringify(first.command_id)},status:'SUCCESS'}}}))`,
    );
    await delay(100);
    assert.ok(
      await evaluate(
        'Array.from(document.querySelectorAll(".control-grid button")).every(button=>button.disabled)',
      ),
    );
    await ack(heldCommand);
    hold = false;
    await until(
      'document.querySelector(".notice")?.innerText.includes("SUCCESS")',
    );
    t.diagnostic("Control waits for its own command ID and real MQTT ACK");
    await until(
      'Boolean(document.querySelector(".control-grid button:not(:disabled)"))',
    );
    dropCommandResponse = true;
    await click("Bật", 'document.querySelector(".control-grid")');
    await until(
      'Array.from(document.querySelectorAll("button")).some(button=>button.textContent.trim()==="Gửi lại cùng yêu cầu")',
    );
    const commandCountBeforeExpiry = Number(
      (await f.pool.query("SELECT count(*) FROM commands")).rows[0].count,
    );
    await evaluate(
      `(()=>{const native=performance.now.bind(performance);Object.defineProperty(performance,'now',{configurable:true,value:()=>native()+56000});Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Gửi lại cùng yêu cầu').click();Object.defineProperty(performance,'now',{configurable:true,value:native});})()`,
    );
    await until(
      'document.querySelector(".notice")?.innerText.includes("hết thời hạn")',
    );
    assert.equal(
      Number(
        (await f.pool.query("SELECT count(*) FROM commands")).rows[0].count,
      ),
      commandCountBeforeExpiry,
    );
    t.diagnostic(
      "A lost response cannot be retried after the safe idempotency window or create another command",
    );
    await navigate("/devices/" + sensor.device.device_id);
    await until('document.body.innerText.includes("Đổi cấu hình")');
    await click("Đổi cấu hình");
    assert.equal(
      await evaluate(
        'document.querySelector("[name=heartbeat_interval_seconds]").max',
      ),
      "10",
    );
    await fill("[name=heartbeat_interval_seconds]", "11");
    assert.equal(
      await evaluate(
        'document.querySelector("[name=heartbeat_interval_seconds]").checkValidity()',
      ),
      false,
    );
    await fill("[name=sample_interval_seconds]", "8");
    await fill("[name=heartbeat_interval_seconds]", "5");
    await form();
    await saved();
    await until('document.body.innerText.includes("PENDING")');
    const configuration = (
      await f.pool.query(
        "SELECT * FROM device_configs WHERE device_id=$1 ORDER BY version DESC LIMIT 1",
        [sensor.device.device_id],
      )
    ).rows[0];
    await sensor.client.publishAsync(
      sensor.topic + "/config/ack",
      JSON.stringify({
        config_id: configuration.config_id,
        device_id: sensor.device.device_code,
        room_id: f.room.room_code,
        session_id: "boot-1",
        version: configuration.version,
        status: "SUCCESS",
        timestamp: Date.now(),
        applied_settings: configuration.settings,
      }),
      { qos: 1 },
    );
    await until(
      'document.querySelector("tbody")?.innerText.includes("SUCCESS")',
    );
    t.diagnostic(
      "Remote configuration distinguishes desired and applied state",
    );
    await navigate("/monitoring");
    await until(
      'document.body.innerText.includes("Browser monitoring message")',
    );
    await navigate("/ota");
    await until('document.body.innerText.includes("Upload firmware")');
    await click("Upload firmware");
    await fill("[name=version]", "2.0-ui");
    await select("[name=device_type]", "SENSOR_NODE");
    await fill("[name=hardware_target]", "ESP32");
    const releaseNotes = "ấ".repeat(2000);
    await fill("[name=release_notes]", releaseNotes);
    await evaluate(
      `(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['firmware-ui-test'],'firmware.bin',{type:'application/octet-stream'}));const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await form();
    await saved();
    await until('document.body.innerText.includes("2.0-ui")');
    await click("Phát hành");
    await checked("[name=confirmed]");
    await form();
    await saved();
    await until('document.body.innerText.includes("PUBLISHED")');
    t.diagnostic(
      "Monitoring logs and firmware upload/publish, including Vietnamese notes, work",
    );
    const release = (
      await f.pool.query(
        "SELECT * FROM firmware_releases WHERE version='2.0-ui'",
      )
    ).rows[0];
    assert.equal(release.release_notes, releaseNotes);
    await click("Cập nhật thiết bị");
    await until(
      'document.querySelector("[name=firmware_id]")?.options.length>1',
    );
    await select("[name=device_id]", sensor.device.device_id);
    await select("[name=firmware_id]", release.firmware_id);
    await checked("[name=confirmed]");
    await form();
    await saved();
    await until(
      'document.body.innerText.includes("NOTIFIED")||document.body.innerText.includes("PENDING")',
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT * FROM ota_jobs WHERE device_id=$1 AND firmware_id=$2",
          [sensor.device.device_id, release.firmware_id],
        )
      ).rowCount,
      1,
    );
    t.diagnostic(
      "OTA update job is created for the selected compatible device",
    );
    await f.pool.query(
      "INSERT INTO rooms(room_code,room_name) SELECT 'PAGE_'||x,'Pagination Room '||x FROM generate_series(1,105) x",
    );
    await f.pool.query(
      "INSERT INTO devices(device_code,device_name,device_type) SELECT 'PAGE_D_'||x,'Pagination Device '||x,'SENSOR_NODE' FROM generate_series(1,25) x",
    );
    await navigate("/rooms");
    await until('document.body.innerText.includes("107 bản ghi")');
    await click("Sau");
    await until('document.body.innerText.includes("Trang 2/6")');
    await navigate("/dashboard");
    await until('document.querySelector("select")?.options.length===108');
    const lastDevice = (
      await f.pool.query(
        "SELECT device_id FROM devices WHERE device_code='PAGE_D_25'",
      )
    ).rows[0];
    await navigate("/devices/" + lastDevice.device_id);
    await until(
      'document.querySelector("h2")?.textContent.includes("Pagination Device 25")',
    );
    t.diagnostic(
      "Pagination, room selectors beyond 100 records, and device detail beyond the first page work",
    );
    await navigate(`/devices/${device.device_id}`);
    await until(
      'document.querySelector("h2")?.textContent.includes("Thiết bị chưa gán")',
    );
    assert.equal(
      await evaluate(
        'Array.from(document.querySelectorAll("button")).some(button=>button.textContent.trim()==="Sửa thông tin")',
      ),
      false,
    );
    assert.equal(
      (
        await f.request(`/rooms/${f.room.room_id}`, {
          method: "PATCH",
          token: f.token,
          body: { status: "INACTIVE" },
        })
      ).status,
      200,
    );
    await navigate("/control");
    await until('document.body.innerText.includes("Phòng đã ngừng hoạt động")');
    assert.equal(
      await evaluate(
        'Boolean(document.querySelector(".control-grid button:not(:disabled)"))',
      ),
      false,
    );
    assert.equal(
      (
        await f.request(`/rooms/${f.room.room_id}`, {
          method: "PATCH",
          token: f.token,
          body: { status: "ACTIVE" },
        })
      ).status,
      200,
    );
    clearInterval(heartbeatTimer);
    assert.equal(
      (await f.action(control.device.device_id, "revoke", { confirmed: true }))
        .status,
      200,
    );
    await navigate(`/devices/${control.device.device_id}`);
    await until(
      'Array.from(document.querySelectorAll("a")).some(link=>link.getAttribute("href")?.startsWith("/control?"))',
    );
    await evaluate(
      'Array.from(document.querySelectorAll("a")).find(link=>link.getAttribute("href")?.startsWith("/control?")).click()',
    );
    await until(
      'Boolean(document.querySelector("tbody tr"))&&document.body.innerText.includes("Lịch sử lệnh")',
    );
    assert.equal(
      await evaluate('document.querySelectorAll("select")[1].value'),
      control.device.device_id,
    );
    assert.equal(
      await evaluate(
        'Boolean(document.querySelector(".control-grid button:not(:disabled)"))',
      ),
      false,
    );
    t.diagnostic(
      "Retired devices cannot be edited, inactive rooms cannot be controlled, and revoked command history stays readable",
    );
    await navigate(`/devices/${lastDevice.device_id}`);
    await until(
      'document.querySelector("h2")?.textContent.includes("Pagination Device 25")',
    );
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      ".local/frontend-device-detail.png",
      Buffer.from(screenshot.data, "base64"),
    );
    await navigate("/rooms");
    await until('Boolean(document.querySelector("table"))');
    const revocationStart = requests.length;
    assert.equal(
      (await f.request("/auth/logout", { method: "POST", token: f.token }))
        .status,
      200,
    );
    await until('location.pathname==="/login"');
    const revocationEnd = requests.length;
    await fill("[name=username]", "ui_viewer");
    await fill("[name=password]", "Eight@12");
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      'location.pathname==="/dashboard"&&Boolean(document.querySelector(".sidebar"))',
    );
    await until('document.querySelector("select")?.options.length===3');
    assert.equal(
      await evaluate('document.body.innerText.includes("Pagination Room")'),
      false,
      "A revoked Admin session must not leave its cached rooms visible to Viewer",
    );
    await navigate("/ota");
    await until('document.body.innerText.includes("2.0-ui")');
    await delay(250);
    assert.equal(
      await evaluate('Boolean(document.querySelector("[role=alert]"))'),
      false,
    );
    assert.equal(
      await evaluate(
        'Array.from(document.querySelectorAll("button")).some(button=>button.textContent.includes("Upload firmware"))',
      ),
      false,
    );
    await navigate("/control/automation");
    await until('Boolean(document.querySelector(".page-title"))');
    assert.equal(
      await evaluate(
        'Array.from(document.querySelectorAll("button")).some(button=>button.textContent.includes("Tạo quy tắc"))',
      ),
      false,
    );
    await navigate("/control");
    await until('Boolean(document.querySelector(".control-grid"))');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".control-grid button"))'),
      false,
    );
    await navigate("/monitoring");
    await until('location.pathname==="/403"');
    t.diagnostic(
      "Viewer can read allowed OTA/rules pages and cannot access Admin actions or monitoring",
    );
    assert.deepEqual(exceptions, []);
    assert.deepEqual(
      requests
        .filter(
          (row, index) =>
            row.status >= 400 &&
            !(
              row.status === 401 &&
              index >= revocationStart &&
              index < revocationEnd
            ),
        )
        .map(({ path, status }) => ({ path, status })),
      [],
      "All UI requests match backend contracts and permissions",
    );
    assert.ok(
      !requests.some((row) => row.status === 429),
      "No rate-limit flood in normal acceptance flow",
    );
    await send("Browser.close");
  },
);
