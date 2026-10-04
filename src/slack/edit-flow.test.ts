import { describe, expect, it } from "vitest";
import { buildCodexInvocation } from "../runner/argv.js";
import type { EditConfig } from "../runner/config.js";
import { createRunner } from "../runner/runner.js";
import { mockLauncher } from "../runner/test-utils.js";
import { getApproval, getEditRequest, getRun, listPendingMessages, listRunEvents, type Binding, type Store } from "../store/index.js";
import { open, tempDbPath } from "../store/test-utils.js";
import type { EditIngress } from "./edit-flow.js";
import { createEnvelopeHandler } from "./ingress.js";
import { createSender } from "./sender.js";
import { AUTH, BOT_USER, CHANNEL, DM, TEAM, USER, capturingLogger, dmMessage, eventOf, fakeEnvelope, fakeSlackApi, mention } from "./test-fixtures.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TTL = 60 * 60 * 1000;
const PROMPT = "PROMPT-CANARY-31 fix the typo in README.md";

function setup(options: { edit?: Partial<EditIngress> | null; start?: number } = {}) {
  const clock = { t: options.start ?? 1_700_000_000_000 };
  let n = 0;
  const store = open(tempDbPath(), { now: () => clock.t++, randomId: () => `aaa${++n}` });
  const { log, entries } = capturingLogger();
  const config: EditConfig = { channelIds: new Set([DM]), worktreeRoot: "/wt", approvalTtlMs: TTL };
  const edit: EditIngress | undefined =
    options.edit === null ? undefined : { config, repoRoot: "/repo", readBaseSha: () => SHA, ...options.edit };
  const api = fakeSlackApi();
  const sender = createSender({ store, api, teamId: TEAM, log, now: () => clock.t });
  const handle = createEnvelopeHandler({ store, auth: AUTH, botUserId: BOT_USER, log, ...(edit ? { edit } : {}) });
  const send = async (body: unknown) => {
    const envelope = fakeEnvelope(body);
    await handle(envelope);
    return envelope;
  };
  const start = async (text: string, via: "dm" | "channel" = "dm") => {
    const body = via === "dm" ? dmMessage(text) : mention(text);
    await send(body);
    const channelId = via === "dm" ? DM : CHANNEL;
    const binding: Binding = { teamId: TEAM, userId: USER, channelId, rootThreadTs: String(eventOf(body)["ts"]) };
    const run = getRun(store, binding);
    if (!run) throw new Error("no run");
    const inThread = (reply: string) => (via === "dm" ? dmMessage(reply, { event: { thread_ts: binding.rootThreadTs } }) : mention(reply, { event: { thread_ts: binding.rootThreadTs } }));
    return { binding, run, inThread, body };
  };
  const bodies = (): string[] => store.db.prepare("SELECT body FROM outbox_messages ORDER BY id").all().map((r) => String(r["body"]));
  return { store, entries, send, start, sender, api, clock, bodies, edit };
}

const count = (store: Store, table: string): number => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);

describe("an edit task", () => {
  it("waits for approval with a request that shows the prompt, folder, branch, commit and the one command", async () => {
    const ctx = setup();
    const { run, binding } = await ctx.start(`/codex default --edit ${PROMPT}`);
    expect(run.mode).toBe("edit");
    expect(getRun(ctx.store, binding)?.state).toBe("awaiting_approval");
    const request = getEditRequest(ctx.store, binding);
    expect(request).toMatchObject({ baseSha: SHA, expiresAt: request ? request.requestedAt + TTL : 0 });
    const pending = listPendingMessages(ctx.store);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.body).toContain(PROMPT);
    expect(pending[0]?.body).toContain(`Folder: /wt/${run.id}`);
    expect(pending[0]?.body).toContain(`Branch: threadrunner/${run.id}`);
    expect(pending[0]?.body).toContain(SHA);
    expect(pending[0]?.body).toContain(`/approve ${run.id}`);
    expect(count(ctx.store, "approvals")).toBe(0);
  });

  it("never reaches the read-only queue", async () => {
    const ctx = setup();
    const { binding } = await ctx.start(`/codex default --edit ${PROMPT}`);
    const states = listRunEvents(ctx.store, binding).map((e) => e.toState);
    expect(states).toEqual(["received", "validated", "awaiting_approval"]);
  });

  it("a redelivered event does not create a second request", async () => {
    const ctx = setup();
    const body = dmMessage(`/codex default --edit ${PROMPT}`);
    await ctx.send(body);
    await ctx.send(body);
    expect(count(ctx.store, "edit_requests")).toBe(1);
    expect(ctx.bodies()).toHaveLength(1);
  });

  it.each([
    ["edit mode is off", { edit: null }, "dm", "/codex default --edit x", "Edit tasks are not enabled on this bridge."],
    ["the channel is not an edit channel", {}, "channel", "/codex default --edit x", "Edit tasks are not enabled in this channel."],
    ["the provider is not codex", {}, "dm", "/claude default --edit x", "only supported with /codex"],
    ["the repository commit cannot be read", { edit: { readBaseSha: () => null } }, "dm", "/codex default --edit x", "could not read the repository's current commit"],
  ] as const)("is refused with a reason, and fails the run, when %s", async (_name, options, via, text, reason) => {
    const ctx = setup(options as Parameters<typeof setup>[0]);
    const { binding } = await ctx.start(text, via);
    expect(getRun(ctx.store, binding)?.state).toBe("failed");
    expect(count(ctx.store, "edit_requests")).toBe(0);
    const messages = ctx.bodies();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(reason);
    expect(messages[0]).not.toContain("approve");
  });

  it("does not change how read-only tasks work", async () => {
    const ctx = setup();
    const { binding } = await ctx.start(`/codex default ${PROMPT}`);
    expect(getRun(ctx.store, binding)).toMatchObject({ mode: "read", state: "queued" });
    expect(count(ctx.store, "edit_requests")).toBe(0);
  });
});

describe("/approve", () => {
  async function awaiting(ctx: ReturnType<typeof setup>) {
    const started = await ctx.start(`/codex default --edit ${PROMPT}`);
    return started;
  }
  const deliver = async (ctx: ReturnType<typeof setup>) => void (await ctx.sender.drain());

  it("moves the run to queued_write once the request has been delivered, recording who approved what", async () => {
    const ctx = setup();
    const { run, binding, inThread } = await awaiting(ctx);
    await deliver(ctx);
    expect(ctx.api.posts).toHaveLength(1);
    await ctx.send(inThread(`/approve ${run.id}`));
    expect(getRun(ctx.store, binding)?.state).toBe("queued_write");
    expect(getApproval(ctx.store, binding)).toMatchObject({ approvedByUserId: USER, invocationSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(ctx.bodies().at(-1)).toBe(`Approved ${run.id}. It is queued. Reply /cancel to stop it.`);
  });

  it("refuses until the request was actually delivered to Slack", async () => {
    const ctx = setup();
    const { run, binding, inThread } = await awaiting(ctx);
    await ctx.send(inThread(`/approve ${run.id}`));
    expect(getRun(ctx.store, binding)?.state).toBe("awaiting_approval");
    expect(count(ctx.store, "approvals")).toBe(0);
    expect(ctx.bodies().at(-1)).toContain("has not been shown in this thread yet");
  });

  it("a bare yes, a different run ID, and a wrong-thread approval change nothing", async () => {
    const ctx = setup();
    const { run, binding, inThread } = await awaiting(ctx);
    await deliver(ctx);
    await ctx.send(inThread("yes"));
    await ctx.send(inThread("approved"));
    await ctx.send(inThread("/approve run-zzzz"));
    expect(ctx.bodies().at(-1)).toContain(`This thread's run is ${run.id}`);
    // The right ID, but as a new top-level message: no run is bound to it.
    await ctx.send(dmMessage(`/approve ${run.id}`));
    expect(getRun(ctx.store, binding)?.state).toBe("awaiting_approval");
    expect(count(ctx.store, "approvals")).toBe(0);
  });

  it("is silent for anyone who is not the authorized user", async () => {
    const ctx = setup();
    const { run, binding, inThread } = await awaiting(ctx);
    await deliver(ctx);
    const before = ctx.bodies().length;
    const stranger = inThread(`/approve ${run.id}`);
    (eventOf(stranger) as Record<string, unknown>)["user"] = "U0INTRUDER";
    await ctx.send(stranger);
    expect(getRun(ctx.store, binding)?.state).toBe("awaiting_approval");
    expect(ctx.bodies()).toHaveLength(before);
  });

  it("is refused once expired, and the next runner pass closes the run with a notice", async () => {
    const ctx = setup();
    const { run, binding, inThread } = await awaiting(ctx);
    await deliver(ctx);
    ctx.clock.t += TTL;
    await ctx.send(inThread(`/approve ${run.id}`));
    expect(getRun(ctx.store, binding)?.state).toBe("awaiting_approval");
    expect(ctx.bodies().at(-1)).toContain("has expired");

    const runner = createRunner({
      store: ctx.store,
      auth: AUTH,
      repoRoot: "/repo",
      codexBin: "/fake/codex",
      timeoutMs: 10_000,
      launcher: mockLauncher().launcher,
      buildInvocation: buildCodexInvocation,
      log: capturingLogger().log,
      parentEnv: {},
      approvalTtlMs: TTL,
    });
    expect(await runner.tick()).toBe("idle");
    expect(getRun(ctx.store, binding)?.state).toBe("failed");
    expect(ctx.bodies().at(-1)).toContain("approval request expired and nothing was run");
  });

  it("a second /approve and a /cancel race are both safe", async () => {
    const ctx = setup();
    const { run, binding, inThread } = await awaiting(ctx);
    await deliver(ctx);
    await ctx.send(inThread(`/approve ${run.id}`));
    await ctx.send(inThread(`/approve ${run.id}`));
    expect(count(ctx.store, "approvals")).toBe(1);
    expect(ctx.bodies().at(-1)).toContain("is not waiting for approval (it is queued_write)");
    await ctx.send(inThread("/cancel"));
    expect(getRun(ctx.store, binding)?.state).toBe("cancelled");
    await ctx.send(inThread(`/approve ${run.id}`));
    expect(getRun(ctx.store, binding)?.state).toBe("cancelled");
  });

  it("after /cancel the approval is refused and nothing is approved", async () => {
    const ctx = setup();
    const { run, binding, inThread } = await awaiting(ctx);
    await deliver(ctx);
    await ctx.send(inThread("/cancel"));
    await ctx.send(inThread(`/approve ${run.id}`));
    expect(getRun(ctx.store, binding)?.state).toBe("cancelled");
    expect(count(ctx.store, "approvals")).toBe(0);
  });

  it("explains itself on a read-only run and when edit mode is off, without approving anything", async () => {
    const ctx = setup();
    const read = await ctx.start(`/codex default ${PROMPT}`);
    await ctx.send(read.inThread(`/approve ${read.run.id}`));
    expect(ctx.bodies().at(-1)).toContain("is not waiting for approval (it is queued)");

    const off = setup({ edit: null });
    const r = await off.start(`/codex default ${PROMPT}`);
    await off.send(r.inThread(`/approve ${r.run.id}`));
    expect(off.bodies().at(-1)).toContain("edit tasks are not enabled here");
    expect(count(off.store, "approvals")).toBe(0);
  });
});
