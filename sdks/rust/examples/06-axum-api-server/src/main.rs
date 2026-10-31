use dfsm_axum_api_server::build_app;
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (app, _state) = build_app();
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    println!("============================================================");
    println!("DFSM Axum REST API Server running on http://localhost:{}", port);
    println!("============================================================");
    println!("Endpoints:");
    println!("  GET  /api/machine");
    println!("  POST /api/orders");
    println!("  GET  /api/orders");
    println!("  GET  /api/orders/:id");
    println!("  POST /api/orders/:id/transitions");
    println!("  POST /api/orders/:id/cancel");
    println!("  POST /api/orders/:id/reset");
    println!("  GET  /api/in-flight");
    println!("  GET  /api/terminals");
    println!("  GET  /api/scheduler");
    println!("  POST /api/scheduler/sweep");
    println!("  POST /api/cleanup");
    println!("============================================================");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
