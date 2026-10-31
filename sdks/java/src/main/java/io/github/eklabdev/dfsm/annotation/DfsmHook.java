package io.github.eklabdev.dfsm.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a method as a DFSM Transaction Lifecycle Hook (`onStart`, `beforeTransition`,
 * `afterTransition`, `onCompensate`, `onComplete`, `onTerminal`) resolvable from YAML {@code hooks:}.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface DfsmHook {
    String value() default "";
}

