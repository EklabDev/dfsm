use dfsm_axum_api_server::build_app;
use serde_json::json;
use tokio::net::TcpListener;

async fn spawn_test_server() -> String {
    let (app, _state) = build_app();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    format!("http://{}", addr)
}

#[tokio::test]
async fn test_full_e2e_api_flow() {
    let base_url = spawn_test_server().await;
    let client = reqwest::Client::new();

    // 1. GET /api/machine
    let res = client
        .get(format!("{}/api/machine", base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let m_body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(m_body["id"], "rust-order-fulfillment");
    assert_eq!(m_body["initial"], "created");
    assert!(m_body["yaml"].as_str().unwrap().contains("rust-order-fulfillment"));

    // 2. POST /api/orders (create order)
    let order_id = "test-order-e2e-101";
    let create_res = client
        .post(format!("{}/api/orders", base_url))
        .json(&json!({
            "orderId": order_id,
            "customer": "buyer@eklab.dev",
            "amount": 199.99,
            "items": ["keyboard", "mouse"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create_res.status(), 201);
    let create_body: serde_json::Value = create_res.json().await.unwrap();
    assert_eq!(create_body["orderId"], order_id);
    assert_eq!(create_body["currentState"], "created");
    assert_eq!(create_body["status"], "IDLE");
    assert!(create_body["yaml"].as_str().unwrap().contains("rust-order-fulfillment"));

    // 3. GET /api/orders/{id}
    let get_res = client
        .get(format!("{}/api/orders/{}", base_url, order_id))
        .send()
        .await
        .unwrap();
    assert_eq!(get_res.status(), 200);
    let get_body: serde_json::Value = get_res.json().await.unwrap();
    assert_eq!(get_body["currentState"], "created");

    // 4. POST /api/orders/{id}/transitions -> SUBMIT_ORDER
    let tx1_res = client
        .post(format!("{}/api/orders/{}/transitions", base_url, order_id))
        .json(&json!({ "event": "SUBMIT_ORDER" }))
        .send()
        .await
        .unwrap();
    assert_eq!(tx1_res.status(), 200);
    let tx1_body: serde_json::Value = tx1_res.json().await.unwrap();
    assert_eq!(tx1_body["currentState"], "inventory_reserved");
    assert_eq!(tx1_body["status"], "IDLE");

    // 5. POST /api/orders/{id}/transitions -> AUTHORIZE_PAYMENT -> enters parallel fulfilling
    let tx2_res = client
        .post(format!("{}/api/orders/{}/transitions", base_url, order_id))
        .json(&json!({ "event": "AUTHORIZE_PAYMENT" }))
        .send()
        .await
        .unwrap();
    assert_eq!(tx2_res.status(), 200);
    let tx2_body: serde_json::Value = tx2_res.json().await.unwrap();
    assert_eq!(
        tx2_body["currentState"],
        json!({"fulfilling": {"packaging": "packing", "shipping": "booking_carrier"}})
    );

    // 6. POST /api/orders/{id}/transitions -> PACK_COMPLETE
    let tx3_res = client
        .post(format!("{}/api/orders/{}/transitions", base_url, order_id))
        .json(&json!({ "event": "PACK_COMPLETE" }))
        .send()
        .await
        .unwrap();
    assert_eq!(tx3_res.status(), 200);
    let tx3_body: serde_json::Value = tx3_res.json().await.unwrap();
    assert_eq!(
        tx3_body["currentState"],
        json!({"fulfilling": {"packaging": "packed", "shipping": "booking_carrier"}})
    );

    // 7. POST /api/orders/{id}/transitions -> BOOK_CARRIER -> onDone triggers delivered (COMPLETED)
    let tx4_res = client
        .post(format!("{}/api/orders/{}/transitions", base_url, order_id))
        .json(&json!({ "event": "BOOK_CARRIER" }))
        .send()
        .await
        .unwrap();
    assert_eq!(tx4_res.status(), 200);
    let tx4_body: serde_json::Value = tx4_res.json().await.unwrap();
    assert_eq!(tx4_body["currentState"], "delivered");
    assert_eq!(tx4_body["status"], "COMPLETED");

    // 8. GET /api/terminals
    let term_res = client
        .get(format!("{}/api/terminals", base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(term_res.status(), 200);
    let term_body: serde_json::Value = term_res.json().await.unwrap();
    assert!(term_body["terminalStates"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == "delivered"));

    // 9. GET /api/scheduler
    let sched_res = client
        .get(format!("{}/api/scheduler", base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(sched_res.status(), 200);

    // 10. POST /api/scheduler/sweep
    let sweep_res = client
        .post(format!("{}/api/scheduler/sweep", base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(sweep_res.status(), 200);
}

#[tokio::test]
async fn test_saga_failure_and_recovery_flow() {
    let base_url = spawn_test_server().await;
    let client = reqwest::Client::new();
    let order_id = "test-order-saga-fail-1";

    // 1. Create Order with failStep: authorizePayment
    let create_res = client
        .post(format!("{}/api/orders", base_url))
        .json(&json!({
            "orderId": order_id,
            "customer": "fail@eklab.dev",
            "amount": 99.0,
            "failStep": "authorizePayment"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create_res.status(), 201);

    // 2. Reserve stock
    let res1 = client
        .post(format!("{}/api/orders/{}/transitions", base_url, order_id))
        .json(&json!({ "event": "SUBMIT_ORDER" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res1.status(), 200);

    // 3. Authorize payment fails (retries 3 times), triggers LIFO rollback of reserved stock -> COMPENSATED in error state
    let res2 = client
        .post(format!("{}/api/orders/{}/transitions", base_url, order_id))
        .json(&json!({ "event": "AUTHORIZE_PAYMENT" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res2.status(), 200);
    let fail_body: serde_json::Value = res2.json().await.unwrap();
    assert_eq!(fail_body["currentState"], "error");
    assert_eq!(fail_body["status"], "COMPENSATED");
    assert_eq!(fail_body["compensatedSteps"], 1);
    assert_eq!(fail_body["rollbackOccurred"], true);

    // 4. Reset order back to created draft state
    let reset_res = client
        .post(format!("{}/api/orders/{}/reset", base_url, order_id))
        .send()
        .await
        .unwrap();
    assert_eq!(reset_res.status(), 200);
    let reset_body: serde_json::Value = reset_res.json().await.unwrap();
    assert_eq!(reset_body["currentState"], "created");
    assert_eq!(reset_body["status"], "IDLE");
}
