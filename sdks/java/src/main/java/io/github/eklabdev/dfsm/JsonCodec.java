package io.github.eklabdev.dfsm;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

/**
 * Shared Jackson JSON &amp; YAML codec utilities for typed context hydration, deep cloning, and state persistence.
 */
public final class JsonCodec {
    private static final ObjectMapper JSON_MAPPER = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    private static final ObjectMapper YAML_MAPPER = new ObjectMapper(new YAMLFactory())
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    private JsonCodec() {}

    public static ObjectMapper jsonMapper() {
        return JSON_MAPPER;
    }

    public static ObjectMapper yamlMapper() {
        return YAML_MAPPER;
    }

    public static String toJson(Object value) {
        try {
            return JSON_MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize value to JSON", e);
        }
    }

    public static <T> T fromJson(String json, Class<T> clazz) {
        if (json == null) {
            return null;
        }
        try {
            if (clazz == Object.class) {
                @SuppressWarnings("unchecked")
                T res = (T) JSON_MAPPER.readValue(json, Object.class);
                return res;
            }
            return JSON_MAPPER.readValue(json, clazz);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to deserialize JSON into " + clazz.getName(), e);
        }
    }

    public static <T> T fromJson(String json, TypeReference<T> typeRef) {
        if (json == null) {
            return null;
        }
        try {
            return JSON_MAPPER.readValue(json, typeRef);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to deserialize JSON", e);
        }
    }

    public static <T> T convertValue(Object raw, Class<T> targetClass) {
        if (raw == null || targetClass == null || targetClass.isInstance(raw)) {
            @SuppressWarnings("unchecked")
            T cast = (T) raw;
            return cast;
        }
        return JSON_MAPPER.convertValue(raw, targetClass);
    }

    @SuppressWarnings("unchecked")
    public static <T> T deepClone(T value, Class<T> contextClass) {
        if (value == null) {
            return null;
        }
        try {
            byte[] bytes = JSON_MAPPER.writeValueAsBytes(value);
            Class<?> target = contextClass != null && contextClass != Object.class
                    ? contextClass
                    : value.getClass();
            return (T) JSON_MAPPER.readValue(bytes, target);
        } catch (Exception e) {
            return value;
        }
    }

    public static JsonNode parseYamlToTree(String yaml) throws JsonProcessingException {
        return YAML_MAPPER.readTree(yaml);
    }
}

