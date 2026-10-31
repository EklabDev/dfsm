package io.github.eklabdev.dfsm.validation;

import io.github.eklabdev.dfsm.error.ValidationException;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;

import java.util.List;
import java.util.Set;

/**
 * Built-in Jakarta Bean Validation 3.1 ({@code jakarta.validation.Validator}) adapter
 * for validating generic {@code TContext} and {@code TInput} Java classes/records.
 */
public final class JakartaSchemaValidator<T> implements SchemaValidator<T> {
    private static final Validator DEFAULT_VALIDATOR = createDefaultValidator();
    private static final JakartaSchemaValidator<Object> SHARED = new JakartaSchemaValidator<>(DEFAULT_VALIDATOR, false);

    private final Validator validator;
    private final boolean requireNonNull;

    public JakartaSchemaValidator() {
        this(DEFAULT_VALIDATOR, true);
    }

    public JakartaSchemaValidator(Validator validator, boolean requireNonNull) {
        this.validator = validator != null ? validator : DEFAULT_VALIDATOR;
        this.requireNonNull = requireNonNull;
    }

    @SuppressWarnings("unchecked")
    public static <T> JakartaSchemaValidator<T> shared() {
        return (JakartaSchemaValidator<T>) SHARED;
    }

    public static <T> JakartaSchemaValidator<T> required() {
        return new JakartaSchemaValidator<>(DEFAULT_VALIDATOR, true);
    }

    private static Validator createDefaultValidator() {
        ValidatorFactory factory = Validation.buildDefaultValidatorFactory();
        return factory.getValidator();
    }

    @Override
    public T validate(String targetName, T candidate) throws ValidationException {
        if (candidate == null) {
            if (requireNonNull) {
                throw new ValidationException(targetName, List.of("must not be null"));
            }
            return null;
        }
        // Primitive wrappers, Strings, or raw Maps without bean constraints pass cleanly
        if (candidate instanceof String || candidate instanceof Number || candidate instanceof Boolean) {
            return candidate;
        }
        Set<ConstraintViolation<T>> violations = validator.validate(candidate);
        if (!violations.isEmpty()) {
            List<String> messages = violations.stream()
                    .map(v -> v.getPropertyPath() + " " + v.getMessage())
                    .sorted()
                    .toList();
            throw new ValidationException(targetName, messages);
        }
        return candidate;
    }
}

