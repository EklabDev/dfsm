using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Runtime;
using EKLabDev.Dfsm.SampleServer;
using EKLabDev.Dfsm.Statechart;
using EKLabDev.Dfsm.Store;
using EKLabDev.Dfsm.Telemetry;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = WebApplication.CreateBuilder(args);

// Load YAML workflow
var yamlPath = Path.Combine(AppContext.BaseDirectory, "order-fulfillment.dfsm.yaml");
if (!File.Exists(yamlPath))
{
    yamlPath = "order-fulfillment.dfsm.yaml";
}
var yamlContent = File.ReadAllText(yamlPath);
var machineDef = YamlMachineParser.Parse(yamlContent);

// State store configuration (H2/SQLite default in-memory, or PG/Mongo via configuration)
var storeDriver = builder.Configuration["Dfsm:Store"] ?? "sqlite";
IStateStore store = storeDriver.ToLowerInvariant() switch
{
    "postgres" => new PostgresStateStore(builder.Configuration["Dfsm:Postgres"] ?? "Host=localhost;Port=55432;Database=dfsm_test;Username=dfsm;Password=dfsm_password"),
    "mongo" => new MongoStateStore(builder.Configuration["Dfsm:Mongo"] ?? "mongodb://localhost:27018", "dfsm_test"),
    _ => new SqliteStateStore("Data Source=dfsm_api;Mode=Memory;Cache=Shared")
};

var registry = new FSMRegistry(store: store, benchmarkEngine: ConsoleBenchmarkLogEngine.Instance);
registry.RegisterMachine(machineDef);
registry.RegisterAnnotatedHandlers(new OrderFulfillmentService());

var actor = registry.CreateActor<OrderApiContext>(machineDef.Id);

builder.Services.AddSingleton(machineDef);
builder.Services.AddSingleton(registry);
builder.Services.AddSingleton(actor);
builder.Services.AddSingleton(new WorkflowMetadata(yamlContent));

var app = builder.Build();

// Structured Request/Response Logging Middleware
app.Use(async (context, next) =>
{
    var path = context.Request.Path.Value ?? "";
    var method = context.Request.Method;

    string requestBody = "";
    if (context.Request.ContentLength > 0 && context.Request.Body.CanSeek)
    {
        context.Request.EnableBuffering();
        using var reader = new StreamReader(context.Request.Body, leaveOpen: true);
        requestBody = await reader.ReadToEndAsync();
        context.Request.Body.Position = 0;
    }

    if (!string.IsNullOrEmpty(requestBody))
    {
        Console.WriteLine($"--> {method} {path} | body={requestBody.Replace("\n", "").Replace("  ", " ")}");
    }
    else
    {
        Console.WriteLine($"--> {method} {path}");
    }

    var sw = Stopwatch.StartNew();
    try
    {
        await next();
        sw.Stop();
        Console.WriteLine($"<-- {context.Response.StatusCode} {method} {path} ({sw.ElapsedMilliseconds}ms)");
    }
    catch (ValidationException vex)
    {
        sw.Stop();
        Console.WriteLine($"<-- 400 {method} {path} ({sw.ElapsedMilliseconds}ms) | ValidationException: {vex.Message}");
        context.Response.StatusCode = 400;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new { error = "ValidationException", message = vex.Message, errors = vex.Errors });
    }
    catch (InvalidTransitionException itex)
    {
        sw.Stop();
        Console.WriteLine($"<-- 409 {method} {path} ({sw.ElapsedMilliseconds}ms) | InvalidTransitionException: {itex.Message}");
        context.Response.StatusCode = 409;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new { error = "InvalidTransitionException", message = itex.Message, currentState = itex.CurrentState, eventName = itex.EventName });
    }
    catch (TransactionNotFoundException nfex)
    {
        sw.Stop();
        Console.WriteLine($"<-- 404 {method} {path} ({sw.ElapsedMilliseconds}ms) | TransactionNotFoundException: {nfex.Message}");
        context.Response.StatusCode = 404;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new { error = "TransactionNotFoundException", message = nfex.Message });
    }
    catch (CircuitOpenException cbex)
    {
        sw.Stop();
        Console.WriteLine($"<-- 503 {method} {path} ({sw.ElapsedMilliseconds}ms) | CircuitOpenException: {cbex.Message}");
        context.Response.StatusCode = 503;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new { error = "CircuitOpenException", message = cbex.Message });
    }
    catch (MaxEffectChainDepthException mdex)
    {
        sw.Stop();
        Console.WriteLine($"<-- 508 {method} {path} ({sw.ElapsedMilliseconds}ms) | MaxEffectChainDepthException: {mdex.Message}");
        context.Response.StatusCode = 508;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new { error = "MaxEffectChainDepthException", message = mdex.Message });
    }
    catch (Exception ex)
    {
        sw.Stop();
        Console.WriteLine($"<-- 500 {method} {path} ({sw.ElapsedMilliseconds}ms) | Exception: {ex.Message}");
        context.Response.StatusCode = 500;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new { error = "InternalServerError", message = ex.Message });
    }
});

// Helper for Response with YAML
object BuildResponse(ActorStateRecord state, object? result = null) => new
{
    orderId = state.TransactionId,
    currentState = state.CurrentState,
    status = state.Status.ToString(),
    availableEvents = state.AvailableEvents,
    result,
    context = state.Context,
    version = state.Version,
    updatedAt = state.UpdatedAt,
    yaml = yamlContent
};

// --- Endpoints ---

app.MapGet("/api/machine", (MachineDefinition machine, WorkflowMetadata meta) => Results.Ok(new
{
    machineId = machine.Id,
    initialState = machine.Initial,
    terminalStates = StatechartEngine.GetTerminalStates(machine),
    yaml = meta.YamlContent
}));

app.MapPost("/api/orders", async (SubmitOrderInput input, DfsmActor<OrderApiContext> act) =>
{
    string orderId = !string.IsNullOrEmpty(input.OrderId) ? input.OrderId : $"ORD-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
    var result = await act.TransitionAsync(orderId, "SUBMIT_ORDER", input);
    var state = await act.GetStateAsync(orderId);
    return Results.Created($"/api/orders/{orderId}", BuildResponse(state, result));
});

app.MapGet("/api/orders/{id}", async (string id, DfsmActor<OrderApiContext> act) =>
{
    var state = await act.GetStateAsync(id);
    return Results.Ok(BuildResponse(state));
});

app.MapPost("/api/orders/{id}/transitions", async (string id, TransitionRequestDto body, DfsmActor<OrderApiContext> act) =>
{
    var result = await act.TransitionAsync(id, body.Event, body.Input);
    var state = await act.GetStateAsync(id);
    return Results.Ok(BuildResponse(state, result));
});

app.MapPost("/api/orders/{id}/cancel", async (string id, DfsmActor<OrderApiContext> act) =>
{
    var result = await act.TransitionAsync(id, "CANCEL_ORDER", new { reason = "user_cancelled" });
    var state = await act.GetStateAsync(id);
    return Results.Ok(BuildResponse(state, result));
});

app.MapPost("/api/orders/{id}/reset", async (string id, DfsmActor<OrderApiContext> act) =>
{
    var result = await act.TransitionAsync(id, "RESET_ORDER", new { reason = "admin_reset" });
    var state = await act.GetStateAsync(id);
    return Results.Ok(BuildResponse(state, result));
});

app.MapGet("/api/orders", async (DfsmActor<OrderApiContext> act) =>
{
    var active = await act.ListActiveTransactionsAsync(100);
    return Results.Ok(active);
});

app.MapGet("/api/in-flight", async (DfsmActor<OrderApiContext> act) =>
{
    var summary = await act.GetInFlightSummaryAsync();
    var activeList = await act.ListActiveTransactionsAsync(100);
    return Results.Ok(new
    {
        totalInFlight = summary.TotalInFlight,
        nonTerminalCount = summary.NonTerminalCount,
        terminalStates = summary.TerminalStates,
        breakdown = summary.Breakdown,
        activeOrders = activeList
    });
});

app.MapGet("/api/terminals", (DfsmActor<OrderApiContext> act) =>
{
    var terminals = act.GetTerminalStates();
    return Results.Ok(new
    {
        terminalStates = terminals,
        terminalStatuses = new[] { "COMPLETED", "COMPENSATED", "FAILED" }
    });
});

app.MapGet("/api/scheduler", () => Results.Ok(new
{
    status = "RUNNING",
    intervalMs = 15000,
    recoveryStrategy = "COMPENSATE",
    activeLeases = 0
}));

app.MapPost("/api/scheduler/sweep", async (DfsmActor<OrderApiContext> act) =>
{
    var cleanResult = await act.ForceCleanUpAsync(new ForceCleanUpOptions(
        Action: ForceCleanUpAction.COMPENSATE,
        StuckOnly: true,
        OlderThanMs: 30000,
        DryRun: false
    ));
    return Results.Ok(new { sweptCount = cleanResult.ProcessedCount, affected = cleanResult.AffectedTransactionIds });
});

app.MapPost("/api/cleanup", async (CleanUpRequestDto body, DfsmActor<OrderApiContext> act) =>
{
    var result = await act.ForceCleanUpAsync(new ForceCleanUpOptions(
        Action: body.Action,
        TransactionIds: body.TransactionIds,
        DryRun: body.DryRun,
        Limit: body.Limit
    ));
    return Results.Ok(result);
});

app.Run();

public record WorkflowMetadata(string YamlContent);

public partial class Program { }
