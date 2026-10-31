package io.github.eklabdev.dfsm.sample;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
class OrderFulfillmentApiTests {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void testGetMachineDefinition() throws Exception {
        mockMvc.perform(get("/api/machine"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.machineId").value("express-order-fulfillment"))
                .andExpect(jsonPath("$.hasCustomErrorState").value(true))
                .andExpect(jsonPath("$.yaml").isNotEmpty());
    }

    @Test
    void testHappyPathFulfillmentFlow() throws Exception {
        // 1. Create order
        String createJson = """
                {
                  "transactionId": "test-order-happy-1",
                  "customerEmail": "buyer@example.com"
                }
                """;
        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createJson))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.transactionId").value("test-order-happy-1"))
                .andExpect(jsonPath("$.currentState").value("created"))
                .andExpect(jsonPath("$.status").value("IDLE"))
                .andExpect(jsonPath("$.availableEvents[0]").value("SUBMIT_ORDER"));

        // 2. Submit order without auto-approval -> rests in inventory_reserved
        String submitJson = """
                {
                  "event": "SUBMIT_ORDER",
                  "input": {
                    "items": [
                      { "sku": "KB-100", "quantity": 1, "unitPriceCents": 12000 },
                      { "sku": "CABLE-01", "quantity": 2, "unitPriceCents": 1500 }
                    ],
                    "autoApprovePayment": false
                  }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-happy-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(submitJson))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentState").value("inventory_reserved"))
                .andExpect(jsonPath("$.context.totalCents").value(15000))
                .andExpect(jsonPath("$.context.inventoryReserved").value(true));

        // 3. Authorize payment -> enters parallel 'fulfilling'
        String authJson = """
                {
                  "event": "AUTHORIZE_PAYMENT",
                  "input": {
                    "paymentMethod": "visa_credit",
                    "simulateFailure": false
                  }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-happy-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(authJson))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentState.fulfilling.packaging").value("packing"))
                .andExpect(jsonPath("$.currentState.fulfilling.shipping").value("booking_carrier"));

        // 4. Complete packing
        String packJson = """
                {
                  "event": "PACK_COMPLETE",
                  "input": {
                    "boxWeightKg": 1.75
                  }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-happy-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(packJson))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentState.fulfilling.packaging").value("packed"))
                .andExpect(jsonPath("$.status").value("IDLE"));

        // 5. Book carrier -> parallel completes -> triggers onDone -> delivered (COMPLETED)!
        String carrierJson = """
                {
                  "event": "BOOK_CARRIER",
                  "input": {
                    "carrier": "DHL_EXPRESS",
                    "trackingNumber": "TRACK-889922"
                  }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-happy-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(carrierJson))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentState").value("delivered"))
                .andExpect(jsonPath("$.status").value("COMPLETED"))
                .andExpect(jsonPath("$.availableEvents").isEmpty());
    }

    @Test
    void testConditionalEffectAutoRouting() throws Exception {
        // When autoApprovePayment: true, evaluatePostReserveRouting triggers autoAuthorizeWalletEffect
        // which immediately chains AUTHORIZE_PAYMENT -> lands in 'fulfilling'!
        String createJson = """
                {
                  "transactionId": "test-order-auto-1",
                  "customerEmail": "vip@example.com"
                }
                """;
        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createJson))
                .andExpect(status().isCreated());

        String submitAutoJson = """
                {
                  "event": "SUBMIT_ORDER",
                  "input": {
                    "items": [
                      { "sku": "VIP-PASS", "quantity": 1, "unitPriceCents": 50000 }
                    ],
                    "autoApprovePayment": true
                  }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-auto-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(submitAutoJson))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentState.fulfilling.packaging").value("packing"))
                .andExpect(jsonPath("$.context.paymentAuthId").isNotEmpty());
    }

    @Test
    void testValidationFailureRejectionPreFlight() throws Exception {
        String createJson = """
                {
                  "transactionId": "test-order-val-1",
                  "customerEmail": "val@example.com"
                }
                """;
        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createJson))
                .andExpect(status().isCreated());

        // Empty items list rejected pre-flight with 400 Bad Request
        String badSubmit = """
                {
                  "event": "SUBMIT_ORDER",
                  "input": {
                    "items": [],
                    "autoApprovePayment": false
                  }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-val-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(badSubmit))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("VALIDATION_ERROR"));
    }

    @Test
    void testInvalidTransitionConflict() throws Exception {
        String createJson = """
                {
                  "transactionId": "test-order-inv-1",
                  "customerEmail": "inv@example.com"
                }
                """;
        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createJson))
                .andExpect(status().isCreated());

        // PACK_COMPLETE is invalid while in 'created' state
        String invalidTransition = """
                {
                  "event": "PACK_COMPLETE",
                  "input": { "boxWeightKg": 2.0 }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-inv-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(invalidTransition))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("INVALID_TRANSITION"))
                .andExpect(jsonPath("$.availableEvents[0]").value("SUBMIT_ORDER"));
    }

    @Test
    void testSagaRollbackAndResetErrorRecovery() throws Exception {
        String createJson = """
                {
                  "transactionId": "test-order-saga-1",
                  "customerEmail": "fail@example.com"
                }
                """;
        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createJson))
                .andExpect(status().isCreated());

        // Submit order -> reserves inventory (pushes releaseInventory to Saga stack)
        String submitJson = """
                {
                  "event": "SUBMIT_ORDER",
                  "input": {
                    "items": [{ "sku": "FAIL-SKU", "quantity": 1, "unitPriceCents": 1000 }],
                    "autoApprovePayment": false
                  }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-saga-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(submitJson))
                .andExpect(status().isOk());

        // Payment gateway failure -> retries 3 times -> unwinds Saga stack -> COMPENSATED @ error
        String failAuth = """
                {
                  "event": "AUTHORIZE_PAYMENT",
                  "input": {
                    "paymentMethod": "declined_card",
                    "simulateFailure": true
                  }
                }
                """;
        mockMvc.perform(post("/api/orders/test-order-saga-1/transitions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(failAuth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentState").value("error"))
                .andExpect(jsonPath("$.status").value("COMPENSATED"))
                .andExpect(jsonPath("$.context.inventoryReserved").value(false));

        // Recovery transition RESET_ORDER -> back to 'created'
        mockMvc.perform(post("/api/orders/test-order-saga-1/reset")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentState").value("created"))
                .andExpect(jsonPath("$.status").value("IDLE"));
    }

    @Test
    void testOperationalEndpoints() throws Exception {
        mockMvc.perform(get("/api/orders"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nonTerminalCount").isNumber());

        mockMvc.perform(get("/api/in-flight"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.inFlightCount").isNumber());

        mockMvc.perform(get("/api/terminals"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.topLevelTerminalStates").isArray());

        mockMvc.perform(get("/api/scheduler"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.config").isNotEmpty());

        mockMvc.perform(post("/api/cleanup?dryRun=true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.dryRun").value(true));
    }
}

