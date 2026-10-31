using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;
using EKLabDev.Dfsm.SampleServer;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace EKLabDev.Dfsm.Tests;

public class OrderFulfillmentApiTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public OrderFulfillmentApiTests(WebApplicationFactory<Program> factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task GetMachine_ReturnsDefinitionAndYaml()
    {
        var response = await _client.GetAsync("/api/machine");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var doc = await response.Content.ReadFromJsonAsync<JsonElement>();
        doc.GetProperty("machineId").GetString().Should().Be("express-order-fulfillment");
        doc.GetProperty("initialState").GetString().Should().Be("created");
        doc.GetProperty("yaml").GetString().Should().Contain("express-order-fulfillment");
    }

    [Fact]
    public async Task HappyPath_CompleteOrderFulfillmentEndToEnd()
    {
        string orderId = $"test-order-csharp-{Guid.NewGuid():N}";

        // 1. Submit Order -> enters inventory_reserved
        var submitInput = new SubmitOrderInput
        {
            OrderId = orderId,
            CustomerEmail = "alice@example.com",
            Items = new List<OrderItem>
            {
                new() { Sku = "SKU-LAPTOP", Quantity = 1, UnitPrice = 1299.99m }
            },
            Priority = false
        };

        var submitResp = await _client.PostAsJsonAsync("/api/orders", submitInput);
        submitResp.StatusCode.Should().Be(HttpStatusCode.Created);
        var submitDoc = await submitResp.Content.ReadFromJsonAsync<JsonElement>();
        submitDoc.GetProperty("orderId").GetString().Should().Be(orderId);
        submitDoc.GetProperty("currentState").GetString().Should().Be("inventory_reserved");
        submitDoc.GetProperty("status").GetString().Should().Be("IDLE");
        submitDoc.GetProperty("yaml").GetString().Should().NotBeNullOrEmpty();

        // 2. Step 1: AUTHORIZE_PAYMENT -> enters parallel fulfilling state
        var authResp = await _client.PostAsJsonAsync($"/api/orders/{orderId}/transitions", new TransitionRequestDto
        {
            Event = "AUTHORIZE_PAYMENT",
            Input = new AuthorizePaymentInput { PaymentAuthId = "AUTH-998822" }
        });
        authResp.StatusCode.Should().Be(HttpStatusCode.OK);
        var authDoc = await authResp.Content.ReadFromJsonAsync<JsonElement>();
        authDoc.GetProperty("currentState").GetProperty("fulfilling").GetProperty("packaging").GetString().Should().Be("packing");
        authDoc.GetProperty("currentState").GetProperty("fulfilling").GetProperty("shipping").GetString().Should().Be("booking_carrier");

        // 3. Step 2: PACK_COMPLETE
        var packResp = await _client.PostAsJsonAsync($"/api/orders/{orderId}/transitions", new TransitionRequestDto
        {
            Event = "PACK_COMPLETE",
            Input = new CompletePackingInput { BoxWeightKg = 2.5m }
        });
        packResp.StatusCode.Should().Be(HttpStatusCode.OK);
        var packDoc = await packResp.Content.ReadFromJsonAsync<JsonElement>();
        packDoc.GetProperty("currentState").GetProperty("fulfilling").GetProperty("packaging").GetString().Should().Be("packed");

        // 4. Step 3: BOOK_CARRIER -> both parallel regions complete, onDone -> delivered!
        var carrierResp = await _client.PostAsJsonAsync($"/api/orders/{orderId}/transitions", new TransitionRequestDto
        {
            Event = "BOOK_CARRIER",
            Input = new BookCarrierInput { Carrier = "FEDEX", TrackingNumber = "TRK-554433" }
        });
        carrierResp.StatusCode.Should().Be(HttpStatusCode.OK);
        var carrierDoc = await carrierResp.Content.ReadFromJsonAsync<JsonElement>();
        carrierDoc.GetProperty("currentState").GetString().Should().Be("delivered");
        carrierDoc.GetProperty("status").GetString().Should().Be("COMPLETED");

        // Verify availableEvents is empty for terminal state
        carrierDoc.GetProperty("availableEvents").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task PriorityOrder_TriggersConditionalAutoRouteEffect()
    {
        string orderId = $"priority-csharp-{Guid.NewGuid():N}";

        // Priority = true triggers evaluatePostReserveRouting -> autoAuthorizeWalletEffect -> AUTHORIZE_PAYMENT -> lands in fulfilling!
        var submitResp = await _client.PostAsJsonAsync("/api/orders", new SubmitOrderInput
        {
            OrderId = orderId,
            CustomerEmail = "vip@example.com",
            Items = new List<OrderItem> { new() { Sku = "SKU-VIP", Quantity = 2, UnitPrice = 500m } },
            Priority = true
        });

        submitResp.StatusCode.Should().Be(HttpStatusCode.Created);
        var doc = await submitResp.Content.ReadFromJsonAsync<JsonElement>();

        // Auto-routed past inventory_reserved directly into parallel fulfilling!
        doc.GetProperty("currentState").GetProperty("fulfilling").GetProperty("packaging").GetString().Should().Be("packing");
    }

    [Fact]
    public async Task InvalidTransition_Returns409Conflict()
    {
        string orderId = $"conflict-csharp-{Guid.NewGuid():N}";
        await _client.PostAsJsonAsync("/api/orders", new SubmitOrderInput
        {
            OrderId = orderId,
            CustomerEmail = "user@example.com",
            Items = new List<OrderItem> { new() { Sku = "SKU-1", Quantity = 1, UnitPrice = 10m } }
        });

        // In 'inventory_reserved', try BOOK_CARRIER (which is only valid in parallel fulfilling) -> 409 Conflict
        var resp = await _client.PostAsJsonAsync($"/api/orders/{orderId}/transitions", new TransitionRequestDto
        {
            Event = "BOOK_CARRIER",
            Input = new { Carrier = "UPS", TrackingNumber = "123" }
        });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var err = await resp.Content.ReadFromJsonAsync<JsonElement>();
        err.GetProperty("error").GetString().Should().Be("InvalidTransitionException");
    }

    [Fact]
    public async Task ValidationFailure_Returns400BadRequest()
    {
        string orderId = $"val-csharp-{Guid.NewGuid():N}";
        await _client.PostAsJsonAsync("/api/orders", new SubmitOrderInput
        {
            OrderId = orderId,
            CustomerEmail = "user@example.com",
            Items = new List<OrderItem> { new() { Sku = "SKU-1", Quantity = 1, UnitPrice = 10m } }
        });

        // Advance to fulfilling
        await _client.PostAsJsonAsync($"/api/orders/{orderId}/transitions", new TransitionRequestDto
        {
            Event = "AUTHORIZE_PAYMENT",
            Input = new AuthorizePaymentInput { PaymentAuthId = "AUTH-1" }
        });

        // Try PACK_COMPLETE with invalid weight (-10kg) -> 400 Bad Request
        var resp = await _client.PostAsJsonAsync($"/api/orders/{orderId}/transitions", new TransitionRequestDto
        {
            Event = "PACK_COMPLETE",
            Input = new CompletePackingInput { BoxWeightKg = -10m }
        });

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var err = await resp.Content.ReadFromJsonAsync<JsonElement>();
        err.GetProperty("error").GetString().Should().Be("ValidationException");
    }

    [Fact]
    public async Task OpsEndpoints_ReturnsInFlightAndTerminals()
    {
        var terminalsResp = await _client.GetAsync("/api/terminals");
        terminalsResp.StatusCode.Should().Be(HttpStatusCode.OK);
        var termDoc = await terminalsResp.Content.ReadFromJsonAsync<JsonElement>();
        termDoc.GetProperty("terminalStates").EnumerateArray().Should().Contain(e => e.GetString() == "delivered");

        var inFlightResp = await _client.GetAsync("/api/in-flight");
        inFlightResp.StatusCode.Should().Be(HttpStatusCode.OK);
        var ifDoc = await inFlightResp.Content.ReadFromJsonAsync<JsonElement>();
        ifDoc.GetProperty("terminalStates").EnumerateArray().Should().Contain(e => e.GetString() == "delivered");
    }
}
