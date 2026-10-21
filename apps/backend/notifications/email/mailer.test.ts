import { createServer, type AddressInfo } from "node:net";
import type { Server, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let smtpServer: Server;
let sendSmtpEmail: typeof import("./mailer.js").sendSmtpEmail;
let closeSmtpPool: typeof import("./mailer.js").closeSmtpPool;
let receivedMessages = 0;
let connectionCount = 0;
let activeConnections = 0;
let maxActiveConnections = 0;
let failuresToInject = 0;
let failedConnectionId: number | undefined;
let lastAcceptedConnectionId: number | undefined;

function handleSmtpConnection(socket: Socket): void {
  connectionCount += 1;
  const connectionId = connectionCount;
  activeConnections += 1;
  maxActiveConnections = Math.max(maxActiveConnections, activeConnections);
  socket.write("220 localhost ESMTP\r\n");

  let buffer = "";
  let receivingData = false;
  socket.on("close", () => {
    activeConnections -= 1;
  });
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let lineEnd = buffer.indexOf("\r\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);

      if (receivingData) {
        if (line === ".") {
          receivingData = false;
          receivedMessages += 1;
          lastAcceptedConnectionId = connectionId;
          socket.write("250 2.0.0 queued\r\n");
        }
      } else if (/^(EHLO|HELO)\b/i.test(line)) {
        socket.write("250-localhost\r\n250 PIPELINING\r\n");
      } else if (/^DATA\b/i.test(line)) {
        if (failuresToInject > 0) {
          failuresToInject -= 1;
          failedConnectionId = connectionId;
          socket.destroy();
          return;
        } else {
          receivingData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        }
      } else if (/^(MAIL FROM|RCPT TO|RSET|NOOP)\b/i.test(line)) {
        socket.write("250 2.0.0 ok\r\n");
      } else if (/^QUIT\b/i.test(line)) {
        socket.end("221 2.0.0 bye\r\n");
      }

      lineEnd = buffer.indexOf("\r\n");
    }
  });
}

beforeAll(async () => {
  smtpServer = createServer(handleSmtpConnection);
  await new Promise<void>((resolve) => {
    smtpServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = smtpServer.address() as AddressInfo;
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_SECURE = "false";
  process.env.SMTP_RATE_LIMIT = "1000";
  ({ sendSmtpEmail, closeSmtpPool } = await import("./mailer.js"));
});

afterAll(async () => {
  closeSmtpPool();
  await new Promise<void>((resolve, reject) => {
    smtpServer.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("pooled SMTP mailer", () => {
  it("dispatches 500 messages without exceeding the connection limit", async () => {
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        sendSmtpEmail({
          to: `buyer-${index}@example.test`,
          from: "noreply@example.test",
          subject: "Order receipt",
          text: `Receipt ${index}`,
        })
      )
    );

    expect(receivedMessages).toBe(500);
    expect(connectionCount).toBeGreaterThan(0);
    expect(maxActiveConnections).toBeLessThanOrEqual(10);
  });

  it("replaces a failed SMTP connection and completes delivery", async () => {
    failuresToInject = 1;
    const connectionsBeforeFailure = connectionCount;
    const messagesBeforeFailure = receivedMessages;
    const message = {
      to: "buyer@example.test",
      from: "noreply@example.test",
      subject: "Order receipt",
      text: "Reconnect after failure",
    };

    await expect(sendSmtpEmail(message)).resolves.toBeUndefined();

    expect(failuresToInject).toBe(0);
    expect(receivedMessages).toBe(messagesBeforeFailure + 1);
    expect(failedConnectionId).toBeDefined();
    expect(lastAcceptedConnectionId).not.toBe(failedConnectionId);
    expect(connectionCount).toBeGreaterThanOrEqual(connectionsBeforeFailure);
    expect(maxActiveConnections).toBeLessThanOrEqual(10);
  });
});