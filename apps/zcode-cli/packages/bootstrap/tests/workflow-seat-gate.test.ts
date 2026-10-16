/**
 * run 级座位闸门（docs/dynamic-workflow/concurrency.md「Retuning a live run」）：
 *   - 压低之后，工作中的子代理在**下一个 turn step** 上停驻（tryAcquire 未命中 → runner 发
 *     queued → driver 报 waiting(slot)），acquire 先等座位、再过治理器；
 *   - ask 结算或上界抬高按 FIFO 放行；abort 出队并以 signal.reason 拒绝；
 *   - 工具侧请求永不停驻（按子代理此刻的在飞工具数分辨）；
 *   - `activeAsks = working + parked`；上界 1 也不死锁；
 *   - 从未被压低过的 run 是纯直通：tryAcquire 逐次命中，治理器端口调用次数与没有闸门时相同。
 * 纯单元：不建 driver、不跑引擎，只喂闸门两条事实。
 */

import { describe, expect, it } from "vitest";
import type {
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";
import type { InstanceRef } from "@zcode/dynamic-workflow";
import {
  createWorkflowRunSeatGate,
  type SeatGateSubagent,
  type WorkflowRunSeatGate,
} from "../src/app/workflow-seat-gate.js";

const MODEL = { providerId: "prov", modelId: "alpha" } as ModelRequestTarget;

/** 治理器端口的替身：只数调用次数，永远发得出票。 */
function fakeGovernor(): {
  admission: ModelRequestAdmission;
  tryAcquireCalls: number;
  acquireCalls: number;
} {
  const ticket = { release: () => {} } as unknown as ModelRequestAdmissionTicket;
  const state = {
    tryAcquireCalls: 0,
    acquireCalls: 0,
    admission: {
      tryAcquire: () => {
        state.tryAcquireCalls++;
        return ticket;
      },
      acquire: async () => {
        state.acquireCalls++;
        return ticket;
      },
    } satisfies ModelRequestAdmission,
  };
  return state;
}

/** 一个子代理的替身：在飞工具数可手动拨动（0 = 它的下一个请求是 turn step）。 */
function fakeSubagent(toolsInFlight = 0): SeatGateSubagent & { tools: number } {
  const subagent = {
    tools: toolsInFlight,
    toolsInFlight: () => subagent.tools,
  };
  return subagent;
}

const instanceOf = (ordinal: number): InstanceRef => ({ siteId: "ask#1", ordinal });

/** 放行是解开一个 promise：让它的 then 链跑完（acquire 自身也是 async，不止一跳）。 */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** 把 n 个子代理登记成「工作中」，并各自包一份准入端口。 */
function seatWorkers(gate: WorkflowRunSeatGate, count: number) {
  return Array.from({ length: count }, (_unused, index) => {
    const key = `actor#1@${index + 1}`;
    const instance = instanceOf(index + 1);
    const governor = fakeGovernor();
    const subagent = fakeSubagent();
    gate.askStarted(key, instance);
    return {
      key,
      instance,
      governor,
      subagent,
      admission: gate.wrap(key, subagent, governor.admission)!,
    };
  });
}

describe("workflow seat gate", () => {
  it("从未被压低过的 run 是纯直通：tryAcquire 逐次命中，治理器照常收到每一次调用", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 4 });
    const workers = seatWorkers(gate, 4);
    for (const worker of workers) {
      expect(worker.admission.tryAcquire?.({ model: MODEL })).toBeDefined();
      await worker.admission.acquire({ model: MODEL });
    }
    expect(gate.stats()).toEqual({ limit: 4, working: 4, parked: 0 });
    for (const worker of workers) {
      expect(worker.governor.tryAcquireCalls).toBe(1);
      expect(worker.governor.acquireCalls).toBe(1);
    }
  });

  it("没有治理器端口时闸门也不凭空造一个（两条闸门要么一起在、要么一起不在）", () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    expect(gate.wrap("actor#1@1", fakeSubagent(), undefined)).toBeUndefined();
  });

  it("压低 4→1：三个在下一个 turn step 上停驻，一个始终在跑，activeAsks = working + parked", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 4 });
    const workers = seatWorkers(gate, 4);
    gate.setLimit(1);

    const parked: Promise<unknown>[] = [];
    for (const worker of workers) {
      // 快路径未命中正是 runner 发 `model_request_queued` 的条件 → driver 报 waiting(slot)。
      if (gate.stats().working > 1) {
        expect(worker.admission.tryAcquire?.({ model: MODEL })).toBeUndefined();
        parked.push(worker.admission.acquire({ model: MODEL }));
      } else {
        expect(worker.admission.tryAcquire?.({ model: MODEL })).toBeDefined();
      }
    }

    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });
    // 每个停驻者都还没碰到治理器：座位在前、治理器在后。
    expect(workers.slice(0, 3).every((worker) => worker.governor.acquireCalls === 0)).toBe(true);
    // activeAsks（调度器那一侧）= 4 = working + parked，所以调度器此刻一个新 ask 也派不出去。
    expect(gate.stats().working + gate.stats().parked).toBe(4);
    expect(parked.length).toBe(3);
  });

  it("上界 1、5 个在工作：恰好 4 个停驻，总有一个在跑（任何上界都不死锁）", () => {
    const gate = createWorkflowRunSeatGate({ limit: 5 });
    const workers = seatWorkers(gate, 5);
    gate.setLimit(1);
    const missed: string[] = [];
    for (const worker of workers) {
      if (worker.admission.tryAcquire?.({ model: MODEL }) === undefined) {
        missed.push(worker.key);
        void worker.admission.acquire({ model: MODEL });
      }
    }
    expect(missed).toEqual(workers.slice(0, 4).map((worker) => worker.key));
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 4 });
  });

  it("ask 结算按 FIFO 放行队首，并且只放一位", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const granted: string[] = [];
    for (const worker of workers.slice(0, 2)) {
      void worker.admission.acquire({ model: MODEL }).then(() => granted.push(worker.key));
    }
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });

    gate.askSettled(workers[2]!.instance);
    await flush();
    expect(granted).toEqual([workers[0]!.key]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    gate.askSettled(workers[0]!.instance);
    await flush();
    expect(granted).toEqual([workers[0]!.key, workers[1]!.key]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 0 });
  });

  it("抬高上界按 FIFO 放行到新上界为止；两次抬高各放一批", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 4 });
    const workers = seatWorkers(gate, 4);
    gate.setLimit(1);
    const granted: string[] = [];
    for (const worker of workers.slice(0, 3)) {
      void worker.admission.acquire({ model: MODEL }).then(() => granted.push(worker.key));
    }
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });

    gate.setLimit(2);
    await flush();
    expect(granted).toEqual([workers[0]!.key]);

    gate.setLimit(4);
    await flush();
    expect(granted).toEqual([workers[0]!.key, workers[1]!.key, workers[2]!.key]);
    expect(gate.stats()).toEqual({ limit: 4, working: 4, parked: 0 });
  });

  it("停驻期间 abort：出队、以 signal.reason 拒绝，并**回到 working**（不在 parked 即在工作）", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const controller = new AbortController();
    const reason = new Error("workflow ask cancelled");
    const aborted = workers[0]!.admission.acquire({ model: MODEL, signal: controller.signal });
    void workers[1]!.admission.acquire({ model: MODEL });
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });

    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    // 回到 working：一时超过上界是合法瞬态，下一个提出 turn 请求的人照常停驻。
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 1 });
  });

  // abort 的是**这次请求**，不一定是这个 ask（driver 的瞬态重驱、流恢复都会这样）。ask 还活着，
  // 它此后的每一个 turn step 就必须照旧过座位——否则这一位再也不被计入，上界会悄悄往上漂。
  it("只是请求被 abort、ask 还活着：下一个 turn step 照旧受闸门约束并被计数", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const controller = new AbortController();
    const aborted = workers[0]!.admission.acquire({ model: MODEL, signal: controller.signal });
    void workers[1]!.admission.acquire({ model: MODEL });
    controller.abort(new Error("request aborted"));
    await expect(aborted).rejects.toThrow();
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 1 });

    // 同一个子代理的下一次 turn 请求：快路径未命中、随后停驻，计数收敛回上界。
    expect(workers[0]!.admission.tryAcquire?.({ model: MODEL })).toBeUndefined();
    void workers[0]!.admission.acquire({ model: MODEL });
    await flush();
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });
    expect(workers[0]!.governor.acquireCalls).toBe(0);
  });

  it("abort 之后 ask 才真的结算：腾掉它自己那一份，绝不放出一个它从未占过的座位", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const granted: string[] = [];
    const controller = new AbortController();
    const aborted = workers[0]!.admission.acquire({ model: MODEL, signal: controller.signal });
    void workers[1]!.admission.acquire({ model: MODEL }).then(() => granted.push(workers[1]!.key));
    controller.abort(new Error("workflow ask cancelled"));
    await expect(aborted).rejects.toThrow();
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 1 });

    gate.askSettled(workers[0]!.instance);
    await flush();
    // working 2 → 1 = 上界：unpark 的 `working.size < limit` 守卫挡住了那一次放行。
    expect(granted).toEqual([]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    // 真正在跑的那个结算才轮到队首。
    gate.askSettled(workers[2]!.instance);
    await flush();
    expect(granted).toEqual([workers[1]!.key]);
  });

  it("已经 aborted 的 signal：当场拒绝，不进 FIFO，也从未离开 working", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    const workers = seatWorkers(gate, 2);
    gate.setLimit(1);
    const reason = new Error("already gone");
    await expect(
      workers[0]!.admission.acquire({ model: MODEL, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 0 });
  });

  it("停驻者的 ask 反序结算（先 node-settled 后 abort）：出队、拒绝等待、不腾座位", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    const workers = seatWorkers(gate, 2);
    gate.setLimit(1);
    const waiting = workers[0]!.admission.acquire({ model: MODEL });
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    gate.askSettled(workers[0]!.instance);
    await expect(waiting).rejects.toThrow(/concurrency seat/);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 0 });
  });

  it("工具侧请求永不停驻：有工具在跑就直通治理器，工具跑完后的 turn step 才过座位", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const busy = workers[0]!;
    busy.subagent.tools = 2; // 一轮里并行的两次 WebSearch

    expect(busy.admission.tryAcquire?.({ model: MODEL })).toBeDefined();
    await busy.admission.acquire({ model: MODEL });
    expect(busy.governor.acquireCalls).toBe(1);
    expect(gate.stats()).toEqual({ limit: 1, working: 3, parked: 0 });

    busy.subagent.tools = 0; // 工具都回来了，下一次请求是这个 ask 的下一个 turn step
    expect(busy.admission.tryAcquire?.({ model: MODEL })).toBeUndefined();
    void busy.admission.acquire({ model: MODEL });
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 1 });
  });

  it("没有在飞 ask 的子代理（会话初始化、压缩）从不停驻", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    seatWorkers(gate, 2);
    gate.setLimit(1);
    const governor = fakeGovernor();
    const outsider = gate.wrap("actor#9@1", fakeSubagent(), governor.admission)!;

    expect(outsider.tryAcquire?.({ model: MODEL })).toBeDefined();
    await outsider.acquire({ model: MODEL });
    expect(governor.acquireCalls).toBe(1);
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 0 });
  });

  it("闸门没见过开始的实例结算是**严格**无操作：不腾座位、不放行", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    const workers = seatWorkers(gate, 2);
    gate.setLimit(1);
    const granted: string[] = [];
    void workers[0]!.admission.acquire({ model: MODEL }).then(() => granted.push(workers[0]!.key));
    await flush();
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    // 三种从不经 startAsk 的 `node-settled`：命中缓存的 ask（`cached: true`，没有 queued/dispatched）、
    // world-read / world.run 节点（另一套站点），以及会话创建失败而从未派发的那一个。
    gate.askSettled({ siteId: "ask#1", ordinal: 99 });
    gate.askSettled({ siteId: "world#3", ordinal: 1 });
    gate.askSettled({ siteId: "run#2", ordinal: 1 });
    await flush();
    expect(granted).toEqual([]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });
  });

  // 调度器在 pumpActor 就 activeAsks++，而闸门要等 driver.startAsk 才把人算进 working——夹在
  // 中间的是 `ensureSession`（建 actor 会话、落库、建 task link）。压低正好落在这个窗口里时，
  // 那个子代理随后的 startAsk 会让 working 再次越过上界，它的第一个 turn step 因此必须停驻。
  it("压低落在 ensureSession 窗口里：后到的子代理照样停驻，没有人被停驻两次，计数收敛到上界", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const granted: string[] = [];
    for (const worker of workers.slice(0, 2)) {
      void worker.admission.acquire({ model: MODEL }).then(() => granted.push(worker.key));
    }
    await flush();
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });

    // 第四个子代理此刻才从 ensureSession 里出来（它的 activeAsks 早在压低之前就记上了）。
    const late = "actor#1@4";
    const lateGovernor = fakeGovernor();
    const lateSubagent = fakeSubagent();
    const lateAdmission = gate.wrap(late, lateSubagent, lateGovernor.admission)!;
    gate.askStarted(late, instanceOf(4));
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 2 });

    expect(lateAdmission.tryAcquire?.({ model: MODEL })).toBeUndefined();
    void lateAdmission.acquire({ model: MODEL }).then(() => granted.push(late));
    await flush();
    // 三个人排在队里，一个人在跑：working 收敛回上界，谁都没有被数两次。
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });
    expect(lateGovernor.acquireCalls).toBe(0);

    // 在跑的那个结算：队首放行，队列减一，working 仍是上界。
    gate.askSettled(workers[2]!.instance);
    await flush();
    expect(granted).toEqual([workers[0]!.key]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });
  });

  it("同一个 actor 接连两个 ask：加入是幂等的，不会把一个人数成两个", () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    gate.askStarted("actor#1@1", instanceOf(1));
    gate.askSettled(instanceOf(1));
    gate.askStarted("actor#1@1", instanceOf(2));
    gate.askStarted("actor#1@1", instanceOf(3));
    expect(gate.stats()).toEqual({ limit: 2, working: 1, parked: 0 });
  });
});
