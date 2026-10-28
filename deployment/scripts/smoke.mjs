import "dotenv/config";
const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
try {
  for (const path of ["/health", "/ready"]) if (!(await fetch(base + path)).ok) throw new Error("NOT_READY");
  const login = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
  if (!login.ok) throw new Error("LOGIN_FAILED");
  const { data } = await login.json(); const headers = { Authorization: `Bearer ${data.access_token}` };
  for (const path of ["/auth/me", "/dashboard", "/audit-logs"]) if (!(await fetch(base + "/api/v1" + path, { headers })).ok) throw new Error("API_FAILED");
  if (!(await fetch(base + "/api/v1/auth/logout", { method: "POST", headers })).ok) throw new Error("LOGOUT_FAILED");
  console.log(JSON.stringify({ health: true, readiness: true, login: true, dashboard: true, audit: true, logout: true }));
} catch { console.error(JSON.stringify({ error: "SMOKE_FAILED" })); process.exitCode = 1; }
