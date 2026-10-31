package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/eklabdev/dfsm/sdks/go"
)

type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		var reqBody string
		if r.Body != nil {
			bodyBytes, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
			if len(bodyBytes) > 0 {
				reqBody = string(bodyBytes)
			}
		}

		lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		log.Printf("[HTTP-IN] %s %s | Body: %s", r.Method, r.URL.Path, reqBody)

		next.ServeHTTP(lrw, r)

		duration := time.Since(start)
		log.Printf("[HTTP-OUT] %s %s -> %d (%dms)", r.Method, r.URL.Path, lrw.statusCode, duration.Milliseconds())
	})
}

func setupRoutes(svc *OrderFulfillmentService) http.Handler {
	mux := http.NewServeMux()

	// GET /api/machine
	mux.HandleFunc("/api/machine", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(svc.GetMachine())
	})

	// POST /api/orders & GET /api/orders
	mux.HandleFunc("/api/orders", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var req CreateOrderRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, fmt.Sprintf(`{"error":"Invalid request JSON: %s"}`, err.Error()), http.StatusBadRequest)
				return
			}
			if req.OrderId == "" || req.Customer == "" || req.Amount <= 0 {
				http.Error(w, `{"error":"OrderId, Customer email, and Amount > 0 are required"}`, http.StatusBadRequest)
				return
			}

			resp, err := svc.CreateOrder(r.Context(), req)
			if err != nil {
				http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(resp)
			return
		}

		if r.Method == http.MethodGet {
			inFlight, err := svc.GetInFlight(r.Context())
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(inFlight.InFlightOrders)
			return
		}

		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
	})

	// Subroutes for /api/orders/...
	mux.HandleFunc("/api/orders/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/orders/")
		parts := strings.Split(path, "/")
		orderId := parts[0]

		if orderId == "" {
			http.Error(w, "Order ID required", http.StatusBadRequest)
			return
		}

		// GET /api/orders/{id}
		if len(parts) == 1 && r.Method == http.MethodGet {
			resp, err := svc.GetOrder(r.Context(), orderId)
			if err != nil {
				http.Error(w, fmt.Sprintf(`{"error":"Order not found: %s"}`, err.Error()), http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}

		// POST /api/orders/{id}/transitions
		if len(parts) == 2 && parts[1] == "transitions" && r.Method == http.MethodPost {
			var body TransitionRequestPayload
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"error":"Invalid request body"}`, http.StatusBadRequest)
				return
			}
			if body.Event == "" {
				http.Error(w, `{"error":"Event name is required"}`, http.StatusBadRequest)
				return
			}

			resp, err := svc.ExecuteTransition(r.Context(), orderId, body.Event, body.Payload)
			w.Header().Set("Content-Type", "application/json")
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				if resp != nil {
					json.NewEncoder(w).Encode(resp)
				} else {
					json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
				}
				return
			}
			json.NewEncoder(w).Encode(resp)
			return
		}

		// POST /api/orders/{id}/cancel
		if len(parts) == 2 && parts[1] == "cancel" && r.Method == http.MethodPost {
			resp, err := svc.ExecuteTransition(r.Context(), orderId, "CANCEL_ORDER", nil)
			w.Header().Set("Content-Type", "application/json")
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				if resp != nil {
					json.NewEncoder(w).Encode(resp)
				} else {
					json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
				}
				return
			}
			json.NewEncoder(w).Encode(resp)
			return
		}

		// POST /api/orders/{id}/reset
		if len(parts) == 2 && parts[1] == "reset" && r.Method == http.MethodPost {
			resp, err := svc.ExecuteTransition(r.Context(), orderId, "RESET_ORDER", nil)
			w.Header().Set("Content-Type", "application/json")
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				if resp != nil {
					json.NewEncoder(w).Encode(resp)
				} else {
					json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
				}
				return
			}
			json.NewEncoder(w).Encode(resp)
			return
		}

		http.Error(w, "Not Found", http.StatusNotFound)
	})

	// GET /api/in-flight
	mux.HandleFunc("/api/in-flight", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		summary, err := svc.GetInFlight(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(summary)
	})

	// GET /api/terminals
	mux.HandleFunc("/api/terminals", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(svc.GetTerminalStates())
	})

	// GET /api/scheduler & POST /api/scheduler/sweep
	mux.HandleFunc("/api/scheduler", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status":            "RUNNING",
			"intervalMs":        60000,
			"orphanThresholdMs": 1800000,
		})
	})

	mux.HandleFunc("/api/scheduler/sweep", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		olderThan := int64(1800000)
		res, err := svc.ForceCleanup(r.Context(), dfsm.ForceCleanUpOptions{
			OlderThanMs: &olderThan,
			StuckOnly:   true,
			Action:      dfsm.ActionMarkFail,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(res)
	})

	// POST /api/cleanup
	mux.HandleFunc("/api/cleanup", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		var req CleanupRequestPayload
		_ = json.NewDecoder(r.Body).Decode(&req)
		res, err := svc.ForceCleanup(r.Context(), dfsm.ForceCleanUpOptions{
			TransactionIds: req.TransactionIds,
			OlderThanMs:    req.OlderThanMs,
			StuckOnly:      req.StuckOnly,
			Action:         req.Action,
			DryRun:         req.DryRun,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(res)
	})

	return LoggingMiddleware(mux)
}

func main() {
	var store dfsm.StateStore
	storeType := os.Getenv("DFSM_STORE")
	switch strings.ToLower(storeType) {
	case "postgres":
		pgUrl := os.Getenv("DFSM_POSTGRES_URL")
		if pgUrl == "" {
			pgUrl = "postgres://dfsm:dfsm_password@localhost:55432/dfsm_test?sslmode=disable"
		}
		pgStore, err := dfsm.NewPostgresStateStore(pgUrl)
		if err != nil {
			log.Fatalf("Failed to initialize Postgres store: %v", err)
		}
		store = pgStore
		log.Println("[STORE] Using PostgreSQL store")
	case "mongo", "mongodb":
		mongoUrl := os.Getenv("DFSM_MONGO_URL")
		if mongoUrl == "" {
			mongoUrl = "mongodb://localhost:27018"
		}
		mongoStore, err := dfsm.NewMongoStateStore(mongoUrl, "dfsm_api_db")
		if err != nil {
			log.Fatalf("Failed to initialize Mongo store: %v", err)
		}
		store = mongoStore
		log.Println("[STORE] Using MongoDB store")
	default:
		store = dfsm.NewMemoryStateStore()
		log.Println("[STORE] Using default In-Memory store")
	}

	svc, err := NewOrderFulfillmentService(store)
	if err != nil {
		log.Fatalf("Failed to initialize service: %v", err)
	}

	handler := setupRoutes(svc)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    ":" + port,
		Handler: handler,
	}

	log.Printf("==================================================================")
	log.Printf("  DFSM Go E2E Order Fulfillment API Server started on port %s", port)
	log.Printf("  Endpoints:")
	log.Printf("    GET  /api/machine")
	log.Printf("    POST /api/orders")
	log.Printf("    GET  /api/orders/{id}")
	log.Printf("    POST /api/orders/{id}/transitions")
	log.Printf("    POST /api/orders/{id}/cancel")
	log.Printf("    POST /api/orders/{id}/reset")
	log.Printf("    GET  /api/in-flight")
	log.Printf("    GET  /api/terminals")
	log.Printf("    POST /api/scheduler/sweep")
	log.Printf("    POST /api/cleanup")
	log.Printf("==================================================================")

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}
