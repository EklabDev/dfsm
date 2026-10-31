package io.github.eklabdev.dfsm;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable XState-aligned state value representation:
 * either a simple leaf {@code String} (e.g. {@code "validating"}) or a nested
 * {@code Map<String, StateValue>} for compound and parallel states
 * (e.g. {@code {"processing": {"payment": "charging", "inventory": "reserving"}}}).
 */
public final class StateValue {
    private final String leaf;
    private final Map<String, StateValue> children;

    private StateValue(String leaf, Map<String, StateValue> children) {
        this.leaf = leaf;
        this.children = children;
    }

    public static StateValue of(String leaf) {
        Objects.requireNonNull(leaf, "leaf state name must not be null");
        return new StateValue(leaf, null);
    }

    public static StateValue ofMap(Map<String, StateValue> map) {
        Objects.requireNonNull(map, "state map must not be null");
        Map<String, StateValue> copy = new LinkedHashMap<>();
        for (Map.Entry<String, StateValue> e : map.entrySet()) {
            copy.put(e.getKey(), Objects.requireNonNull(e.getValue()));
        }
        return new StateValue(null, Collections.unmodifiableMap(copy));
    }

    public static StateValue ofSingleNested(String parent, StateValue child) {
        Map<String, StateValue> map = new LinkedHashMap<>();
        map.put(parent, child);
        return ofMap(map);
    }

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    @SuppressWarnings("unchecked")
    public static StateValue fromRaw(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof StateValue sv) {
            return sv;
        }
        if (raw instanceof String s) {
            return of(s);
        }
        if (raw instanceof Map<?, ?> m) {
            Map<String, StateValue> nested = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : m.entrySet()) {
                nested.put(String.valueOf(entry.getKey()), fromRaw(entry.getValue()));
            }
            return ofMap(nested);
        }
        throw new IllegalArgumentException("Unsupported StateValue representation: " + raw.getClass().getName());
    }

    @JsonValue
    public Object toRaw() {
        if (leaf != null) {
            return leaf;
        }
        Map<String, Object> raw = new LinkedHashMap<>();
        for (Map.Entry<String, StateValue> e : children.entrySet()) {
            raw.put(e.getKey(), e.getValue().toRaw());
        }
        return raw;
    }

    public boolean isLeaf() {
        return leaf != null;
    }

    public boolean isCompoundOrParallel() {
        return children != null;
    }

    public String asLeaf() {
        if (leaf == null) {
            throw new IllegalStateException("StateValue is a nested map, not a leaf: " + this);
        }
        return leaf;
    }

    public Map<String, StateValue> asMap() {
        if (children == null) {
            throw new IllegalStateException("StateValue is a leaf string, not a map: " + this);
        }
        return children;
    }

    public boolean matchesLeaf(String expected) {
        return leaf != null && leaf.equals(expected);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof StateValue that)) return false;
        return Objects.equals(leaf, that.leaf) && Objects.equals(children, that.children);
    }

    @Override
    public int hashCode() {
        return Objects.hash(leaf, children);
    }

    @Override
    public String toString() {
        if (leaf != null) {
            return leaf;
        }
        return JsonCodec.toJson(toRaw());
    }
}

