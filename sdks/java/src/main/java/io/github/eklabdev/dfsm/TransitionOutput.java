package io.github.eklabdev.dfsm;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Return value of a {@link TransitionFunction}: updated {@code TContext}, optional return {@code value},
 * optional dynamic post-commit {@code effects}, and optional dynamic {@code targetState} override.
 */
public record TransitionOutput<TContext, TOutput>(
        TContext context,
        TOutput value,
        List<String> effects,
        String targetState
) {
    public static <C, O> TransitionOutput<C, O> empty() {
        return new TransitionOutput<>(null, null, List.of(), null);
    }

    public static <C, O> TransitionOutput<C, O> ofContext(C context) {
        return new TransitionOutput<>(context, null, List.of(), null);
    }

    public static <C, O> TransitionOutput<C, O> ofValue(O value) {
        return new TransitionOutput<>(null, value, List.of(), null);
    }

    public static <C, O> TransitionOutput<C, O> of(C context, O value) {
        return new TransitionOutput<>(context, value, List.of(), null);
    }

    public TransitionOutput<TContext, TOutput> withEffects(String... effectNames) {
        List<String> merged = new ArrayList<>(this.effects != null ? this.effects : List.of());
        merged.addAll(Arrays.asList(effectNames));
        return new TransitionOutput<>(context, value, List.copyOf(merged), targetState);
    }

    public TransitionOutput<TContext, TOutput> withTargetState(String target) {
        return new TransitionOutput<>(context, value, effects, target);
    }
}

