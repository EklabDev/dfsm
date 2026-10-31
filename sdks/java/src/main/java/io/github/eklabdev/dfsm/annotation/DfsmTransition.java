package io.github.eklabdev.dfsm.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface DfsmTransition {
    /**
     * Handler name registered in {@code FSMRegistry}. Defaults to the Java method name when empty.
     */
    String value() default "";

    /**
     * Optional explicit {@code TInput} class; automatically inferred from {@code TransitionRequest<TContext, TInput>}
     * generic parameter when left as {@code Void.class}.
     */
    Class<?> inputClass() default Void.class;

    /**
     * Automatically run Jakarta Bean Validation on {@code TInput} before transition execution.
     */
    boolean validateInput() default true;
}

