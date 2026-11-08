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

test(
  "mock workflows persist in the SPA and never call the real backend",
  { timeout: 60000 },
  async (t) => {
    const root = resolve(".local/frontend-completion-mock");
    const site = createServer((req, res) => {
      const path = new URL(req.url, "http://localhost").pathname;
      try {
        const file = path.startsWith("/assets/")
          ? resolve(root, "." + path)
          : resolve(root, "index.html");
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
    await new Promise((resolve) => site.listen(5182, "127.0.0.1", resolve));
    const profile = resolve(".local/mock-browser-" + randomUUID());
    mkdirSync(profile, { recursive: true });
    const browser = spawn(
      process.env.BROWSER_BIN ||
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      [
        "--headless=new",
        "--no-first-run",
        "--remote-debugging-port=9230",
        "--user-data-dir=" + profile,
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    let socket;
    t.after(() => {
      socket?.close();
      browser.kill();
      site.closeAllConnections();
      site.close();
    });
    let tab;
    for (let i = 0; i < 60; i++) {
      try {
        tab = (
          await fetch("http://127.0.0.1:9230/json").then((r) => r.json())
        ).find((x) => x.type === "page");
      } catch {}
      if (tab) break;
      await delay(100);
    }
    assert.ok(tab);
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await once(socket, "open");
    let seq = 0;
    const pending = new Map(),
      network = [],
      errors = [];
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.id) {
        const job = pending.get(event.id);
        pending.delete(event.id);
        event.error
          ? job?.reject(new Error(event.error.message))
          : job?.resolve(event.result);
      }
      if (event.method === "Runtime.exceptionThrown")
        errors.push(
          event.params.exceptionDetails.exception?.description ||
            event.params.exceptionDetails.text,
        );
      if (event.method === "Fetch.requestPaused") {
        network.push(event.params.request.url);
        void send("Fetch.failRequest", {
          requestId: event.params.requestId,
          errorReason: "Failed",
        }).catch(() => {});
      }
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Fetch.enable", {
      patterns: [{ urlPattern: "*://localhost:3000/*" }],
    });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (r.exceptionDetails)
        throw new Error(
          r.exceptionDetails.exception?.description || r.exceptionDetails.text,
        );
      return r.result.value;
    };
    const until = async (expression) => {
      for (let i = 0; i < 160; i++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(
        "Timeout: " +
          expression +
          "\n" +
          (await evaluate("document.body.innerText")),
      );
    };
    const fill = async (name, value) => {
      await until(`Boolean(document.querySelector('[name="${name}"]'))`);
      await evaluate(
        `(()=>{const input=document.querySelector('[name="${name}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    };
    const click = async (text) => {
      await until(
        'Array.from(document.querySelectorAll("button")).some(button=>button.textContent.trim()===' +
          JSON.stringify(text) +
          "&&!button.disabled)",
      );
      return evaluate(
        `(()=>{const button=Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Button missing');button.click();})()`,
      );
    };
    const nav = async (path) => {
      await evaluate(`document.querySelector("nav a[href='${path}']").click()`);
      await until(
        `location.pathname===${JSON.stringify(path)}&&Boolean(document.querySelector('.page-title'))`,
      );
    };
    const submit = () =>
      evaluate('document.querySelector("dialog form").requestSubmit()');
    await send("Page.navigate", { url: "http://127.0.0.1:5182/login" });
    await fill("username", "admin");
    await fill("password", "Smart@123456");
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      'location.pathname==="/dashboard"&&Boolean(document.querySelector(".metric-grid"))',
    );
    await nav("/rooms");
    await click("+ Thêm phòng");
    await fill("room_code", "MOCK_NEW");
    await fill("room_name", "Mock new room");
    await submit();
    await until(
      '!document.querySelector("dialog[open]")&&document.body.innerText.includes("Mock new room")',
    );
    await nav("/devices");
    await click("+ Đăng ký thiết bị");
    await fill("device_code", "MOCK_NODE");
    await fill("device_name", "Mock new device");
    await submit();
    await until(
      '!document.querySelector("dialog[open]")&&document.body.innerText.includes("Mock new device")',
    );
    await evaluate(
      `Array.from(document.querySelectorAll('tbody tr')).find(row=>row.innerText.includes('Mock new device')).querySelector('a').click()`,
    );
    await until('document.body.innerText.includes("Ngừng sử dụng")');
    await click("Ngừng sử dụng");
    await fill("reason", "Mock retirement");
    await evaluate('document.querySelector("[name=confirmed]").click()');
    await submit();
    await until(
      '!document.querySelector("dialog[open]")&&document.body.innerText.includes("DECOMMISSIONED")',
    );
    await nav("/alerts");
    await until('document.body.innerText.includes("Xác nhận")');
    await click("Xác nhận");
    await submit();
    await until(
      '!document.querySelector("dialog[open]")&&document.body.innerText.includes("ACKNOWLEDGED")',
    );
    await nav("/ota");
    await click("Upload firmware");
    await fill("version", "mock-2.0");
    await evaluate(
      `(()=>{const select=document.querySelector('[name=device_type]');select.value='SENSOR_NODE';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await fill("hardware_target", "ESP32");
    await evaluate(
      `(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['mock-firmware'],'mock.bin',{type:'application/octet-stream'}));const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await submit();
    await until(
      '!document.querySelector("dialog[open]")&&document.body.innerText.includes("mock-2.0")',
    );
    await click("Phát hành");
    await evaluate('document.querySelector("[name=confirmed]").click()');
    await submit();
    await until(
      '!document.querySelector("dialog[open]")&&document.body.innerText.includes("PUBLISHED")',
    );
    assert.equal(
      await evaluate('document.querySelectorAll("tbody tr").length'),
      1,
    );
    await nav("/control");
    await until(
      'Boolean(document.querySelector(".control-grid button:not(:disabled)"))',
    );
    await click("Tắt");
    await until(
      'document.querySelector(".notice")?.innerText.includes("TIMEOUT")',
    );
    assert.ok(
      await evaluate(
        'document.querySelector(".control-grid .badge")?.textContent==="ON"',
      ),
      "A mock timeout never fabricates a physical state change",
    );
    await nav("/audit-logs");
    await until('document.body.innerText.includes("DEVICE_REGISTER")');
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      ".local/frontend-mock-audit.png",
      Buffer.from(shot.data, "base64"),
    );
    assert.deepEqual(network, []);
    assert.deepEqual(errors, []);
    t.diagnostic(
      "Mock room/device mutations and alert actions update shared mock lists without real HTTP requests",
    );
    await send("Browser.close");
  },
);
