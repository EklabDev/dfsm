import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrderExpressApp } from "../../examples/06-express-api-server/server.js";

describe("Example 06 — Full End-to-End Express REST API Server", () => {
  let baseUrl = "";
  let capturedLogs: string[] = [];
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    capturedLogs = [];
    const setup = await createOrderExpressApp({
      logSink: (line) => capturedLogs.push(line),
    });
    const httpServer = await new Promise<ReturnType<typeof setup.app.listen>>((resolve) => {
      const srv = setup.app.listen(0, "127.0.0.1", () => resolve(srv));
    });
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    closeServer = async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
      await setup.shutdown();
    };
  });

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
    }
  });

  async function requestJson(path: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json()) as Record<string, any>;
    return { status: res.status, body };
  }

  it("steps through transitions 1-by-1 over HTTP and returns live FSM status + YAML on every step", async () => {
    // 0. Inspect GET /api/machine
    const machineRes = await requestJson("/api/machine");
    expect(machineRes.status).toBe(200);
    expect(machineRes.body.machineId).toBe("express-order-fulfillment");
    expect(machineRes.body.yaml).toContain('id: express-order-fulfillment');
    const authPolicy = machineRes.body.effectiveConfig.transitions.find(
      (t: any) => t.event === "AUTHORIZE_PAYMENT"
    );
    expect(authPolicy.policy.retry.maxAttempts).toBe(3); // Decorator @Retry(3) overrode YAML retry: 2

    // 1. Create order -> initial 'created' state + YAML inside response
    const createRes = await requestJson("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        transactionId: "order-e2e-1",
        customerEmail: "alice@eklab.dev",
      }),
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.currentState).toBe("created");
    expect(createRes.body.status).toBe("IDLE");
    expect(createRes.body.availableEvents).toEqual(["SUBMIT_ORDER", "CANCEL_ORDER"]);
    expect(createRes.body.yaml).toContain("type: parallel");

    // 1b. Check GET /api/orders -> order-e2e-1 is IDLE (non-terminal!), so nonTerminalCount === 1
    //     and terminalStates lists ["delivered", "cancelled", "error"]
    const listWhileOpen = await requestJson("/api/orders");
    expect(listWhileOpen.status).toBe(200);
    expect(listWhileOpen.body.nonTerminalCount).toBe(1);
    expect(listWhileOpen.body.terminalCount).toBe(0);
    expect(listWhileOpen.body.activeOrders).toHaveLength(1);
    expect(listWhileOpen.body.activeOrders[0].transactionId).toBe("order-e2e-1");
    expect(listWhileOpen.body.activeOrders[0].availableEvents).toEqual([
      "SUBMIT_ORDER",
      "CANCEL_ORDER",
    ]);
    expect(listWhileOpen.body.terminalStates.topLevelTerminalStates).toEqual([
      "delivered",
      "cancelled",
      "error",
    ]);

    // 2. Step 1: SUBMIT_ORDER -> 'inventory_reserved'
    const step1 = await requestJson("/api/orders/order-e2e-1/transitions", {
      method: "POST",
      body: JSON.stringify({
        event: "SUBMIT_ORDER",
        input: {
          items: [{ sku: "KB-PRO", quantity: 2, unitPriceCents: 7500 }],
        },
      }),
    });
    expect(step1.status).toBe(200);
    expect(step1.body.currentState).toBe("inventory_reserved");
    expect(step1.body.status).toBe("IDLE");
    expect(step1.body.context.totalCents).toBe(15000);
    expect(step1.body.context.inventoryReserved).toBe(true);
    expect(step1.body.compensationStack).toHaveLength(1);
    expect(step1.body.yaml).toContain("express-order-fulfillment");

    // 3. Step 2: AUTHORIZE_PAYMENT -> enters parallel 'fulfilling'
    const step2 = await requestJson("/api/orders/order-e2e-1/transitions", {
      method: "POST",
      body: JSON.stringify({
        event: "AUTHORIZE_PAYMENT",
        input: { paymentMethod: "visa_4242" },
      }),
    });
    expect(step2.status).toBe(200);
    expect(step2.body.currentState).toEqual({
      fulfilling: {
        packaging: "packing",
        shipping: "booking_carrier",
      },
    });
    expect(step2.body.availableEvents).toEqual(["PACK_COMPLETE", "BOOK_CARRIER"]);

    // 4. Step 3: PACK_COMPLETE -> advances 'packaging' region to 'packed'
    const step3 = await requestJson("/api/orders/order-e2e-1/transitions", {
      method: "POST",
      body: JSON.stringify({
        event: "PACK_COMPLETE",
        input: { boxWeightKg: 2.3 },
      }),
    });
    expect(step3.status).toBe(200);
    expect(step3.body.currentState).toEqual({
      fulfilling: {
        packaging: "packed",
        shipping: "booking_carrier",
      },
    });
    expect(step3.body.availableEvents).toEqual(["BOOK_CARRIER"]);

    // 5. Step 4: BOOK_CARRIER -> finishes both parallel regions -> auto-fires onDone -> 'delivered'!
    const step4 = await requestJson("/api/orders/order-e2e-1/transitions", {
      method: "POST",
      body: JSON.stringify({
        event: "BOOK_CARRIER",
        input: { carrier: "DHL", trackingNumber: "DHL-555111" },
      }),
    });
    expect(step4.status).toBe(200);
    expect(step4.body.currentState).toBe("delivered");
    expect(step4.body.status).toBe("COMPLETED");
    expect(step4.body.availableEvents).toEqual([]);
    expect(step4.body.notifications).toHaveLength(1);

    // 6. GET /api/orders/:txId returns persisted terminal state + YAML,
    //    and GET /api/orders now shows nonTerminalCount === 0, terminalCount === 1!
    const fetched = await requestJson("/api/orders/order-e2e-1");
    expect(fetched.status).toBe(200);
    expect(fetched.body.currentState).toBe("delivered");
    expect(fetched.body.status).toBe("COMPLETED");
    expect(fetched.body.yaml).toContain("dfsm: \"1.0\"");

    const listAfterDone = await requestJson("/api/orders");
    expect(listAfterDone.body.nonTerminalCount).toBe(0);
    expect(listAfterDone.body.terminalCount).toBe(1);
    expect(listAfterDone.body.activeOrders).toHaveLength(0);
  });

  it("supports conditional @DfsmEffect routing + automatic next transition (autoApprovePayment: true) over HTTP", async () => {
    await requestJson("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        transactionId: "order-auto-vip",
        customerEmail: "vip@eklab.dev",
      }),
    });

    // Single HTTP call to SUBMIT_ORDER with autoApprovePayment=true enters inventory_reserved,
    // runs evaluatePostReserveRouting -> autoAuthorizeWalletEffect -> actor.transition(AUTHORIZE_PAYMENT)
    // and settles directly in parallel 'fulfilling'!
    const step = await requestJson("/api/orders/order-auto-vip/transitions", {
      method: "POST",
      body: JSON.stringify({
        event: "SUBMIT_ORDER",
        input: {
          autoApprovePayment: true,
          items: [{ sku: "VIP-PACK", quantity: 1, unitPriceCents: 32000 }],
        },
      }),
    });

    expect(step.status).toBe(200);
    expect(step.body.currentState).toEqual({
      fulfilling: {
        packaging: "packing",
        shipping: "booking_carrier",
      },
    });
    expect(step.body.status).toBe("IDLE");
    expect(step.body.context.paymentAuthId).toContain("express_auto_wallet");
    expect(step.body.availableEvents).toEqual(["PACK_COMPLETE", "BOOK_CARRIER"]);
    expect(step.body.routingEvents).toContain(
      "auto_authorize_triggered:order-auto-vip:express_auto_wallet"
    );

    const admin = await requestJson("/api/admin/status");
    expect(
      admin.body.recentLifecycleHooks.some(
        (h: any) => h.hook === "onStart" && h.transactionId === "order-auto-vip"
      )
    ).toBe(true);
    expect(
      admin.body.recentLifecycleHooks.filter(
        (h: any) => h.hook === "afterTransition" && h.transactionId === "order-auto-vip"
      )
    ).toHaveLength(2);
  });

  it("handles 400 Zod validation errors, 409 invalid transitions, LIFO Saga rollback, custom error recovery & admin cleanup", async () => {
    await requestJson("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        transactionId: "order-saga-fail",
        customerEmail: "bob@eklab.dev",
      }),
    });

    // 1. Invalid empty items array -> 400 Bad Request, state stays 'created'
    const badInput = await requestJson("/api/orders/order-saga-fail/transitions", {
      method: "POST",
      body: JSON.stringify({ event: "SUBMIT_ORDER", input: { items: [] } }),
    });
    expect(badInput.status).toBe(400);
    expect(badInput.body.code).toBe("DFSM_VALIDATION_ERROR");

    // 2. Invalid event for 'created' state -> 409 Conflict with availableEvents hint
    const wrongEvent = await requestJson("/api/orders/order-saga-fail/transitions", {
      method: "POST",
      body: JSON.stringify({ event: "PACK_COMPLETE", input: { boxWeightKg: 1 } }),
    });
    expect(wrongEvent.status).toBe(409);
    expect(wrongEvent.body.availableEvents).toEqual(["SUBMIT_ORDER", "CANCEL_ORDER"]);

    // 3. Valid SUBMIT_ORDER reserves stock
    await requestJson("/api/orders/order-saga-fail/transitions", {
      method: "POST",
      body: JSON.stringify({
        event: "SUBMIT_ORDER",
        input: { items: [{ sku: "MON-4K", quantity: 1, unitPriceCents: 45000 }] },
      }),
    });

    // 4. Simulate payment failure -> retries 3 times, unwinds releaseInventory, lands in 'error'
    const failedPay = await requestJson("/api/orders/order-saga-fail/transitions", {
      method: "POST",
      body: JSON.stringify({
        event: "AUTHORIZE_PAYMENT",
        input: { paymentMethod: "bad_card", simulateFailure: true },
      }),
    });
    expect(failedPay.status).toBe(200);
    expect(failedPay.body.currentState).toBe("error");
    expect(failedPay.body.status).toBe("COMPENSATED");
    expect(failedPay.body.stepResult.compensatedSteps).toBe(1);
    expect(failedPay.body.context.inventoryReserved).toBe(false);
    expect(failedPay.body.lastBenchmark.attempts).toBe(3);
    expect(failedPay.body.availableEvents).toEqual(["RESET_ORDER"]);

    // 5. Recover from custom overridden 'error' state via RESET_ORDER -> back to 'created'!
    const resetRes = await requestJson("/api/orders/order-saga-fail/transitions", {
      method: "POST",
      body: JSON.stringify({ event: "RESET_ORDER" }),
    });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.currentState).toBe("created");
    expect(resetRes.body.status).toBe("IDLE");

    // 6. Verify /api/admin/status, /api/admin/sweep, and /api/admin/cleanup
    const adminStatus = await requestJson("/api/admin/status");
    expect(adminStatus.status).toBe(200);
    expect(adminStatus.body.machines).toHaveLength(1);
    expect(adminStatus.body.actors).toHaveLength(1);

    const sweep = await requestJson("/api/admin/sweep", { method: "POST" });
    expect(sweep.status).toBe(200);

    const cleanup = await requestJson("/api/admin/cleanup", {
      method: "POST",
      body: JSON.stringify({ includeInFlight: true, action: "DELETE" }),
    });
    expect(cleanup.status).toBe(200);
    expect(cleanup.body.deleted).toContain("order-saga-fail");

    // Deleted transaction now returns 404
    const afterDel = await requestJson("/api/orders/order-saga-fail");
    expect(afterDel.status).toBe(404);

    // 7. Verify server logs capture incoming requests + HTTP status + currentState + status + result + availableEvents
    expect(
      capturedLogs.some(
        (l) =>
          l.includes("--> POST /api/orders/order-saga-fail/transitions") &&
          l.includes('"event":"SUBMIT_ORDER"')
      )
    ).toBe(true);
    expect(
      capturedLogs.some(
        (l) =>
          l.includes("[DFSM-STEP] tx=order-saga-fail | event=AUTHORIZE_PAYMENT") &&
          l.includes("attempts=3 | outcome=COMPENSATED")
      )
    ).toBe(true);
    expect(
      capturedLogs.some(
        (l) =>
          l.includes("<-- 200 POST /api/orders/order-saga-fail/transitions") &&
          l.includes('currentState="error"') &&
          l.includes("status=COMPENSATED") &&
          l.includes("result=") &&
          l.includes('availableEvents=["RESET_ORDER"]')
      )
    ).toBe(true);
  });

  it("ships a valid Postman v2.1 collection wired with configurable {{orderId}} variable", () => {
    const postmanPath = resolve(
      import.meta.dirname,
      "../../examples/06-express-api-server/dfsm-express-api.postman_collection.json"
    );
    const collection = JSON.parse(readFileSync(postmanPath, "utf8")) as Record<string, any>;

    expect(collection.info.schema).toContain("v2.1.0/collection.json");
    const vars = collection.variable as Array<{ key: string; value: string }>;
    expect(vars.find((v) => v.key === "orderId")?.value).toBe("order-101");
    expect(vars.find((v) => v.key === "baseUrl")?.value).toBe("http://localhost:3000");
    expect(collection.item.length).toBe(5);
    expect(JSON.stringify(collection.item)).toContain("{{baseUrl}}/api/orders/{{orderId}}/transitions");
  });
});

