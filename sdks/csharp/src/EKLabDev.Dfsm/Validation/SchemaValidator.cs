using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;

namespace EKLabDev.Dfsm.Validation;

public interface ISchemaValidator
{
    void Validate<T>(T instance, string targetDescription);
}

public class DataAnnotationsSchemaValidator : ISchemaValidator
{
    public static readonly DataAnnotationsSchemaValidator Instance = new();

    public void Validate<T>(T instance, string targetDescription)
    {
        if (instance == null) return;

        var validationResults = new List<ValidationResult>();
        var visited = new HashSet<object>(ReferenceEqualityComparer.Instance);

        ValidateRecursive(instance, validationResults, visited, targetDescription);

        if (validationResults.Count > 0)
        {
            var errors = new List<string>();
            foreach (var result in validationResults)
            {
                var memberNames = result.MemberNames != null ? string.Join(", ", result.MemberNames) : string.Empty;
                var prefix = string.IsNullOrEmpty(memberNames) ? "" : $"[{memberNames}] ";
                errors.Add($"{prefix}{result.ErrorMessage}");
            }
            throw new ValidationException(
                $"Validation failed for {targetDescription}: {string.Join("; ", errors)}",
                errors
            );
        }
    }

    private void ValidateRecursive(object obj, List<ValidationResult> results, HashSet<object> visited, string path)
    {
        if (obj == null || !visited.Add(obj)) return;

        var type = obj.GetType();
        if (type.IsPrimitive || type.IsEnum || type == typeof(string) || type == typeof(decimal) || type == typeof(DateTime) || type == typeof(DateTimeOffset) || type == typeof(Guid))
        {
            return;
        }

        var context = new ValidationContext(obj);
        Validator.TryValidateObject(obj, context, results, validateAllProperties: true);

        if (obj is IEnumerable enumerable)
        {
            int index = 0;
            foreach (var item in enumerable)
            {
                if (item != null)
                {
                    ValidateRecursive(item, results, visited, $"{path}[{index}]");
                }
                index++;
            }
            return;
        }

        var properties = type.GetProperties();
        foreach (var prop in properties)
        {
            if (prop.GetIndexParameters().Length > 0) continue;
            var val = prop.GetValue(obj);
            if (val != null)
            {
                var valType = val.GetType();
                if (!valType.IsPrimitive && !valType.IsEnum && valType != typeof(string) && valType != typeof(decimal))
                {
                    ValidateRecursive(val, results, visited, $"{path}.{prop.Name}");
                }
            }
        }
    }
}

