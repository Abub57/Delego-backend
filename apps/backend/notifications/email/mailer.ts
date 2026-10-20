import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpPoolOptions {
  host: string;
  port: number;
  secure: boolean;
  pool: true;
  maxConnections: number;
  maxMessages: number;
  rateLimit: number;
}

const SMTP_HOST = process.env.SMTP_HOST?.trim() ?? "";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "587");
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE.toLowerCase() === "true"
  : SMTP_PORT === 465;
const SMTP_RATE_LIMIT = Number(process.env.SMTP_RATE_LIMIT ?? "100");

export const isSmtpConfigured = SMTP_HOST.length > 0;

function createSmtpTransport(): Transporter | null {
  if (!isSmtpConfigured) return null;
  if (!Number.isInteger(SMTP_PORT) || SMTP_PORT < 1 || SMTP_PORT > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535");
  }
  if (!Number.isInteger(SMTP_RATE_LIMIT) || SMTP_RATE_LIMIT < 1) {
    throw new Error("SMTP_RATE_LIMIT must be a positive integer");
  }

  const options: SmtpPoolOptions & {
    socketTimeout: number;
    auth?: { user: string; pass: string };
  } = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    pool: true,
    maxConnections: 10,
    maxMessages: 100,
    rateLimit: SMTP_RATE_LIMIT,
    socketTimeout: 30_000,
  };

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(pass)) {
    throw new Error("SMTP_USER and SMTP_PASSWORD must be configured together");
  }
  if (user && pass) options.auth = { user, pass };

  const transport = nodemailer.createTransport(options);
  transport.on("error", (error) => {
    process.emitWarning(error, { type: "SmtpPoolError" });
  });

  return transport;
}

const smtpTransport = createSmtpTransport();

export async function sendSmtpEmail(
  message: Parameters<Transporter["sendMail"]>[0]
): Promise<void> {
  if (!smtpTransport) {
    throw new Error("SMTP_HOST is not configured");
  }
  await smtpTransport.sendMail(message);
}

export function closeSmtpPool(): void {
  smtpTransport?.close();
}