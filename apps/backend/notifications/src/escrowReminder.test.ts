import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bullmq", () => ({ Queue: class {}, Worker: class {} }));
vi.mock("ioredis", () => ({ Redis: class {} }));
vi.mock("../email/index.js", () => ({ sendEmail: vi.fn() }));

import {
  enqueueDueReminders,
  findDueReminders,
  processReminder,
  reminderJobId,
  type EscrowReminderJobData,
  type ReminderDb,
} from "./escrowReminder.js";

const NOW = new Date("2026-10-21T00:00:00.000Z");
const ORDER_ID = "11111111-1111-1111-1111-111111111111";

const data = (overrides: Partial<EscrowReminderJobData> = {}): EscrowReminderJobData => ({
  orderId: ORDER_ID,
  buyerEmail: "buyer@example.com",
  merchantName: "Cool Shop",
  escrowDeadline: "2026-10-21T10:00:00.000Z",
  hoursRemaining: 12,
  ...overrides,
});

/** Routes each query to a canned result by a distinctive SQL fragment. */
function fakeDb(opts: { eligible?: boolean; claimable?: boolean; scanRows?: unknown[][] } = {}) {
  const { eligible = true, claimable = true, scanRows = [[], []] } = opts;
  let scan = 0;
  const query = vi.fn(async (text: string) => {
    if (text.includes("FROM orders o\n         JOIN users")) return { rows: scanRows[scan++] ?? [] };
    if (text.includes("SELECT o.user_id")) return { rows: eligible ? [{ user_id: "user-1" }] : [] };
    if (text.includes("INSERT INTO escrow_reminders_sent")) {
      return { rows: claimable ? [{ order_id: ORDER_ID }] : [] };
    }
    return { rows: [] };
  });
  return { query } as unknown as ReminderDb & { query: ReturnType<typeof vi.fn> };
}

describe("reminderJobId", () => {
  it("is deterministic per order and window and has no ':'", () => {
    expect(reminderJobId(ORDER_ID, 48)).toBe(reminderJobId(ORDER_ID, 48));
    expect(reminderJobId(ORDER_ID, 48)).not.toBe(reminderJobId(ORDER_ID, 12));
    expect(reminderJobId(ORDER_ID, 12)).not.toContain(":");
  });
});

describe("findDueReminders / enqueueDueReminders", () => {
  it("scans the 48h window as (12h, 48h] and the 12h window as (0h, 12h]", async () => {
    const db = fakeDb();
    await findDueReminders(db, NOW);
    expect(db.query.mock.calls.map((c) => c[1])).toEqual([
      [NOW.toISOString(), 48, 12],
      [NOW.toISOString(), 12, 0],
    ]);
  });

  it("maps rows to job data with the window's hoursRemaining", async () => {
    const row = {
      order_id: ORDER_ID,
      buyer_email: "buyer@example.com",
      merchant_name: "Cool Shop",
      escrow_deadline: new Date("2026-10-22T00:00:00Z"),
    };
    const due = await findDueReminders(fakeDb({ scanRows: [[row], []] }), NOW);
    expect(due).toEqual([
      {
        orderId: ORDER_ID,
        buyerEmail: "buyer@example.com",
        merchantName: "Cool Shop",
        escrowDeadline: "2026-10-22T00:00:00.000Z",
        hoursRemaining: 48,
      },
    ]);
  });

  it("enqueues one deduplicated job per due reminder", async () => {
    const row = { order_id: ORDER_ID, buyer_email: "b@x.test", merchant_name: "S", escrow_deadline: "2026-10-21T05:00:00Z" };
    const add = vi.fn().mockResolvedValue({});
    const offered = await enqueueDueReminders({ add } as never, fakeDb({ scanRows: [[], [row]] }), NOW);
    expect(offered).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][2]).toMatchObject({ jobId: reminderJobId(ORDER_ID, 12), attempts: 5 });
  });
});

describe("processReminder", () => {
  const send = vi.fn();
  beforeEach(() => send.mockReset().mockResolvedValue(undefined));

  it("skips without claiming or sending when the order is confirmed, disputed or past deadline", async () => {
    const db = fakeDb({ eligible: false });
    expect(await processReminder(data(), { db, sendEmailFn: send, now: () => NOW })).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some((c) => String(c[0]).includes("INSERT INTO escrow_reminders_sent"))).toBe(false);
  });

  it("skips when the reminder was already claimed (sent once)", async () => {
    const db = fakeDb({ claimable: false });
    expect(await processReminder(data(), { db, sendEmailFn: send, now: () => NOW })).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a localized email with a confirmation link and escaped merchant name", async () => {
    const db = fakeDb();
    const outcome = await processReminder(data({ merchantName: "<b>Evil</b> & Co" }), {
      db,
      sendEmailFn: send,
      getUserLocale: async () => "es",
      appBaseUrl: "https://app.delego.test/",
      now: () => NOW,
    });
    expect(outcome).toBe("sent");
    const mail = send.mock.calls[0][0];
    expect(mail.to).toBe("buyer@example.com");
    expect(mail.subject).toContain("Recordatorio");
    expect(mail.text).toContain(`https://app.delego.test/orders/${ORDER_ID}/confirm`);
    expect(mail.html).toContain(`href="https://app.delego.test/orders/${ORDER_ID}/confirm"`);
    expect(mail.html).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp; Co");
    expect(mail.html).not.toContain("<b>Evil</b>");
  });

  it("falls back to English for an unsupported locale", async () => {
    await processReminder(data(), { db: fakeDb(), sendEmailFn: send, getUserLocale: async () => "xx", now: () => NOW });
    expect(send.mock.calls[0][0].subject).toContain("Reminder");
  });

  it("releases the claim and rethrows when the send fails so a retry can send it", async () => {
    const db = fakeDb();
    const failingSend = (async () => {
      throw new Error("smtp down");
    }) as unknown as typeof send;
    const error = await processReminder(data(), { db, sendEmailFn: failingSend, now: () => NOW }).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(error?.message).toBe("smtp down");
    const deletes = db.query.mock.calls.filter((c) => String(c[0]).includes("DELETE FROM escrow_reminders_sent"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual([ORDER_ID, 12]);
  });
});
