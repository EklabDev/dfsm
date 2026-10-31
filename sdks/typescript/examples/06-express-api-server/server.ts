import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  DfsmError,
  FSMRegistry,
  InMemoryBenchmarkLogger,
  InvalidTransitionError,
  MongoStateStore,
  PostgresStateStore,
  SqliteStateStore,
  TransactionNotFoundError,
  ValidationError,
  type BenchmarkLogEngine,
  type BenchmarkLogRecord,
  type StateStore,
} from "../../src/index.js";
import {
  OrderApiContextSchema,
  OrderFulfillmentService,
  type OrderApiContext,
} from "./handlers.js";

const YAML_FILE_PATH = resolve(import.meta.dirname, "./order-fulfillment.dfsm.yaml");

const CreateOrderRequestSchema = z.object({
  transactionId: z.string().min(1).optional(),
  customerEmail: z.string().email().default("customer@example.com"),
});

const TransitionRequestSchema = z.object({
  event: z.string().min(1, "'event' is required"),
  input: z.unknown().optional(),
});

export interface OrderExpressServerOptions {
  store?: StateStore;
  useSingletonRegistry?: boolean;
  /**
   * Controls HTTP & DFSM execution logs (enabled by default; set `silentLogs: true` to mute).
   */
  silentLogs?: boolean;
  /**
   * Optional custom log sink (defaults to `console.log`).
   */
  logSink?: (line: string) => void;
}

function createStoreFromEnv(): StateStore {
  const driver = (process.env.DFSM_STORE ?? "sqlite").toLowerCase();
  if (driver === "postgres") {
    return new PostgresStateStore({
      connectionString:
        process.env.DFSM_POSTGRES_URL ??
        "postgresql://dfsm:dfsm_password@127.0.0.1:55432/dfsm_test",
    });
  }
  if (driver === "mongodb") {
    return new MongoStateStore({
      uri: process.env.DFSM_MONGO_URL ?? "mongodb://127.0.0.1:27018",
      databaseName: process.env.DFSM_MONGO_DB ?? "dfsm_express_api",
    });
  }
  return new SqliteStateStore({
    filename: process.env.DFSM_SQLITE_PATH ?? ":memory:",
  });
}

export async function createOrderExpressApp(options?: OrderExpressServerOptions): Promise<{
  app: Express;
  registry: FSMRegistry;
  service: OrderFulfillmentService;
  logger: InMemoryBenchmarkLogger;
  yamlSource: string;
  shutdown: () => Promise<void>;
}> {
  const yamlSource = readFileSync(YAML_FILE_PATH, "utf8");
  const logger = new InMemoryBenchmarkLogger();
  const store = options?.store ?? createStoreFromEnv();
  const emitLog = (line: string) => {
    if (options?.silentLogs) return;
    (options?.logSink ?? console.log)(line);
  };

  // Composite benchmark logger: retains entries in memory AND prints step telemetry to server stdout
  const serverLogEngine: BenchmarkLogEngine = {
    recordTransition(entry: BenchmarkLogRecord) {
      logger.recordTransition(entry);
      emitLog(
        `[${new Date(entry.timestamp).toISOString()}] [DFSM-STEP] tx=${entry.transactionId} | event=${entry.event} | handler=${entry.transitionHandler ?? "none"} | attempts=${entry.attempts} | outcome=${entry.outcome} (${entry.durationMs}ms) | ${JSON.stringify(entry.fromState)} -> ${JSON.stringify(entry.toState)}${entry.error ? ` | error="${entry.error}"` : ""}`
      );
    },
    logRecovery(actorId: string, message: string, metadata?: Record<string, unknown>) {
      logger.logRecovery(actorId, message, metadata);
      emitLog(
        `[${new Date().toISOString()}] [DFSM-RECOVERY] actor=${actorId} | ${message}${metadata ? ` | ${JSON.stringify(metadata)}` : ""}`
      );
    },
  };

  const registry = options?.useSingletonRegistry
    ? FSMRegistry.getInstance().configure({ store, logEngine: serverLogEngine })
    : new FSMRegistry({ store, logEngine: serverLogEngine });

  // Register YAML machine AND bind all @DfsmTransition, @DfsmCompensate, @DfsmEffect,
  // and @DfsmHook handlers (`api.orders` namespace) right on machine creation!
  const service = new OrderFulfillmentService(emitLog);
  registry.registerYaml(yamlSource, {
    services: [service],
  });

  const orderActor = await registry.createActor<OrderApiContext>("express-order-fulfillment", {
    actorId: "express-order-actor-1",
    contextValidator: OrderApiContextSchema,
    recovery: {
      enabled: true,
      stuckThresholdMs: 30_000,
      defaultAction: "COMPENSATE",
    },
    scheduler: {
      enabled: true,
      sweepIntervalMs: 30_000,
      stuckThresholdMs: 30_000,
      batchSize: 100,
    },
  });

  const app = express();
  app.use(express.json());

  // --------------------------------------------------------------------------
  // Request & Response Logging Middleware (logs incoming body + HTTP status,
  // currentState, FSM status, step/error result, and availableEvents)
  // --------------------------------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqStartedAt = Date.now();
    const hasBody = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0;
    emitLog(
      `[${new Date(reqStartedAt).toISOString()}] --> ${req.method} ${req.originalUrl}${hasBody ? ` | body=${JSON.stringify(req.body)}` : ""}`
    );

    let capturedJsonBody: Record<string, unknown> | undefined;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        capturedJsonBody = body as Record<string, unknown>;
      }
      return originalJson(body);
    }) as Response["json"];

    res.on("finish", () => {
      const elapsedMs = Date.now() - reqStartedAt;
      const parts: string[] = [
        `[${new Date().toISOString()}] <-- ${res.statusCode} ${req.method} ${req.originalUrl} (${elapsedMs}ms)`,
      ];

      if (capturedJsonBody) {
        if ("transactionId" in capturedJsonBody && capturedJsonBody.transactionId !== undefined) {
          parts.push(`txId=${String(capturedJsonBody.transactionId)}`);
        }
        if ("currentState" in capturedJsonBody) {
          parts.push(`currentState=${JSON.stringify(capturedJsonBody.currentState)}`);
        }
        if ("status" in capturedJsonBody) {
          parts.push(`status=${String(capturedJsonBody.status)}`);
        }
        if ("stepResult" in capturedJsonBody) {
          parts.push(`result=${JSON.stringify(capturedJsonBody.stepResult)}`);
        } else if ("code" in capturedJsonBody || "error" in capturedJsonBody) {
          parts.push(
            `result=${JSON.stringify({
              code: capturedJsonBody.code ?? capturedJsonBody.error,
              message: capturedJsonBody.message,
              ...(capturedJsonBody.details ? { details: capturedJsonBody.details } : {}),
            })}`
          );
        }
        if ("availableEvents" in capturedJsonBody) {
          parts.push(`availableEvents=${JSON.stringify(capturedJsonBody.availableEvents)}`);
        }
        if ("nonTerminalCount" in capturedJsonBody) {
          parts.push(`nonTerminalCount=${String(capturedJsonBody.nonTerminalCount)}`);
        }
      }

      emitLog(parts.join(" | "));
    });

    next();
  });

  /**
   * Helper to format consistent FSM status responses including the YAML definition
   * (omittable via `?includeYaml=false` if desired; included by default!).
   */
  const formatTransactionPayload = async (
    txId: string,
    includeYaml: boolean,
    stepDetails?: {
      event: string;
      previousState: unknown;
      outputValue: unknown;
      compensatedSteps: number;
      error?: string;
    }
  ) => {
    const snapshot = await orderActor.getTransaction(txId);
    if (!snapshot) {
      throw new TransactionNotFoundError(txId);
    }
    const availableEvents = orderActor.getAvailableEvents(snapshot.stateValue);
    const lastBenchmark = [...logger.entries]
      .reverse()
      .find((b) => b.transactionId === txId);

    return {
      transactionId: snapshot.transactionId,
      machineId: snapshot.machineId,
      machineVersion: snapshot.machineVersion,
      actorId: snapshot.actorId,
      currentState: snapshot.stateValue,
      status: snapshot.status,
      availableEvents,
      version: snapshot.version,
      context: snapshot.context,
      lastError: snapshot.lastError,
      compensationStack: snapshot.compensationStack,
      ...(stepDetails ? { stepResult: stepDetails } : {}),
      ...(lastBenchmark ? { lastBenchmark } : {}),
      notifications: service.notifications,
      routingEvents: service.routingEvents,
      ...(includeYaml ? { yaml: yamlSource } : {}),
    };
  };

  // --------------------------------------------------------------------------
  // 1. Inspect Machine Definition, Effective Merged Policies, Terminal States & Raw YAML
  // --------------------------------------------------------------------------
  app.get("/api/machine", (_req: Request, res: Response) => {
    const loaded = orderActor.getLoadedMachine();
    res.json({
      machineId: loaded.definition.id,
      version: loaded.definition.version,
      hasCustomErrorState: loaded.definition.hasCustomErrorState,
      terminalStates: orderActor.getTerminalStates(),
      effectiveConfig: loaded.effectiveConfig,
      yaml: yamlSource,
    });
  });

  // --------------------------------------------------------------------------
  // 2. Start a New FSM Transaction (persists initial 'created' state immediately)
  // --------------------------------------------------------------------------
  app.post("/api/orders", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedBody = CreateOrderRequestSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        res.status(400).json({
          error: "INVALID_REQUEST",
          issues: parsedBody.error.issues,
        });
        return;
      }

      const initialContext: OrderApiContext = {
        customerEmail: parsedBody.data.customerEmail,
        items: [],
        totalCents: 0,
        inventoryReserved: false,
        autoApprovePayment: false,
        paymentAuthId: null,
        boxWeightKg: null,
        trackingNumber: null,
        carrier: null,
        auditLog: ["order_created"],
      };

      const txId = await orderActor.startTransaction(
        initialContext,
        parsedBody.data.transactionId
      );
      const includeYaml = req.query.includeYaml !== "false";
      const payload = await formatTransactionPayload(txId, includeYaml);
      res.status(201).json(payload);
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // 3. List Non-Terminal ("Active / Open") & In-Flight Transactions + Terminal States
  // --------------------------------------------------------------------------
  app.get("/api/orders", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [statusBreakdown, inFlightCount, stuckCount, rawActiveOrders, inFlightTransactions] =
        await Promise.all([
          orderActor.getStatusBreakdown(),
          orderActor.getInFlightCount(),
          orderActor.getInFlightCount({ stuckOnly: true }),
          orderActor.listActiveTransactions({ limit: 50 }),
          orderActor.listInFlightTransactions({ limit: 50 }),
        ]);

      const activeOrders = rawActiveOrders.map((order) => ({
        ...order,
        availableEvents: orderActor.getAvailableEvents(order.stateValue),
      }));

      res.json({
        machineId: orderActor.machineId,
        actorId: orderActor.actorId,
        nonTerminalCount: statusBreakdown.nonTerminalCount,
        terminalCount: statusBreakdown.terminalCount,
        inFlightCount,
        stuckCount,
        statusBreakdown,
        terminalStates: orderActor.getTerminalStates(),
        activeOrders,
        inFlightTransactions,
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // 4. Get Current FSM Status of a Specific Transaction (+ YAML)
  // --------------------------------------------------------------------------
  app.get("/api/orders/:txId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const txId = String(req.params.txId);
      const includeYaml = req.query.includeYaml !== "false";
      const payload = await formatTransactionPayload(txId, includeYaml);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // 5. Call Transition 1-by-1 (`POST /api/orders/:txId/transitions`)
  // --------------------------------------------------------------------------
  app.post(
    "/api/orders/:txId/transitions",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const txId = String(req.params.txId);
        const parsed = TransitionRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: "INVALID_REQUEST",
            issues: parsed.error.issues,
          });
          return;
        }

        const result = await orderActor.transition(
          txId,
          parsed.data.event,
          parsed.data.input
        );

        const includeYaml = req.query.includeYaml !== "false";
        const payload = await formatTransactionPayload(txId, includeYaml, {
          event: parsed.data.event,
          previousState: result.previousState,
          outputValue: result.value,
          compensatedSteps: result.compensatedSteps,
          ...(result.error ? { error: result.error } : {}),
        });

        res.status(200).json(payload);
      } catch (err) {
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // 6. Operational Admin Endpoints (Introspection, Scheduler Sweep & Cleanup)
  // --------------------------------------------------------------------------
  app.get("/api/admin/status", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const inFlightSummary = await registry.getInFlightSummary();
      res.json({
        registryConfig: registry.getRegistryConfig(),
        machines: registry.listMachines(),
        actors: registry.listActors(),
        handlers: registry.listRegisteredHandlers("api.orders"),
        actorConfig: orderActor.getActorConfig(),
        schedulerStatus: orderActor.getSchedulerStatus(),
        inFlightSummary,
        recentBenchmarks: logger.entries.slice(-20),
        recentLifecycleHooks: service.lifecycleHooksLog.slice(-30),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/admin/sweep", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await orderActor.triggerSweepNow();
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/admin/cleanup", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await orderActor.forceCleanUp(req.body ?? {});
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // Structured DFSM Error Middleware
  // --------------------------------------------------------------------------
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({
        code: err.code,
        target: err.target,
        message: err.message,
        details: err.details,
      });
      return;
    }

    if (err instanceof TransactionNotFoundError) {
      res.status(404).json({
        code: err.code,
        message: err.message,
      });
      return;
    }

    if (err instanceof InvalidTransitionError) {
      res.status(409).json({
        code: err.code,
        message: err.message,
        currentState: err.currentState,
        availableEvents: err.availableEvents,
      });
      return;
    }

    if (err instanceof DfsmError) {
      res.status(422).json({
        code: err.code,
        message: err.message,
      });
      return;
    }

    res.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    app,
    registry,
    service,
    logger,
    yamlSource,
    shutdown: async () => {
      await registry.shutdown();
    },
  };
}

// Start standalone HTTP server when executed directly (`npm run start:api`)
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createOrderExpressApp({ useSingletonRegistry: true }).then(({ app, shutdown }) => {
    const server = app.listen(port, () => {
      console.log(`🚀 DFSM Express API Server listening on http://localhost:${port}`);
      console.log(`   - GET  http://localhost:${port}/api/machine`);
      console.log(`   - POST http://localhost:${port}/api/orders`);
      console.log(`   - GET  http://localhost:${port}/api/orders/:txId`);
      console.log(`   - POST http://localhost:${port}/api/orders/:txId/transitions`);
      console.log(`   - GET  http://localhost:${port}/api/admin/status`);
    });

    const handleSignal = async () => {
      server.close();
      await shutdown();
      process.exit(0);
    };
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}
