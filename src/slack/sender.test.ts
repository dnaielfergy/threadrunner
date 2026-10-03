import { describe, expect, it, vi } from "vitest";
import {
  MAX_OUTBOX_ATTEMPTS,
  MAX_OUTBOX_BODY_LENGTH,
  createRunFromEvent,
  enqueueMessage,
  getMessageStatus,
  transitionRun,
  type Binding,
} from "../store/index.js";
import { BINDING, fakeClock, fakeIds, newRun, open, tempDbPath } from "../store/test-utils.js";
import { buildPostRequest, escapeSlackText } from "./format.js";
import { createSender, TRANSIENT_BUDGET_MS } from "./sender.js";
import type { PostResult } from "./transport.js";
import { TEAM, capturingLogger, fakeSlackApi } from "./test-fixtures.js";

const EVIL = "<!channel> <!here> <@U0AAAAAAA> <#C0AAAAAAA> <https://evil.example|Click here> a&b &lt;ok&gt;";

function setup(api = fakeSlackApi(), options: { teamId?: string; textLimit?: number } = {}) {
  const store = open(tempDbPath(), { now: fakeClock(), randomId: fakeIds() });
  const { log, entries } = capturingLogger();
  let time = 1_000_000;
  const clock = { now: () => time, advance: (ms: number) => void (time += ms) };
  const sender = createSender({ store, api, teamId: options.teamId ?? TEAM, log, now: clock.now, ...(options.textLimit ? { textLimit: options.textLimit } : {}) });
  const makeRun = (overrides: Parameters<typeof newRun>[0] = {}) => {
    const created = createRunFromEvent(store, newRun(overrides));
    if (created.status !== "created") throw new Error("setup");
    return created.run;
  };
  return { store, sender, api, entries, clock, makeRun };
}

describe("posting", () => {
  it("escapes markup and sets every safety flag, exactly", async () => {
    const ctx = setup();
    const run = ctx.makeRun();
    enqueueMessage(ctx.store, run.id, EVIL);
    expect(await ctx.sender.drain()).toEqual({ sent: 1, failed: 0, deferred: 0, skipped: 0 });
    expect(ctx.api.posts).toEqual([
      {
        channel: BINDING.channelId,
        thread_ts: BINDING.rootThreadTs,
        text: "&lt;!channel&gt; &lt;!here&gt; &lt;@U0AAAAAAA&gt; &lt;#C0AAAAAAA&gt; &lt;https://evil.example|Click here&gt; a&amp;b &amp;lt;ok&amp;gt;",
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      },
    ]);
    expect(ctx.api.posts[0]?.text).not.toMatch(/[<>]/);
  });

  it("marks the message sent after a successful post, and does not post it again", async () => {
    const ctx = setup();
    const run = ctx.makeRun();
    const queued = enqueueMessage(ctx.store, run.id, "hello");
    if (!queued.ok) throw new Error("setup");
    await ctx.sender.drain();
    expect(getMessageStatus(ctx.store, queued.messageId)?.status).toBe("sent");
    await ctx.sender.drain();
    expect(ctx.api.posts).toHaveLength(1);
  });

  it("takes the destination only from the claimed message: each run's own channel and thread", async () => {
    const ctx = setup();
    const a = ctx.makeRun();
    const other: Binding = { ...BINDING, channelId: "D0BBBBBBB", rootThreadTs: "1700000050.000100" };
    const b = ctx.makeRun({ ...other, eventId: "Ev0AAAAAAA2", messageTs: other.rootThreadTs });
    enqueueMessage(ctx.store, a.id, "to a");
    enqueueMessage(ctx.store, b.id, "to b");
    await ctx.sender.drain();
    const byText = Object.fromEntries(ctx.api.posts.map((p) => [p.text, [p.channel, p.thread_ts]]));
    expect(byText).toEqual({ "to a": [BINDING.channelId, BINDING.rootThreadTs], "to b": ["D0BBBBBBB", "1700000050.000100"] });
  });

  it("delivers a run's messages in order, one at a time", async () => {
    const ctx = setup();
    const run = ctx.makeRun();
    for (const body of ["one", "two", "three"]) enqueueMessage(ctx.store, run.id, body);
    await ctx.sender.drain();
    await ctx.sender.drain();
    await ctx.sender.drain();
    expect(ctx.api.posts.map((p) => p.text)).toEqual(["one", "two", "three"]);
  });

  it("refuses to post to a workspace other than the configured one", async () => {
    const ctx = setup(fakeSlackApi(), { teamId: "T0OTHEROO" });
    const run = ctx.makeRun();
    const queued = enqueueMessage(ctx.store, run.id, "hello");
    if (!queued.ok) throw new Error("setup");
    expect(await ctx.sender.drain()).toMatchObject({ sent: 0, failed: 1 });
    expect(ctx.api.posts).toEqual([]);
    // It can never succeed, so it is failed at once rather than spending retries.
    expect(getMessageStatus(ctx.store, queued.messageId)?.status).toBe("failed");
  });

  it("never logs message bodies", async () => {
    const ctx = setup(fakeSlackApi({ ok: false, reason: "network" }));
    const run = ctx.makeRun();
    enqueueMessage(ctx.store, run.id, "BODY-CANARY");
    await ctx.sender.drain();
    expect(ctx.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(ctx.entries)).not.toContain("CANARY");
  });
});

describe("cancellation races", () => {
  it("a run cancelled between listing and claiming is not posted to", async () => {
    // Messages for runs A and B are listed together. While A's post is in flight, B is cancelled.
    // The sender must re-check at claim time and skip B's message.
    let cancelB: () => void = () => {};
    const api = fakeSlackApi(() => {
      cancelB();
      return { ok: true };
    });
    const ctx = setup(api);
    const a = ctx.makeRun();
    const bBinding: Binding = { ...BINDING, rootThreadTs: "1700000060.000100" };
    const b = ctx.makeRun({ ...bBinding, eventId: "Ev0AAAAAAA2", messageTs: bBinding.rootThreadTs });
    enqueueMessage(ctx.store, a.id, "message for A");
    enqueueMessage(ctx.store, b.id, "message for B");
    cancelB = () => void transitionRun(ctx.store, bBinding, "received", "cancelled");

    // B's message was listed, then cancelled while A's post was in flight: the claim refuses it.
    expect(await ctx.sender.drain()).toEqual({ sent: 1, failed: 0, deferred: 0, skipped: 1 });
    expect(api.posts.map((p) => p.text)).toEqual(["message for A"]);
    expect(ctx.entries.map((e) => e.code)).toContain("claim_refused:not_pending");
    // Only the cancellation acknowledgement, created by the cancel itself, goes out afterwards.
    await ctx.sender.drain();
    expect(api.posts.map((p) => p.text)).toEqual(["message for A", "Run cancelled."]);
  });

  it("a run cancelled before the pass has its pending messages dropped but still gets the cancellation acknowledgement", async () => {
    const ctx = setup();
    const run = ctx.makeRun();
    enqueueMessage(ctx.store, run.id, "never sent");
    transitionRun(ctx.store, BINDING, "received", "cancelled");
    await ctx.sender.drain();
    expect(ctx.api.posts.map((p) => p.text)).toEqual(["Run cancelled."]);
  });
});

describe("failures", () => {
  it.each(["slack_error", "unknown"] as const)("a %s failure uses an attempt, is recorded as a reason code, and retries after a backoff", async (reason) => {
    const ctx = setup(fakeSlackApi({ ok: false, reason }));
    const run = ctx.makeRun();
    const queued = enqueueMessage(ctx.store, run.id, "hello");
    if (!queued.ok) throw new Error("setup");
    expect(await ctx.sender.drain()).toMatchObject({ failed: 1 });
    expect(ctx.store.db.prepare("SELECT last_error FROM outbox_messages WHERE id = ?").get(queued.messageId)?.["last_error"]).toBe(reason);
    expect(getMessageStatus(ctx.store, queued.messageId)?.attempts).toBe(1);
    expect(await ctx.sender.drain()).toMatchObject({ skipped: 1, failed: 0 });
    expect(ctx.api.posts).toHaveLength(1);
    ctx.clock.advance(5000);
    await ctx.sender.drain();
    expect(ctx.api.posts).toHaveLength(2);
  });

  it("gives up after the attempt limit for non-transient failures", async () => {
    const ctx = setup(fakeSlackApi({ ok: false, reason: "slack_error" }));
    const run = ctx.makeRun();
    const queued = enqueueMessage(ctx.store, run.id, "hello");
    if (!queued.ok) throw new Error("setup");
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS + 2; i++) {
      await ctx.sender.drain();
      ctx.clock.advance(120_000);
    }
    expect(ctx.api.posts).toHaveLength(MAX_OUTBOX_ATTEMPTS);
    expect(getMessageStatus(ctx.store, queued.messageId)?.status).toBe("failed");
  });

  describe("network and rate-limit failures (laptop sleep, Wi-Fi drop)", () => {
    function flaky() {
      let result: PostResult = { ok: false, reason: "network" };
      const api = fakeSlackApi(() => result);
      return { api, set: (next: PostResult) => void (result = next) };
    }

    it("do not use up attempts inside the time budget, and the message is delivered once the network returns", async () => {
      const net = flaky();
      const ctx = setup(net.api);
      const queued = enqueueMessage(ctx.store, ctx.makeRun().id, "Queued as run-aaa1.");
      if (!queued.ok) throw new Error("setup");

      // About 25 minutes of outage (5 tries, each after the 5 minute cap), inside the 30 minute budget.
      for (let i = 0; i < 5; i++) {
        expect(await ctx.sender.drain()).toMatchObject({ deferred: 1, failed: 0 });
        ctx.clock.advance(5 * 60_000);
      }
      expect(getMessageStatus(ctx.store, queued.messageId)).toMatchObject({ status: "pending", attempts: 0 });

      net.set({ ok: true });
      expect(await ctx.sender.drain()).toMatchObject({ sent: 1 });
      expect(getMessageStatus(ctx.store, queued.messageId)?.status).toBe("sent");
    });

    it("stay pending in the database, so a restart does not lose the message", async () => {
      const net = flaky();
      const first = setup(net.api);
      const queued = enqueueMessage(first.store, first.makeRun().id, "hello");
      if (!queued.ok) throw new Error("setup");
      await first.sender.drain();
      // A new sender (a restart) has no in-memory state and simply tries again.
      const second = createSender({ store: first.store, api: fakeSlackApi(), teamId: TEAM, log: capturingLogger().log, now: () => 5_000_000 });
      expect(await second.drain()).toMatchObject({ sent: 1 });
    });

    it("start using attempts only after the budget is spent", async () => {
      const ctx = setup(flaky().api);
      const queued = enqueueMessage(ctx.store, ctx.makeRun().id, "hello");
      if (!queued.ok) throw new Error("setup");
      await ctx.sender.drain();
      ctx.clock.advance(TRANSIENT_BUDGET_MS + 1);
      expect(await ctx.sender.drain()).toMatchObject({ failed: 1, deferred: 0 });
      expect(getMessageStatus(ctx.store, queued.messageId)?.attempts).toBe(1);
    });

    it("back off exponentially up to five minutes", async () => {
      const ctx = setup(flaky().api);
      enqueueMessage(ctx.store, ctx.makeRun().id, "hello");
      const waits: number[] = [];
      for (let i = 0; i < 8; i++) {
        await ctx.sender.drain();
        let waited = 0;
        while ((await ctx.sender.drain()).skipped === 1) {
          ctx.clock.advance(1000);
          waited += 1000;
          if (waited > 10 * 60_000) break;
        }
        waits.push(waited);
      }
      expect(waits[0]).toBeGreaterThanOrEqual(1000);
      expect(waits.at(-1)).toBeLessThanOrEqual(5 * 60_000 + 1000);
      expect(waits.at(-1)).toBeGreaterThan(waits[0] ?? 0);
    });

    it("honor Retry-After when Slack sends one", async () => {
      const ctx = setup(fakeSlackApi({ ok: false, reason: "rate_limited", retryAfterSeconds: 120 }));
      enqueueMessage(ctx.store, ctx.makeRun().id, "hello");
      await ctx.sender.drain();
      ctx.clock.advance(119_000);
      expect(await ctx.sender.drain()).toMatchObject({ skipped: 1 });
      expect(ctx.api.posts).toHaveLength(1);
      ctx.clock.advance(1000);
      await ctx.sender.drain();
      expect(ctx.api.posts).toHaveLength(2);
    });

    it("cap an absurd Retry-After at fifteen minutes", async () => {
      const ctx = setup(fakeSlackApi({ ok: false, reason: "rate_limited", retryAfterSeconds: 86_400 }));
      enqueueMessage(ctx.store, ctx.makeRun().id, "hello");
      await ctx.sender.drain();
      ctx.clock.advance(15 * 60_000);
      await ctx.sender.drain();
      expect(ctx.api.posts).toHaveLength(2);
    });
  });

  it("a throwing transport is recorded as `unknown`, never propagated or logged", async () => {
    const api = fakeSlackApi();
    api.postMessage = async () => {
      throw new Error("ECONNRESET https://hooks.example/SECRET-CANARY");
    };
    const ctx = setup(api);
    const run = ctx.makeRun();
    enqueueMessage(ctx.store, run.id, "hello");
    await expect(ctx.sender.drain()).resolves.toMatchObject({ failed: 1 });
    expect(JSON.stringify(ctx.entries)).not.toContain("CANARY");
  });

  it("an escaped body over the limit is not posted (not truncated); the worst case at the outbox cap still fits", async () => {
    const tight = setup(fakeSlackApi(), { textLimit: 50 });
    const run = tight.makeRun();
    enqueueMessage(tight.store, run.id, "&".repeat(20)); // escapes to 100 characters
    expect(await tight.sender.drain()).toMatchObject({ sent: 0, failed: 1 });
    expect(tight.api.posts).toEqual([]);
    expect(tight.store.db.prepare("SELECT status FROM outbox_messages").get()?.["status"]).toBe("failed");

    const worst = "&".repeat(MAX_OUTBOX_BODY_LENGTH);
    expect(escapeSlackText(worst).length).toBe(MAX_OUTBOX_BODY_LENGTH * 5);
    const ctx = setup();
    enqueueMessage(ctx.store, ctx.makeRun().id, worst);
    expect(await ctx.sender.drain()).toMatchObject({ sent: 1 });
  });

  it("passes never overlap: concurrent drains post each message once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = fakeSlackApi(async () => {
      await gate;
      return { ok: true };
    });
    const ctx = setup(api);
    enqueueMessage(ctx.store, ctx.makeRun().id, "once");
    const first = ctx.sender.drain();
    const second = ctx.sender.drain();
    release();
    await Promise.all([first, second]);
    expect(api.posts).toHaveLength(1);
  });
});

describe("stop", () => {
  it("waits for a post in flight and marks it sent, so shutdown cannot cause a re-post", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = fakeSlackApi(async () => {
      await gate;
      return { ok: true };
    });
    const ctx = setup(api);
    const queued = enqueueMessage(ctx.store, ctx.makeRun().id, "in flight");
    if (!queued.ok) throw new Error("setup");
    const draining = ctx.sender.drain();
    await vi.waitFor(() => expect(api.posts).toHaveLength(1));

    let stopped = false;
    const stopping = ctx.sender.stop().then(() => void (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false); // still waiting on the post

    release();
    await Promise.all([draining, stopping]);
    expect(stopped).toBe(true);
    expect(api.posts).toHaveLength(1);
    expect(getMessageStatus(ctx.store, queued.messageId)?.status).toBe("sent");
  });

  it("does not start another message after stop, and later drains do nothing", async () => {
    let sender: ReturnType<typeof setup>["sender"] | undefined;
    const api = fakeSlackApi(async () => {
      void sender?.stop();
      return { ok: true };
    });
    const ctx = setup(api);
    sender = ctx.sender;
    const a = ctx.makeRun();
    const bBinding: Binding = { ...BINDING, rootThreadTs: "1700000070.000100" };
    const b = ctx.makeRun({ ...bBinding, eventId: "Ev0AAAAAAA2", messageTs: bBinding.rootThreadTs });
    enqueueMessage(ctx.store, a.id, "first");
    enqueueMessage(ctx.store, b.id, "second");
    await ctx.sender.drain();
    expect(api.posts.map((p) => p.text)).toEqual(["first"]);
    expect(await ctx.sender.drain()).toEqual({ sent: 0, failed: 0, deferred: 0, skipped: 0 });
    expect(api.posts).toHaveLength(1);
  });
});

describe("escapeSlackText / buildPostRequest", () => {
  it("escapes ampersand first, so entities are not double-escaped", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
  });

  it("returns null for an empty or oversized body", () => {
    const destination = { teamId: TEAM, channelId: BINDING.channelId, threadTs: BINDING.rootThreadTs };
    expect(buildPostRequest(destination, "")).toBeNull();
    expect(buildPostRequest(destination, "x".repeat(11), 10)).toBeNull();
    expect(buildPostRequest(destination, "<".repeat(5), 10)).toBeNull();
    expect(buildPostRequest(destination, "x".repeat(10), 10)).not.toBeNull();
  });
});
