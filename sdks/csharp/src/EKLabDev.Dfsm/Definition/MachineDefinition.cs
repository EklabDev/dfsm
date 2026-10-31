using System;
using System.Collections.Generic;
using EKLabDev.Dfsm.Policy;

namespace EKLabDev.Dfsm.Definition;

public sealed class MachineDefinition
{
    public string Id { get; set; } = string.Empty;
    public string Dfsm { get; set; } = "1.0";
    public string? Description { get; set; }
    public string? Type { get; set; }
    public string Initial { get; set; } = string.Empty;
    public int MaxEffectChainDepth { get; set; } = 25;
    public Dictionary<string, StateDefinition> States { get; set; } = new(StringComparer.Ordinal);
    public PartialTransitionPolicy? Defaults { get; set; }
    public List<string> Hooks { get; set; } = new();
    public List<string> Effects { get; set; } = new();

    public StateDefinition? FindState(string statePath)
    {
        if (string.IsNullOrEmpty(statePath)) return null;
        var parts = statePath.Split('.', StringSplitOptions.RemoveEmptyEntries);
        Dictionary<string, StateDefinition> current = States;
        StateDefinition? found = null;
        for (int i = 0; i < parts.Length; i++)
        {
            if (!current.TryGetValue(parts[i], out found))
            {
                return null;
            }
            if (i < parts.Length - 1)
            {
                current = found.States;
            }
        }
        return found;
    }
}

public sealed class StateDefinition
{
    public string Id { get; set; } = string.Empty;
    public string? Type { get; set; } // "atomic", "compound", "parallel", "final"
    public string? Initial { get; set; }
    public Dictionary<string, StateDefinition> States { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, List<TransitionDefinition>> On { get; set; } = new(StringComparer.Ordinal);
    public List<TransitionDefinition>? OnDone { get; set; }
    public List<string> Entry { get; set; } = new();
    public List<string> Exit { get; set; } = new();

    public bool IsCompound => string.Equals(Type, "compound", StringComparison.OrdinalIgnoreCase) || (States.Count > 0 && !IsParallel);
    public bool IsParallel => string.Equals(Type, "parallel", StringComparison.OrdinalIgnoreCase);
    public bool IsFinal => string.Equals(Type, "final", StringComparison.OrdinalIgnoreCase);
}

public sealed class TransitionDefinition
{
    public string Target { get; set; } = string.Empty;
    public string? Handler { get; set; }
    public PartialTransitionPolicy? Policy { get; set; }
}

