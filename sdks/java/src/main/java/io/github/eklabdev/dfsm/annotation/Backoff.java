package io.github.eklabdev.dfsm.annotation;

import io.github.eklabdev.dfsm.policy.BackoffStrategy;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface Backoff {
    BackoffStrategy strategy() default BackoffStrategy.EXPONENTIAL;
    long initialDelayMs() default -1L;
    long maxDelayMs() default -1L;
    double multiplier() default -1.0;
}

