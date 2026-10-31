package io.github.eklabdev.dfsm.validation;

import io.github.eklabdev.dfsm.error.ValidationException;

import java.util.List;
import java.util.function.Consumer;
import java.util.function.Predicate;

/**
 * Code-first typed validator contract for {@code TContext} and {@code TInput}.
 * Works out of the box with Jakarta Bean Validation ({@link JakartaSchemaValidator})
 * or custom functional validators.
 */
@FunctionalInterface
public interface SchemaValidator<T> {
    T validate(String targetName, T candidate) throws ValidationException;

    static <T> SchemaValidator<T> jakarta() {
        return JakartaSchemaValidator.shared();
    }

    static <T> SchemaValidator<T> ofPredicate(Predicate<T> predicate, String errorMessage) {
        return (target, candidate) -> {
            if (candidate == null || !predicate.test(candidate)) {
                throw new ValidationException(target, List.of(errorMessage));
            }
            return candidate;
        };
    }

    static <T> SchemaValidator<T> ofConsumer(Consumer<T> verifier) {
        return (target, candidate) -> {
            try {
                verifier.accept(candidate);
                return candidate;
            } catch (ValidationException ve) {
                throw ve;
            } catch (RuntimeException ex) {
                throw new ValidationException(target, List.of(ex.getMessage() != null ? ex.getMessage() : ex.toString()));
            }
        };
    }

    static <T> T enforce(String targetName, T value, SchemaValidator<T> validator) {
        if (validator == null) {
            return value;
        }
        return validator.validate(targetName, value);
    }
}

