package io.github.eklabdev.dfsm.annotation;

import io.github.eklabdev.dfsm.CompensationFunction;
import io.github.eklabdev.dfsm.CompensationRequest;
import io.github.eklabdev.dfsm.EffectFunction;
import io.github.eklabdev.dfsm.EffectRequest;
import io.github.eklabdev.dfsm.JsonCodec;
import io.github.eklabdev.dfsm.LifecycleHookFunction;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.TransitionRequest;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;
import io.github.eklabdev.dfsm.validation.JakartaSchemaValidator;
import io.github.eklabdev.dfsm.validation.SchemaValidator;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.List;

/**
 * Discovers {@link DfsmTransition}, {@link DfsmCompensate}, {@link DfsmEffect}, and {@link DfsmHook}
 * annotated methods on service objects, extracting stacked resilience annotations into {@link PartialTransitionPolicy}.
 */
public final class AnnotationScanner {
    private AnnotationScanner() {}

    public record ScannedService(
            List<DecoratedTransition<Object, Object, Object>> transitions,
            List<NamedCompensation> compensations,
            List<NamedEffect> effects,
            List<NamedHook> hooks
    ) {}

    public record NamedCompensation(String name, CompensationFunction<Object> fn) {}
    public record NamedEffect(String name, EffectFunction<Object> fn) {}
    public record NamedHook(String name, LifecycleHookFunction<Object> fn) {}

    @SuppressWarnings("unchecked")
    public static ScannedService scan(Object serviceInstance) {
        List<DecoratedTransition<Object, Object, Object>> transitions = new ArrayList<>();
        List<NamedCompensation> compensations = new ArrayList<>();
        List<NamedEffect> effects = new ArrayList<>();
        List<NamedHook> hooks = new ArrayList<>();

        Class<?> clazz = serviceInstance.getClass();
        for (Method method : clazz.getMethods()) {
            if (method.getDeclaringClass() == Object.class) {
                continue;
            }
            discoverFromMethod(serviceInstance, method, transitions, compensations, effects, hooks);
        }
        // Also scan non-public declared methods up the hierarchy if annotated
        for (Class<?> cur = clazz; cur != null && cur != Object.class; cur = cur.getSuperclass()) {
            for (Method method : cur.getDeclaredMethods()) {
                if (java.lang.reflect.Modifier.isPublic(method.getModifiers())) {
                    continue; // already processed above
                }
                discoverFromMethod(serviceInstance, method, transitions, compensations, effects, hooks);
            }
        }

        return new ScannedService(transitions, compensations, effects, hooks);
    }

    @SuppressWarnings("unchecked")
    private static void discoverFromMethod(
            Object target,
            Method method,
            List<DecoratedTransition<Object, Object, Object>> transitions,
            List<NamedCompensation> compensations,
            List<NamedEffect> effects,
            List<NamedHook> hooks
    ) {
        DfsmTransition trAnn = method.getAnnotation(DfsmTransition.class);
        if (trAnn != null) {
            method.setAccessible(true);
            String baseName = trAnn.value().isBlank() ? method.getName() : trAnn.value();
            PartialTransitionPolicy policy = extractPolicy(method);
            Class<Object> inferredInputClass = resolveInputClass(method, trAnn);
            boolean requireNonNull = inferredInputClass != null
                    && !Object.class.equals(inferredInputClass)
                    && !Void.class.equals(inferredInputClass)
                    && !inferredInputClass.isPrimitive();
            SchemaValidator<Object> inputValidator = trAnn.validateInput()
                    ? (requireNonNull ? JakartaSchemaValidator.required() : JakartaSchemaValidator.shared())
                    : null;

            DecoratedTransition<Object, Object, Object> dt = new DecoratedTransition<>(
                    baseName,
                    req -> invokeTransitionMethod(target, method, req),
                    policy,
                    inferredInputClass,
                    inputValidator
            );
            transitions.add(dt);
        }

        DfsmCompensate compAnn = method.getAnnotation(DfsmCompensate.class);
        if (compAnn != null) {
            method.setAccessible(true);
            String baseName = compAnn.value().isBlank() ? method.getName() : compAnn.value();
            compensations.add(new NamedCompensation(baseName, req -> invokeCompensateMethod(target, method, req)));
        }

        DfsmEffect effAnn = method.getAnnotation(DfsmEffect.class);
        if (effAnn != null) {
            method.setAccessible(true);
            String baseName = effAnn.value().isBlank() ? method.getName() : effAnn.value();
            effects.add(new NamedEffect(baseName, req -> invokeEffectMethod(target, method, req)));
        }

        DfsmHook hookAnn = method.getAnnotation(DfsmHook.class);
        if (hookAnn != null) {
            method.setAccessible(true);
            String baseName = hookAnn.value().isBlank() ? method.getName() : hookAnn.value();
            hooks.add(new NamedHook(baseName, evt -> invokeHookMethod(target, method, evt)));
        }
    }

    public static PartialTransitionPolicy extractPolicy(Method method) {
        PartialTransitionPolicy policy = PartialTransitionPolicy.EMPTY;

        Retry retryAnn = method.getAnnotation(Retry.class);
        if (retryAnn != null) {
            int attempts = retryAnn.maxAttempts() > 0 ? retryAnn.maxAttempts()
                    : (retryAnn.value() > 0 ? retryAnn.value() : 1);
            policy = policy.withRetry(new PartialTransitionPolicy.PartialRetry(attempts, null));
        }

        Backoff boAnn = method.getAnnotation(Backoff.class);
        if (boAnn != null) {
            policy = policy.withBackoff(new PartialTransitionPolicy.PartialBackoff(
                    boAnn.strategy(),
                    boAnn.initialDelayMs() >= 0 ? boAnn.initialDelayMs() : null,
                    boAnn.maxDelayMs() >= 0 ? boAnn.maxDelayMs() : null,
                    boAnn.multiplier() > 0 ? boAnn.multiplier() : null
            ));
        }

        CircuitBreaker cbAnn = method.getAnnotation(CircuitBreaker.class);
        if (cbAnn != null) {
            policy = policy.withCircuitBreaker(new PartialTransitionPolicy.PartialCircuitBreaker(
                    cbAnn.enabled(),
                    cbAnn.failureThreshold() > 0 ? cbAnn.failureThreshold() : null,
                    cbAnn.slidingWindowSize() > 0 ? cbAnn.slidingWindowSize() : null,
                    cbAnn.openDurationMs() > 0 ? cbAnn.openDurationMs() : null,
                    cbAnn.halfOpenMaxCalls() > 0 ? cbAnn.halfOpenMaxCalls() : null
            ));
        }

        OnFail ofAnn = method.getAnnotation(OnFail.class);
        if (ofAnn != null) {
            policy = policy.withOnFail(new PartialTransitionPolicy.PartialOnFail(
                    ofAnn.compensate(),
                    ofAnn.target().isBlank() ? null : ofAnn.target()
            ));
        }

        CompensateWith cwAnn = method.getAnnotation(CompensateWith.class);
        if (cwAnn != null && !cwAnn.value().isBlank()) {
            policy = policy.withCompensateHandler(cwAnn.value());
        }

        Benchmark bmAnn = method.getAnnotation(Benchmark.class);
        if (bmAnn != null) {
            policy = policy.withBenchmark(new PartialTransitionPolicy.PartialBenchmark(bmAnn.enabled()));
        }

        return policy;
    }

    @SuppressWarnings("unchecked")
    private static Class<Object> resolveInputClass(Method method, DfsmTransition ann) {
        if (ann.inputClass() != Void.class) {
            return (Class<Object>) ann.inputClass();
        }
        Type[] genericParams = method.getGenericParameterTypes();
        if (genericParams.length == 1 && genericParams[0] instanceof ParameterizedType pt) {
            if (pt.getRawType() == TransitionRequest.class) {
                Type[] args = pt.getActualTypeArguments();
                if (args.length >= 2 && args[1] instanceof Class<?> inputCls) {
                    if (inputCls != Void.class && inputCls != Object.class) {
                        return (Class<Object>) inputCls;
                    }
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static TransitionOutput<Object, Object> invokeTransitionMethod(
            Object target,
            Method method,
            TransitionRequest<Object, Object> req
    ) throws Exception {
        try {
            Object raw;
            if (method.getParameterCount() == 0) {
                raw = method.invoke(target);
            } else {
                raw = method.invoke(target, req);
            }
            if (raw == null) {
                return TransitionOutput.empty();
            }
            if (raw instanceof TransitionOutput<?, ?> out) {
                return (TransitionOutput<Object, Object>) out;
            }
            return TransitionOutput.ofValue(raw);
        } catch (InvocationTargetException ite) {
            Throwable cause = ite.getTargetException();
            if (cause instanceof Exception ex) {
                throw ex;
            }
            throw new RuntimeException(cause);
        }
    }

    private static Object invokeCompensateMethod(
            Object target,
            Method method,
            CompensationRequest<Object> req
    ) throws Exception {
        try {
            if (method.getParameterCount() == 0) {
                return method.invoke(target);
            }
            // Coerce contextBefore / currentContext if method expects a concrete TContext parameter
            return method.invoke(target, req);
        } catch (InvocationTargetException ite) {
            Throwable cause = ite.getTargetException();
            if (cause instanceof Exception ex) {
                throw ex;
            }
            throw new RuntimeException(cause);
        }
    }

    private static void invokeEffectMethod(
            Object target,
            Method method,
            EffectRequest<Object> req
    ) throws Exception {
        try {
            if (method.getParameterCount() == 0) {
                method.invoke(target);
            } else {
                method.invoke(target, req);
            }
        } catch (InvocationTargetException ite) {
            Throwable cause = ite.getTargetException();
            if (cause instanceof Exception ex) {
                throw ex;
            }
            throw new RuntimeException(cause);
        }
    }

    private static void invokeHookMethod(
            Object target,
            Method method,
            Object evt
    ) throws Exception {
        try {
            if (method.getParameterCount() == 0) {
                method.invoke(target);
            } else {
                Class<?> paramType = method.getParameterTypes()[0];
                Object arg = paramType.isInstance(evt) ? evt : JsonCodec.convertValue(evt, paramType);
                method.invoke(target, arg);
            }
        } catch (InvocationTargetException ite) {
            Throwable cause = ite.getTargetException();
            if (cause instanceof Exception ex) {
                throw ex;
            }
            throw new RuntimeException(cause);
        }
    }
}
