package io.github.eklabdev.dfsm.sample.exception;

import io.github.eklabdev.dfsm.error.CircuitOpenException;
import io.github.eklabdev.dfsm.error.DfsmException;
import io.github.eklabdev.dfsm.error.InvalidTransitionException;
import io.github.eklabdev.dfsm.error.MaxEffectChainDepthException;
import io.github.eklabdev.dfsm.error.StaleTransactionVersionException;
import io.github.eklabdev.dfsm.error.TransactionNotFoundException;
import io.github.eklabdev.dfsm.error.ValidationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ValidationException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(ValidationException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "VALIDATION_ERROR");
        body.put("code", ex.getCode());
        body.put("message", ex.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleMethodArgNotValid(MethodArgumentNotValidException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "VALIDATION_ERROR");
        body.put("code", "DFSM_VALIDATION_ERROR");
        body.put("message", ex.getBindingResult().getAllErrors().get(0).getDefaultMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
    }

    @ExceptionHandler(InvalidTransitionException.class)
    public ResponseEntity<Map<String, Object>> handleInvalidTransition(InvalidTransitionException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "INVALID_TRANSITION");
        body.put("code", ex.getCode());
        body.put("message", ex.getMessage());
        body.put("availableEvents", ex.getAvailableEvents());
        return ResponseEntity.status(HttpStatus.CONFLICT).body(body);
    }

    @ExceptionHandler(TransactionNotFoundException.class)
    public ResponseEntity<Map<String, Object>> handleNotFound(TransactionNotFoundException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "TRANSACTION_NOT_FOUND");
        body.put("code", ex.getCode());
        body.put("message", ex.getMessage());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(body);
    }

    @ExceptionHandler(StaleTransactionVersionException.class)
    public ResponseEntity<Map<String, Object>> handleStaleVersion(StaleTransactionVersionException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "STALE_VERSION");
        body.put("code", ex.getCode());
        body.put("message", ex.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT).body(body);
    }

    @ExceptionHandler(CircuitOpenException.class)
    public ResponseEntity<Map<String, Object>> handleCircuitOpen(CircuitOpenException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "CIRCUIT_OPEN");
        body.put("code", ex.getCode());
        body.put("message", ex.getMessage());
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(body);
    }

    @ExceptionHandler(MaxEffectChainDepthException.class)
    public ResponseEntity<Map<String, Object>> handleMaxDepth(MaxEffectChainDepthException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "MAX_EFFECT_CHAIN_DEPTH");
        body.put("code", ex.getCode());
        body.put("message", ex.getMessage());
        return ResponseEntity.status(HttpStatus.LOOP_DETECTED).body(body);
    }

    @ExceptionHandler(DfsmException.class)
    public ResponseEntity<Map<String, Object>> handleDfsmException(DfsmException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", ex.getCode());
        body.put("message", ex.getMessage());
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleGeneral(Exception ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "INTERNAL_SERVER_ERROR");
        body.put("message", ex.getMessage());
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
    }
}

