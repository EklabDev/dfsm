use eklabdev_dfsm::actor::DfsmActor;
use eklabdev_dfsm::definition::parse_yaml_machine;
use eklabdev_dfsm::registry::FSMRegistry;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AccountContext {
    account_id: String,
    email: String,
    balance: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DepositInput {
    amount: i64,
    email: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== DFSM Rust Example 02: Input & Schema Validation ===");

    // 1. Valid YAML with JSON Schema Draft 2020-12
    let yaml = r#"
dfsm: "1.0"
id: "account-verification"
version: "1.0.0"
initial: "unverified"
states:
  unverified:
    on:
      DEPOSIT:
        target: "active"
        transition: "handleDeposit"
  active:
    on:
      FREEZE: "frozen"
  frozen:
    type: "final"
"#;

    let machine = parse_yaml_machine(yaml)?;
    let reg = FSMRegistry::new();

    reg.register_transition(
        "handleDeposit",
        Box::new(|_tx, ctx, input, _state, _event| {
            Box::pin(async move {
                let mut data: AccountContext =
                    serde_json::from_value(ctx).unwrap_or_default();
                let dep: DepositInput = match input {
                    Some(val) => serde_json::from_value(val).map_err(|e| {
                        eklabdev_dfsm::error::DfsmError::ExecutionFailed(format!(
                            "Invalid input payload: {}",
                            e
                        ))
                    })?,
                    None => {
                        return Err(eklabdev_dfsm::error::DfsmError::ExecutionFailed(
                            "Deposit input is required".to_string(),
                        ))
                    }
                };

                if dep.amount <= 0 {
                    return Err(eklabdev_dfsm::error::DfsmError::ExecutionFailed(
                        "Deposit amount must be greater than zero".to_string(),
                    ));
                }

                if !dep.email.contains('@') {
                    return Err(eklabdev_dfsm::error::DfsmError::ExecutionFailed(
                        "Invalid email address format".to_string(),
                    ));
                }

                data.email = dep.email.clone();
                data.balance += dep.amount;
                println!(
                    ">> Handled Deposit: Added ${} for {} (New Balance: ${})",
                    dep.amount, dep.email, data.balance
                );

                Ok((
                    Some(serde_json::to_value(&data).unwrap()),
                    Some(json!({"newBalance": data.balance})),
                ))
            })
        }),
        None,
    );

    let actor = DfsmActor::<AccountContext>::new(machine, Arc::new(reg));

    // 2. Invalid input: amount <= 0
    let res1 = actor
        .transition(
            "acc-fail-amount",
            "DEPOSIT",
            Some(DepositInput {
                amount: 0,
                email: "valid@eklab.dev".to_string(),
            }),
        )
        .await?;
    println!("[Expected Failure 1]: Status is {:?}, State is {}", res1.status, res1.current_state);

    // 3. Invalid input: bad email
    let res2 = actor
        .transition(
            "acc-fail-email",
            "DEPOSIT",
            Some(DepositInput {
                amount: 50,
                email: "invalid-email".to_string(),
            }),
        )
        .await?;
    println!("[Expected Failure 2]: Status is {:?}, State is {}", res2.status, res2.current_state);

    // 4. Valid input
    let res = actor
        .transition(
            "acc-valid-1",
            "DEPOSIT",
            Some(DepositInput {
                amount: 100,
                email: "owner@eklab.dev".to_string(),
            }),
        )
        .await?;
    println!("[Success]: Transitioned to {}", res.current_state);

    // 5. Schema validation error with invalid YAML missing required fields
    let bad_yaml = r#"
dfsm: "1.0"
id: "missing-states"
initial: "start"
"#;
    let schema_err = parse_yaml_machine(bad_yaml);
    println!(
        "[Expected Schema Error]: {:?}",
        schema_err.err().map(|e| e.to_string())
    );

    Ok(())
}
