// Minimal Alertmanager webhook receiver — logs each fired/resolved alert to stdout.
// In production this is replaced by Slack/PagerDuty/email integrations.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200);
    res.end("alert-sink ready\n");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const payload = JSON.parse(body);
      for (const a of payload.alerts ?? []) {
        const status = a.status; // "firing" or "resolved"
        const name = a.labels?.alertname ?? "unknown";
        const sev = a.labels?.severity ?? "info";
        const tier = a.labels?.tier ?? "-";
        const summary = a.annotations?.summary ?? "";
        // Single-line stdout for easy `docker logs hara-alert-sink` reading
        console.log(
          JSON.stringify({
            t: new Date().toISOString(),
            status,
            severity: sev,
            tier,
            alert: name,
            summary,
            instance: a.labels?.instance ?? null,
          }),
        );
      }
    } catch (err) {
      console.error("parse error:", err.message, body.slice(0, 200));
    }
    res.writeHead(200);
    res.end("ok\n");
  });
});

server.listen(PORT, () => console.log(`alert-sink listening on :${PORT}`));
