using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EKLabDev.Dfsm;

/// <summary>
/// Represents a state value in DFSM. Can be either an atomic string state or
/// a hierarchical/parallel compound dictionary mapping region/state names to child StateValues.
/// </summary>
[JsonConverter(typeof(StateValueJsonConverter))]
public sealed class StateValue : IEquatable<StateValue>
{
    public bool IsCompound { get; }
    public string? AtomicValue { get; }
    public IReadOnlyDictionary<string, StateValue>? CompoundValue { get; }

    private StateValue(string atomic)
    {
        IsCompound = false;
        AtomicValue = atomic ?? throw new ArgumentNullException(nameof(atomic));
        CompoundValue = null;
    }

    private StateValue(Dictionary<string, StateValue> compound)
    {
        IsCompound = true;
        AtomicValue = null;
        CompoundValue = new Dictionary<string, StateValue>(compound, StringComparer.Ordinal);
    }

    public static StateValue Of(string atomic) => new(atomic);

    public static StateValue Of(Dictionary<string, StateValue> compound) => new(compound);

    public static StateValue FromObject(object? obj)
    {
        if (obj == null) return Of("idle");
        if (obj is StateValue sv) return sv;
        if (obj is string s) return Of(s);
        if (obj is IDictionary<string, object> dict)
        {
            var compound = new Dictionary<string, StateValue>(StringComparer.Ordinal);
            foreach (var kvp in dict)
            {
                compound[kvp.Key] = FromObject(kvp.Value);
            }
            return Of(compound);
        }
        if (obj is JsonElement elem)
        {
            return FromJsonElement(elem);
        }
        return Of(obj.ToString() ?? "idle");
    }

    public static StateValue FromJsonElement(JsonElement elem)
    {
        if (elem.ValueKind == JsonValueKind.String)
        {
            return Of(elem.GetString()!);
        }
        if (elem.ValueKind == JsonValueKind.Object)
        {
            var dict = new Dictionary<string, StateValue>(StringComparer.Ordinal);
            foreach (var prop in elem.EnumerateObject())
            {
                dict[prop.Name] = FromJsonElement(prop.Value);
            }
            return Of(dict);
        }
        return Of(elem.ToString());
    }

    public bool Matches(StateValue other)
    {
        if (!IsCompound && !other.IsCompound)
        {
            return string.Equals(AtomicValue, other.AtomicValue, StringComparison.Ordinal);
        }
        if (IsCompound && other.IsCompound)
        {
            if (CompoundValue!.Count != other.CompoundValue!.Count) return false;
            foreach (var kvp in CompoundValue)
            {
                if (!other.CompoundValue.TryGetValue(kvp.Key, out var otherChild) || !kvp.Value.Matches(otherChild))
                {
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    public override bool Equals(object? obj) => obj is StateValue other && Equals(other);

    public bool Equals(StateValue? other)
    {
        if (other is null) return false;
        if (ReferenceEquals(this, other)) return true;
        return Matches(other);
    }

    public override int GetHashCode()
    {
        if (!IsCompound) return AtomicValue?.GetHashCode(StringComparison.Ordinal) ?? 0;
        int hash = 17;
        foreach (var kvp in CompoundValue!.OrderBy(k => k.Key, StringComparer.Ordinal))
        {
            hash = hash * 31 + kvp.Key.GetHashCode(StringComparison.Ordinal);
            hash = hash * 31 + kvp.Value.GetHashCode();
        }
        return hash;
    }

    public override string ToString()
    {
        if (!IsCompound) return AtomicValue!;
        return JsonSerializer.Serialize(this);
    }

    public static implicit operator StateValue(string atomic) => Of(atomic);
}

public class StateValueJsonConverter : JsonConverter<StateValue>
{
    public override StateValue Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        return StateValue.FromJsonElement(doc.RootElement);
    }

    public override void Write(Utf8JsonWriter writer, StateValue value, JsonSerializerOptions options)
    {
        if (!value.IsCompound)
        {
            writer.WriteStringValue(value.AtomicValue);
        }
        else
        {
            writer.WriteStartObject();
            foreach (var kvp in value.CompoundValue!)
            {
                writer.WritePropertyName(kvp.Key);
                Write(writer, kvp.Value, options);
            }
            writer.WriteEndObject();
        }
    }
}

