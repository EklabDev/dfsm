package io.github.eklabdev.dfsm.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface CircuitBreaker {
    boolean enabled() default true;
    int failureThreshold() default -1;
    int slidingWindowSize() default -1;
    long openDurationMs() default -1L;
    int halfOpenMaxCalls() default -1;
}

