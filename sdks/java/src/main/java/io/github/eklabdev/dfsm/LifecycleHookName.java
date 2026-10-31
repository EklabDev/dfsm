package io.github.eklabdev.dfsm;

public enum LifecycleHookName {
    ON_START("onStart"),
    BEFORE_TRANSITION("beforeTransition"),
    AFTER_TRANSITION("afterTransition"),
    ON_COMPENSATE("onCompensate"),
    ON_COMPLETE("onComplete"),
    ON_TERMINAL("onTerminal");

    private final String yamlKey;

    LifecycleHookName(String yamlKey) {
        this.yamlKey = yamlKey;
    }

    public String yamlKey() {
        return yamlKey;
    }

    public static LifecycleHookName fromYamlKey(String key) {
        for (LifecycleHookName h : values()) {
            if (h.yamlKey.equals(key) || h.name().equalsIgnoreCase(key)) {
                return h;
            }
        }
        throw new IllegalArgumentException("Unknown lifecycle hook slot: " + key);
    }
}

